/**
 * retrieval/scope.ts — the SCOPE pipeline stage (Wave 3b, 2026-08-30,
 * reports/2026-08-30-pipe-w3-plan.md "`scope` semantics" section + STEP 3 of
 * reports/2026-08-30-pipe-w3b-migrate-report.md).
 *
 * Wave 2's `queryMemory()` shipped `scope` as an accepted-but-inert
 * passthrough parameter (see query-memory.ts's own prior header note) —
 * this file makes it REAL: a PER-CANDIDATE project-attribution filter, not a
 * whole-source on/off toggle (the W3 plan's own explicit framing).
 *
 * WHY THIS IS ITS OWN MODULE, not a function inside query-memory.ts: this
 * wave also migrates `tools-logic/recall-insight.ts::recallInsight` to apply
 * the SAME scope filter directly to its own raw `recallInsights()` output
 * (see that file). query-memory.ts already imports FROM tools-logic
 * (`parseSinceDate` from journal-search.ts) — if `applyScope` lived inside
 * query-memory.ts, recall-insight.ts importing it back would create a real
 * ESM import cycle (query-memory.ts -> recall-insight.ts -> query-memory.ts).
 * Both files importing this small, dependency-free module instead avoids
 * the cycle entirely and gives the scope stage a genuinely shared home,
 * matching its role as "the seam W4 (session_start) will consume" — a seam
 * is meant to be imported from more than one place.
 *
 * `applyScope` is intentionally generic over any item shape carrying a
 * `projects?: string[]` attribution field — `QueryMemoryItem` (this wave
 * adds the field for insight-tier items only, see query-memory.ts's
 * `scoreInsightTier`) and `IndexedInsight` (palace/insights-index.ts,
 * already carries `projects?: string[]` natively) both satisfy this
 * structurally, so recall-insight.ts can call the SAME function directly on
 * `recallInsights()`'s raw output without converting to `QueryMemoryItem`
 * first (which would lose fields — `applies_when`/`confirmed_count`/`file`
 * — `QueryMemoryItem` does not carry, and must not gain, to keep
 * `RecallInsightResult`'s external contract exact).
 */

/**
 * `scope: "project" | "global" | "all"` semantics (W3 plan, confirmed):
 *
 *  - `"all"` (or `undefined`) — keep everything. This is the DEFAULT and
 *    matches every pre-Wave-3b caller's behavior exactly (no surprise
 *    scoping) — "the default must preserve current behavior" (W3b brief).
 *  - `"project"` — keep only items whose `projects` list includes `project`.
 *    An item with no `projects` (or an empty one) is not attributable to
 *    any specific project, so it is EXCLUDED here — matching the existing
 *    precedent in `tools-logic/session-start.ts`'s own
 *    `(i.projects ?? []).includes(slug)` project-scoped-insight filter,
 *    not an invented convention.
 *  - `"global"` — the complement of `"project"`: keep only items with NO
 *    `projects` list (or an empty one) — genuinely unattributed/cross-
 *    cutting content. An item attributed to a DIFFERENT single project is
 *    neither `"project"` from this caller's point of view nor `"global"`
 *    (it is simply out of scope either way) — `"project"` and `"global"`
 *    are not a full partition of the universe, by design; `"all"` is the
 *    escape hatch for "give me everything regardless of attribution".
 *  - any other value — fail OPEN (return items unchanged) rather than
 *    silently dropping everything for a typo'd/unrecognized scope string.
 *
 * NOT a no-op for items that never populate `projects` under `"project"`/
 * `"global"` — such an item is treated as genuinely unattributed (excluded
 * under `"project"`, included under `"global"`). This matters: journal and
 * palace-room `QueryMemoryItem`s never set `projects` at all (they are
 * inherently per-slug — `readTierCandidates(tier, project, ...)` only ever
 * reads `project`'s own tree, so every candidate trivially IS that
 * project's), so calling `applyScope` on THEM under `scope:"project"` would
 * WRONGLY exclude every one of them (treating "never attributed because
 * trivially single-project" as "unattributed because genuinely global" —
 * two different facts this function cannot distinguish from the field
 * alone). The correct no-op for those tiers is achieved by the CALLER never
 * invoking this function for them in the first place — see
 * query-memory.ts's `SCOPE_ATTRIBUTED_TIERS` short-circuit, which is the
 * actual place "NO-OP on journal/palace-room tiers" (W3b brief) is
 * enforced, not any leniency inside this function.
 */
export function applyScope<T extends { projects?: string[] }>(
  items: T[],
  project: string,
  scope: string | undefined,
): T[] {
  if (!scope || scope === "all") return items;
  if (scope === "project") {
    // No project to scope to (unresolved/empty slug) — fail OPEN, same
    // principle as the unknown-scope branch below: never surprise-drop
    // everything. Without this, `includes("")` matches nothing and a
    // caller that passed scope:"project" but forgot `project` silently gets
    // zero results (W3b independent review, LOW). W4/session_start consumes
    // this seam, so the footgun must not ship.
    if (!project) return items;
    return items.filter((it) => (it.projects?.length ?? 0) > 0 && it.projects!.includes(project));
  }
  if (scope === "global") {
    return items.filter((it) => (it.projects?.length ?? 0) === 0);
  }
  return items; // unknown scope value — fail open, never surprise-drop everything
}
