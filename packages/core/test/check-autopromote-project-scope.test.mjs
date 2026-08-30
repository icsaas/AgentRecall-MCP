// packages/core/test/check-autopromote-project-scope.test.mjs
//
// W4 (2026-08-30, wave/pipe-w4-session) — STEP 2 payoff regression.
//
// ROOT CAUSE (recon-localized, tools-logic/check.ts's Phase-5 auto-promote
// loop): the `awarenessUpdate({...})` call made when a correction pattern
// hits frequency >= 3 omitted BOTH `project` (top-level) and
// `source_project` (per-insight). `awarenessUpdate` derives
// `IndexedInsight.projects` from the TOP-LEVEL `project` field only
// (tools-logic/awareness-update.ts's `addIndexedInsight` call:
// `projects: input.project ? [input.project] : undefined`) — so every
// insight auto-promoted by check() got `projects: undefined` FOREVER, and
// could never match session-start.ts's own project-scoped insight filter
// (`(i.projects ?? []).includes(slug)`, the PROJECT_INSIGHT_BUDGET block,
// session-start.ts:439-474) — that block existed and was reachable, but had
// a permanently-empty input for every insight check() ever produced.
//
// THIS TEST proves the fix end-to-end: 3 identical `human_correction` calls
// to `check()` push a pattern past the auto-promote threshold
// (extractWatchPatterns' frequency >= 3 gate), the resulting IndexedInsight
// now carries `projects: [project]`, and `sessionStart()` surfaces it in its
// project-scoped `insights` slot (confirmed: 1 — below the global
// awareness topInsights promotion threshold of 3, so this slot is the ONLY
// place a first-confirmation insight can appear at all; see session-start.ts's
// own "P0-3" comment). Pre-fix, this assertion fails (`insights` would not
// contain the auto-promoted title at all, since `projects` was always
// undefined).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { check } from "../dist/tools-logic/check.js";
import { sessionStart } from "../dist/tools-logic/session-start.js";
import { readInsightsIndex } from "../dist/palace/insights-index.js";

let testRoot;

describe("check() auto-promote → session_start project-scoped insight slot", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-check-promote-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("an insight auto-promoted by check() carries projects:[slug] and surfaces via session_start", async () => {
    const PROJECT = "check-promote-scope-proj";
    // >=5 meaningful words + an action-signal word ("verify") — clears
    // check.ts's own auto-promote quality gate (hasActionSignal/words.length).
    const CORRECTION = "Always verify the deployment checklist before shipping";

    // Drive the SAME correction through check() 3 times — extractWatchPatterns
    // groups by a 2-keyword extraction of the correction text, so 3 identical
    // calls produce ONE pattern with frequency === 3, crossing check()'s own
    // `w.frequency >= 3` auto-promote threshold on the 3rd call.
    let lastResult;
    for (let i = 0; i < 3; i++) {
      lastResult = await check({
        goal: `ship feature batch ${i}`,
        confidence: "high",
        human_correction: CORRECTION,
        project: PROJECT,
      });
    }

    assert.ok(
      lastResult.auto_promoted && lastResult.auto_promoted >= 1,
      `precondition: the 3rd identical correction must trigger auto-promotion, got auto_promoted=${lastResult.auto_promoted}`,
    );

    // Direct index check: the fix's own claim — projects must be populated,
    // not undefined.
    const index = readInsightsIndex();
    const promoted = index.insights.find((ins) => ins.title.startsWith("Human preference: Always verify"));
    assert.ok(promoted, "the auto-promoted insight must exist in the insights index");
    assert.deepEqual(
      promoted.projects,
      [PROJECT],
      "the auto-promoted IndexedInsight must carry projects:[PROJECT] (root-cause fix: awarenessUpdate now receives `project` top-level)",
    );

    // End-to-end payoff: session_start's project-scoped insight slot
    // (PROJECT_INSIGHT_BUDGET, session-start.ts:439-474) must surface it —
    // this is the actual behavior an agent observes, not just the index's
    // internal shape.
    const result = await sessionStart({ project: PROJECT });
    const surfaced = result.insights.find((ins) => ins.title.startsWith("Human preference: Always verify"));
    assert.ok(
      surfaced,
      `session_start must surface the project-scoped auto-promoted insight; got insights=${JSON.stringify(result.insights)}`,
    );
    assert.equal(surfaced.confirmed, 1, "a single auto-promotion confirms once");
  });
});
