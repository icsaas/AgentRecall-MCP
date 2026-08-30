import { recallInsights, readInsightsIndex } from "../palace/insights-index.js";
import { readAwareness } from "../palace/awareness.js";
import { applyScope } from "../retrieval/scope.js";

export interface RecallInsightInput {
  context: string;
  limit?: number;
  include_awareness?: boolean;
  /**
   * Already-resolved project slug (Wave 3b, 2026-08-30,
   * reports/2026-08-30-pipe-w3b-migrate-report.md STEP 2). Threads into
   * `recallInsights()`'s own project-correlation boost (Layer 3,
   * palace/insights-index.ts) — a real, if latent, gap this surface has
   * always had: `tools-logic/session-start.ts`'s own
   * `recallInsights(context, 1, slug)` call gets this boost, but this
   * function's identically-shaped call never passed a project at all.
   * Optional/omittable — every existing caller that omits it gets EXACTLY
   * today's behavior (`recallInsights()`'s own `currentProject` parameter
   * is itself optional and no-ops when absent).
   */
  project?: string;
  /** SCOPE stage (Wave 3b, retrieval/scope.ts's `applyScope`) — filters
   *  `matching_insights` by `IndexedInsight.projects` attribution.
   *  Omitted/undefined preserves today's behavior exactly (no filtering) —
   *  see applyScope's own doc comment for "project"/"global"/"all"
   *  semantics. Has no effect on the freeform `awareness` markdown blob
   *  (that content is not itemized, so there is nothing to filter). */
  scope?: string;
}

export interface RecallInsightResult {
  context: string;
  matching_insights: Array<{
    title: string;
    relevance: number;
    severity: string;
    applies_when: string[];
    confirmed: number;
    file: string | null;
  }>;
  total_in_index: number;
  awareness: string | null;
}

export async function recallInsight(input: RecallInsightInput): Promise<RecallInsightResult> {
  const limit = input.limit ?? 5;
  // Fetch an UNBOUNDED-by-limit candidate pool when scope filtering is
  // requested, so the scope filter runs BEFORE the final truncation, never
  // after — a filter-after-limit ordering would silently return fewer than
  // `limit` items even when enough project-scoped matches exist beyond the
  // pre-scope cutoff `recallInsights()` would otherwise apply internally.
  // When no scope is requested (the default), this is exactly
  // `recallInsights(context, limit, project)` — today's call, unchanged
  // shape (only `project` is new, see RecallInsightInput's own doc comment).
  const fetchLimit = input.scope && input.scope !== "all" ? Number.MAX_SAFE_INTEGER : limit;
  const scoped = applyScope(recallInsights(input.context, fetchLimit, input.project), input.project ?? "", input.scope);
  const insights = scoped.slice(0, limit);

  let awareness: string | null = null;
  if (input.include_awareness !== false) {
    const raw = readAwareness();
    if (raw) {
      awareness = raw.split("\n").slice(0, 200).join("\n");
    }
  }

  return {
    context: input.context,
    matching_insights: insights.map((i) => ({
      title: i.title,
      relevance: Math.round(i.relevance * 100) / 100,
      severity: i.severity,
      applies_when: i.applies_when,
      confirmed: i.confirmed_count,
      file: i.file ?? null,
    })),
    total_in_index: readInsightsIndex().insights.length,
    awareness,
  };
}
