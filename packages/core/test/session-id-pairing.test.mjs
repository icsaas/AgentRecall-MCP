/**
 * session-id-pairing.test.mjs — Wave 0 measurement fix (2026-08-29).
 *
 * Bug: storage/session.ts's `getSessionId()` returned a per-process random id
 * (`crypto.randomBytes(3)` evaluated once at module-import time). Claude
 * Code's SessionStart and Stop hooks each fire `ar hook-start` / `ar
 * hook-end` as a SEPARATE CLI subprocess, so session_start and session_end
 * lifecycle telemetry / outcome events for the SAME real user session were
 * stamped with two DIFFERENT random ids and could never be paired.
 *
 * Fix: `getSessionId()` now prefers `process.env["CLAUDE_CODE_SESSION_ID"]`
 * (the REAL session id Claude Code sets in every subprocess it spawns —
 * confirmed live on this machine via reports/2026-08-12-trainc-fix-report.md's
 * env probe: CLAUDE_CODE_SESSION_ID was observed set alongside CLAUDECODE=1
 * and other CLAUDE_CODE_* vars on a real running Claude Code + MCP-server
 * process pair) when present, falling back to the per-process random id
 * otherwise (non-hook hosts: Codex, raw MCP, SDK, CLI).
 *
 * This test spawns REAL separate `node` child processes (not just two calls
 * within one test process) — that is the only way to actually reproduce the
 * "separate subprocess" bug the fix addresses; two in-process calls to
 * getSessionId() would trivially return the same cached value even under the
 * OLD buggy code, since the random id was cached at module-import time within
 * ONE process. Mirrors the spawn-child-process pattern already established in
 * audit-outcome-concurrency.test.mjs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "storage", "session.js"),
).href;

/** Spawn one child `node` process that imports session.js and prints getSessionId() to stdout. */
function spawnGetSessionId(env) {
  return new Promise((resolve, reject) => {
    const code = `
(async () => {
  const { getSessionId } = await import(${JSON.stringify(SESSION_DIST_URL)});
  process.stdout.write(getSessionId());
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
`;
    const child = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
      resolve(stdout.trim());
    });
  });
}

describe("session.ts getSessionId() — cross-subprocess pairing (Wave 0 measurement fix)", () => {
  it("with CLAUDE_CODE_SESSION_ID set, two SEPARATE subprocesses return the SAME id (simulates SessionStart + Stop hooks)", async () => {
    const REAL_ID = "4c113109-5a4a-4f7b-b0b1-3ef798ba1c6b"; // shape of a real observed Claude Code session id
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: REAL_ID };
    delete env.AR_HOST; // AR_HOST is irrelevant to getSessionId(); keep it out to avoid cross-signal confusion

    const [idFromHookStart, idFromHookEnd] = await Promise.all([
      spawnGetSessionId(env),
      spawnGetSessionId(env),
    ]);

    assert.equal(idFromHookStart, REAL_ID, "getSessionId() must return the real CLAUDE_CODE_SESSION_ID verbatim");
    assert.equal(idFromHookEnd, REAL_ID, "getSessionId() must return the real CLAUDE_CODE_SESSION_ID verbatim");
    assert.equal(
      idFromHookStart,
      idFromHookEnd,
      "session_start and session_end subprocesses must now pair on the SAME session id",
    );
  });

  it("without CLAUDE_CODE_SESSION_ID, two separate subprocesses still return DIFFERENT (unique) ids — unchanged fallback behavior for non-hook hosts", async () => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.AR_HOST;

    const [idA, idB] = await Promise.all([spawnGetSessionId(env), spawnGetSessionId(env)]);

    assert.match(idA, /^[0-9a-f]{6}$/, "fallback id must be the 6-char hex random id");
    assert.match(idB, /^[0-9a-f]{6}$/, "fallback id must be the 6-char hex random id");
    assert.notEqual(idA, idB, "two separate subprocesses with no real session id must still get DIFFERENT random ids");
  });

  it("an empty-string CLAUDE_CODE_SESSION_ID is treated as absent (falls back to random, never returns an empty id)", async () => {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "" };
    delete env.AR_HOST;

    const id = await spawnGetSessionId(env);
    assert.notEqual(id, "", "an empty env value must not be returned verbatim as the session id");
    assert.match(id, /^[0-9a-f]{6}$/, "must fall back to the random hex id");
  });
});
