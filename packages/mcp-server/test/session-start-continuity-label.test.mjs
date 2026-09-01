/**
 * Fable option 2 (label-not-scope, 2026-08-30, wave/pipe-w4b-continuity-
 * label) — "⏪ Continuity" terse render must visibly mark a cross-project
 * entry as distinct from a current-project one, and frame the WHOLE block
 * as orientation when every surfaced entry is cross-project. Sibling to
 * session-start-continuity.test.mjs (left untouched by this wave) so the
 * shipped rendering acceptance criteria (header presence/placement,
 * `[slug]`/`ago`/`next:` substrings) stay byte-identical.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTerse } from "../dist/tools/session-start.js";

function baseResult(overrides = {}) {
  return {
    project: "current-proj",
    identity: "",
    insights: [],
    active_rooms: [],
    cross_project: [],
    recent: { today: null, yesterday: null, older_count: 0 },
    recent_captures: [],
    watch_for: [],
    corrections: [],
    resume: null,
    behavior_rules: [],
    dream_health: null,
    store_doctor: null,
    pipeline: null,
    alignment: null,
    blind_spots: [],
    recognition: { who: { name: "unknown", role: null, owner: null, unknown: true }, can_do: { skills: [], permissions: [] }, project: { slug: "current-proj", last_journal_date: null, status: "empty", trajectory: null, rooms: [] } },
    ...overrides,
  };
}

describe("mcp-server session_start terse render — continuity label (Fable option 2)", () => {
  it("(c) marks a cross-project entry distinctly from a current-project entry in the SAME render", () => {
    const text = formatTerse(baseResult({
      continuity: [
        { ago: "1m ago", slug: "current-proj", title: "my own recent work", is_current_project: true },
        { ago: "5m ago", slug: "novada-mcp", title: "MCP page redesign spec locked", is_current_project: false },
      ],
    }));

    const lines = text.split("\n");
    const ownLine = lines.find((l) => l.includes("my own recent work"));
    const otherLine = lines.find((l) => l.includes("MCP page redesign spec locked"));
    assert.ok(ownLine, "current-project line must render");
    assert.ok(otherLine, "cross-project line must render");

    // Distinct: the cross-project line carries the "↪ " marker, the
    // current-project line does not — and the two lines must actually
    // differ in their marker treatment (not just both happening to lack it).
    assert.ok(otherLine.includes("↪"), `cross-project entry must carry a distinct marker; line=${otherLine}`);
    assert.ok(!ownLine.includes("↪"), `current-project entry must NOT carry the cross-project marker; line=${ownLine}`);

    // Untouched substrings from the shipped contract still present.
    assert.ok(otherLine.includes("[novada-mcp]"));
    assert.ok(otherLine.includes("5m ago"));
  });

  it("frames the header as orientation-only when EVERY surfaced entry is cross-project", () => {
    const text = formatTerse(baseResult({
      continuity: [
        { ago: "1m ago", slug: "elsewhere-a", title: "a", is_current_project: false },
        { ago: "2m ago", slug: "elsewhere-b", title: "b", is_current_project: false },
      ],
      continuity_all_cross_project: true,
    }));
    assert.ok(text.includes("⏪ Continuity"), "header substring must still be present (shipped contract)");
    assert.ok(/orientation/i.test(text), "header must frame the block as orientation when nothing matches the current project");
  });

  it("keeps the original neutral header when at least one entry matches the current project", () => {
    const text = formatTerse(baseResult({
      continuity: [
        { ago: "1m ago", slug: "current-proj", title: "own work", is_current_project: true },
        { ago: "2m ago", slug: "elsewhere", title: "other work", is_current_project: false },
      ],
      continuity_all_cross_project: false,
    }));
    assert.ok(text.includes("⏪ Continuity"));
    assert.ok(!/orientation/i.test(text), "must not falsely frame a mixed block as pure orientation");
  });

  it("backward-compat: an entry with NO is_current_project field (pre-label fixture) still renders without crashing and derives the marker from slug vs project", () => {
    // Mirrors session-start-continuity.test.mjs's own hand-built fixtures,
    // which predate this field entirely.
    const text = formatTerse(baseResult({
      continuity: [
        { ago: "5m ago", slug: "novada-mcp", title: "MCP page redesign spec locked", next_step: "implement app/mcp/page.tsx wizard" },
        { ago: "2h ago", slug: "AgentRecall", title: "continuity wave design doc written" },
      ],
    }));
    assert.ok(text.includes("⏪ Continuity"));
    assert.ok(text.includes("[novada-mcp]"));
    assert.ok(text.includes("MCP page redesign spec locked"));
    assert.ok(text.includes("next: implement app/mcp/page.tsx wizard"));
    // project is "current-proj" and neither entry's slug matches it, so both
    // should derive as cross-project via the fallback slug comparison.
    // Scope to actual continuity ROW lines ("  - ...") — the per-project
    // header line further down literally contains the substring
    // "AgentRecall" too and must not be counted here.
    const lines = text.split("\n").filter((l) => l.startsWith("  - ") && (l.includes("novada-mcp") || l.includes("AgentRecall")));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.includes("↪")), "fallback derivation must still mark both as cross-project");
  });
});
