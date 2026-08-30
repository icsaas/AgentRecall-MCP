// packages/core/test/handoff.test.mjs
//
// P0 independent-review FIX 2 (2026-08-30, wave/pipe-p0-trustclass):
// helpers/handoff.ts::generateHandoff has SCANNER coverage (identity-trust-
// completeness.test.mjs's ALLOWLIST/Part-B machinery already verifies it
// routes through readTierCandidates — a trusted wrapper) but had NO
// behavioral (destination-proof) test of its own before this fix. Given
// handoff.md's entire purpose is "paste this into a fresh agent" (the exact
// artifact the red-team report's CRITICAL-1 finding named as a proven
// exploit path), a regression here is high-consequence and deserves its own
// real-fixture test, independent of the generic scanner.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-handoff-fix2-" + Date.now());

describe("P0 review-fix (FIX 2) — generateHandoff never surfaces a rescue-tagged latest entry's Blockers/Trajectory", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("agent-recall-core");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  const SLUG = "handoff-fix2-project";
  const HIJACK_BLOCKER = "HIJACKED_HANDOFF_BLOCKER_UNIQUE_TERM";
  const HIJACK_NEXT = "HIJACKED_HANDOFF_NEXT_UNIQUE_TERM";
  const GENUINE_BLOCKER = "GENUINE_HANDOFF_BLOCKER_UNIQUE_TERM";
  const GENUINE_NEXT = "GENUINE_HANDOFF_NEXT_UNIQUE_TERM";

  function writeCard(sid, date, source, blockerText, nextText) {
    const dir = path.join(TEST_ROOT, "projects", SLUG, "journal");
    fs.mkdirSync(dir, { recursive: true });
    const body = [
      "---",
      `sid: ${sid}`,
      `date: ${date}`,
      `slug: ${SLUG}`,
      `source: ${source}`,
      "---",
      "",
      `# session ${sid}`,
      "",
      "## Blockers",
      blockerText,
      "",
      "## Next",
      `- ${nextText}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, `${date}--card--${sid}.md`), body, "utf-8");
  }

  it("a rescue-tagged LATEST entry's fabricated Blockers/Next never reach the rendered handoff", () => {
    // Older, genuine entry — must be the one that surfaces (the fallback
    // once the newer rescue-tagged entry is quarantined by readTierCandidates).
    const past = (Date.now() - 5 * 24 * 60 * 60 * 1000);
    const olderDate = new Date(past).toISOString().slice(0, 10);
    writeCard("genuine-older", olderDate, "hook-end", GENUINE_BLOCKER, GENUINE_NEXT);

    // Newer, rescue-tagged entry — the attacker's hijacked card, claiming
    // the most recent date so it would win "latest" if not for the trust
    // filter readTierCandidates applies.
    const today = new Date().toISOString().slice(0, 10);
    writeCard("hijack-newer", today, "working-memory-rescue", HIJACK_BLOCKER, HIJACK_NEXT);

    const rendered = core.generateHandoff(SLUG);

    assert.ok(!rendered.includes(HIJACK_BLOCKER), `generateHandoff must never surface a rescue-tagged entry's Blockers text; got:\n${rendered}`);
    assert.ok(!rendered.includes(HIJACK_NEXT), `generateHandoff must never surface a rescue-tagged entry's Next/Trajectory text; got:\n${rendered}`);

    // Fallback: the genuine (older) entry's content must surface instead —
    // readTierCandidates drops the rescue-tagged candidate entirely, so the
    // genuine entry becomes candidates[0] (the "latest" trusted entry).
    assert.ok(rendered.includes(GENUINE_BLOCKER), `generateHandoff must fall back to the genuine sibling entry's Blockers text; got:\n${rendered}`);
    assert.ok(rendered.includes(GENUINE_NEXT), `generateHandoff must fall back to the genuine sibling entry's Next/Trajectory text; got:\n${rendered}`);
  });

  it("when the ONLY journal entry is rescue-tagged, generateHandoff omits the Blockers/Trajectory sections entirely rather than fabricating content", () => {
    const today = new Date().toISOString().slice(0, 10);
    writeCard("hijack-solo", today, "working-memory-rescue", HIJACK_BLOCKER, HIJACK_NEXT);

    const rendered = core.generateHandoff(SLUG);
    assert.ok(!rendered.includes(HIJACK_BLOCKER), `generateHandoff must never surface a rescue-tagged entry's content even when it is the ONLY entry; got:\n${rendered}`);
    assert.ok(!rendered.includes(HIJACK_NEXT), `generateHandoff must never surface a rescue-tagged entry's content even when it is the ONLY entry; got:\n${rendered}`);
    assert.ok(!rendered.includes("## Active blockers"), "with zero trusted candidates, the Active blockers section must be omitted (empty sections are omitted, per this file's own contract), not fabricated");
    assert.ok(!rendered.includes("## Trajectory"), "with zero trusted candidates, the Trajectory section must be omitted, not fabricated");
  });
});
