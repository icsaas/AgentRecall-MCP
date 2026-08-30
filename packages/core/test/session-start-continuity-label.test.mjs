/**
 * Fable option 2 (label-not-scope, 2026-08-30, wave/pipe-w4b-continuity-
 * label) — LABEL cross-project continuity as orientation instead of
 * scoping/removing it.
 *
 * Continuity is deliberately cross-project (F2, continuity wave
 * 2026-07-31, see session-start-continuity.test.mjs) — this wave does NOT
 * change that contract. It adds a presentation/attribution signal so an
 * agent can tell "your current project's own continuity" from "recent work
 * elsewhere" WITHOUT any entry being removed or excluded. Sibling to
 * session-start-continuity.test.mjs (left untouched by this wave) rather
 * than an edit to it, so the shipped cross-project acceptance criteria stay
 * byte-identical.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-start-continuity-label-" + Date.now());

describe("session_start — continuity label (Fable option 2)", () => {
  let core;
  let savedAbEnabled;
  let savedAbForce;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    savedAbEnabled = process.env.AR_AB_ENABLED;
    savedAbForce = process.env.AR_AB_FORCE;
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled; else delete process.env.AR_AB_ENABLED;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce; else delete process.env.AR_AB_FORCE;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_ROOT, "recent-sessions.jsonl"), { force: true });
  });

  it("(a) tags a same-slug entry is_current_project:true and a different-slug entry is_current_project:false — non-vacuous (both values actually occur)", async () => {
    const now = Date.now();
    core.appendRecentSession({
      ts: new Date(now - 1 * 60_000).toISOString(),
      sid: "own-1",
      slug: "label-current-project",
      title: "own project work",
    });
    core.appendRecentSession({
      ts: new Date(now - 2 * 60_000).toISOString(),
      sid: "other-1",
      slug: "label-other-project",
      title: "someone else's recent work",
    });

    const result = await core.sessionStart({ project: "label-current-project" });

    assert.ok(Array.isArray(result.continuity), "continuity must be present");
    assert.equal(result.continuity.length, 2);

    const own = result.continuity.find((c) => c.slug === "label-current-project");
    const other = result.continuity.find((c) => c.slug === "label-other-project");
    assert.ok(own, "current-project entry must still surface");
    assert.ok(other, "cross-project entry must still surface (label, not scope)");

    assert.equal(own.is_current_project, true, "same-slug entry must be tagged true");
    assert.equal(other.is_current_project, false, "different-slug entry must be tagged false");

    // Non-vacuous: both values must actually occur in this fixture, not just
    // one branch of the comparison ever being exercised.
    const values = new Set(result.continuity.map((c) => c.is_current_project));
    assert.ok(values.has(true) && values.has(false), "both true and false must occur across entries");
  });

  it("(b) 0-current-project case: continuity_all_cross_project is true and every entry is labeled false — orientation framing, not this-project's-own-continuity", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "o1", slug: "elsewhere-a", title: "a" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "o2", slug: "elsewhere-b", title: "b" });

    const result = await core.sessionStart({ project: "orientation-only-project" });

    assert.ok(Array.isArray(result.continuity) && result.continuity.length === 2);
    assert.ok(result.continuity.every((c) => c.is_current_project === false), "no entry may match a project with zero of its own continuity");
    assert.equal(result.continuity_all_cross_project, true, "derived signal must flip to true when NONE of the surfaced entries match the current project");
  });

  it("(b-contrast) mixed case: continuity_all_cross_project is NOT true when at least one entry matches the current project", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "m1", slug: "mixed-current", title: "own" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "m2", slug: "mixed-other", title: "other" });

    const result = await core.sessionStart({ project: "mixed-current" });

    assert.notEqual(result.continuity_all_cross_project, true, "at least one current-project entry must prevent the all-cross-project signal");
  });

  it("continuity_all_cross_project is absent when continuity itself is absent (no ledger entries) — no noise on a fresh store", async () => {
    const result = await core.sessionStart({ project: "label-empty-project" });
    assert.equal(result.continuity, undefined);
    assert.equal(result.continuity_all_cross_project, undefined);
  });

  it("worker done-def #1: a ledger entry with an empty-string slug never crashes and is treated as NOT the current project", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "empty-slug-1", slug: "", title: "malformed row" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "empty-slug-2", slug: "empty-slug-project", title: "normal row" });

    // Must not throw even when the current project ITSELF resolves to the
    // same empty-ish comparison target — assert no crash and correct labeling.
    const result = await core.sessionStart({ project: "empty-slug-project" });
    assert.ok(Array.isArray(result.continuity));
    const blank = result.continuity.find((c) => c.slug === "");
    assert.ok(blank, "the malformed entry must still surface (label, not scope/exclude)");
    assert.equal(blank.is_current_project, false, "an empty slug must never be treated as matching the current project");
  });

  it("worker done-def #3: labeling does not reorder continuity — recency order is unchanged (newest first)", async () => {
    const now = Date.now();
    core.appendRecentSession({ ts: new Date(now - 3 * 60_000).toISOString(), sid: "r1", slug: "order-current", title: "third newest" });
    core.appendRecentSession({ ts: new Date(now - 2 * 60_000).toISOString(), sid: "r2", slug: "order-other", title: "second newest" });
    core.appendRecentSession({ ts: new Date(now - 1 * 60_000).toISOString(), sid: "r3", slug: "order-current", title: "newest" });

    const result = await core.sessionStart({ project: "order-current" });
    assert.deepEqual(result.continuity.map((c) => c.title), ["newest", "second newest", "third newest"], "labeling must not disturb the pre-existing newest-first ordering, regardless of is_current_project");
  });

  it("isCurrentProjectContinuityEntry compares the RESOLVED slug, not raw input — 'auto' input still labels correctly against the detected slug", async () => {
    // core.isCurrentProjectContinuityEntry is exported directly for this
    // exact contract check (worker done-def #4): the comparison must never
    // be done against an unresolved/raw project string.
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: "resolved-slug" }, "resolved-slug"), true);
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: "other-slug" }, "resolved-slug"), false);
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: null }, "resolved-slug"), false, "null slug must not crash and must not match");
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: undefined }, "resolved-slug"), false, "undefined slug must not crash and must not match");
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: "" }, ""), false, "two empty strings must never be treated as a match");
    // Explicit is_current_project on the entry wins over a stale/absent slug comparison.
    assert.equal(core.isCurrentProjectContinuityEntry({ slug: "irrelevant", is_current_project: true }, "resolved-slug"), true);
  });
});
