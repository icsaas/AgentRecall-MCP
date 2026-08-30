// packages/core/test/scope.test.mjs — Wave 3b (2026-08-30,
// reports/2026-08-30-pipe-w3b-migrate-report.md STEP 3).
//
// Direct unit coverage of retrieval/scope.ts's `applyScope`, isolated from
// any real consumer (recall-insight-scope.test.mjs proves the same
// semantics through recallInsight()/queryMemory() as REAL consumers — this
// file pins the exact filter predicate itself, including the two edge
// cases a real-consumer test would only exercise indirectly: an item
// attributed to a THIRD project that is neither the caller's project nor
// unattributed, and an unrecognized `scope` string failing open).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyScope } from "../dist/index.js";

describe("retrieval/scope.ts — applyScope()", () => {
  const items = [
    { id: "a", projects: ["proj-a"] },
    { id: "b", projects: ["proj-b"] },
    { id: "ab", projects: ["proj-a", "proj-b"] },
    { id: "global-undefined" }, // projects field entirely absent
    { id: "global-empty", projects: [] },
  ];

  it('scope undefined (and scope:"all") returns every item unchanged, in the same order', () => {
    assert.deepEqual(applyScope(items, "proj-a", undefined).map((i) => i.id), ["a", "b", "ab", "global-undefined", "global-empty"]);
    assert.deepEqual(applyScope(items, "proj-a", "all").map((i) => i.id), ["a", "b", "ab", "global-undefined", "global-empty"]);
  });

  it('scope:"project" keeps only items whose `projects` includes the given project — including a multi-project item', () => {
    assert.deepEqual(applyScope(items, "proj-a", "project").map((i) => i.id), ["a", "ab"]);
    assert.deepEqual(applyScope(items, "proj-b", "project").map((i) => i.id), ["b", "ab"]);
  });

  it('scope:"project" for a project attributed to NEITHER item excludes everything, including the unattributed ones', () => {
    assert.deepEqual(applyScope(items, "proj-c", "project").map((i) => i.id), []);
  });

  it('scope:"global" keeps only genuinely unattributed items (missing OR empty `projects`) — never a project-specific one, even the caller\'s own', () => {
    assert.deepEqual(applyScope(items, "proj-a", "global").map((i) => i.id), ["global-undefined", "global-empty"]);
  });

  it("an unrecognized scope string fails OPEN (returns everything unchanged) rather than silently dropping everything for a typo", () => {
    assert.deepEqual(applyScope(items, "proj-a", "not-a-real-scope-value").map((i) => i.id), ["a", "b", "ab", "global-undefined", "global-empty"]);
  });

  it("scope:'project' with an empty/unresolved project fails OPEN, never silently returns nothing (W3b review LOW; W4 consumes this seam)", () => {
    // Without the guard, includes("") matches no item and the caller gets [].
    assert.deepEqual(applyScope(items, "", "project").map((i) => i.id), ["a", "b", "ab", "global-undefined", "global-empty"]);
  });

  it("an empty items array never throws for any scope value", () => {
    for (const scope of [undefined, "all", "project", "global", "bogus"]) {
      assert.deepEqual(applyScope([], "proj-a", scope), []);
    }
  });
});
