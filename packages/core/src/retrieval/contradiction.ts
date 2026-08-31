/**
 * retrieval/contradiction.ts — the CONTRADICTION pipeline stage (Wave 5a,
 * 2026-08-31, reports/2026-08-31-pipe-w5a-contradiction-report.md).
 *
 * WHY THIS IS ITS OWN MODULE, not a function inside query-memory.ts: mirrors
 * `retrieval/scope.ts`'s own precedent — a small, dependency-light, pure
 * comparator that query-memory.ts (this wave) consumes, and that a later
 * wave's caller (e.g. a future `recallInsight()`-style direct consumer) can
 * import without creating an import cycle back into query-memory.ts (which
 * already imports FROM tools-logic — see scope.ts's header for the exact
 * cycle this pattern avoids).
 *
 * WHAT THIS DOES NOT DO (scope, read the eval fixtures before extending):
 * this comparator reuses ONLY `helpers/conflict-scan.ts`'s existing token
 * grammar (semver version tokens, status-category words, "key: value"/"key
 * is value" pairs) — the SAME grammar `tools-logic/supersession.ts`'s
 * `compareForConflicts` already reuses for the separate CorrectionRecord
 * flow (this module does NOT call supersession.ts — see this wave's report,
 * STEP 0/ASSERT_INVARIANTS, for why: supersession.ts's functions are bound
 * to `CorrectionRecord`, a different, `ar correct`-store-specific shape;
 * calling them here would be reaching across an unrelated subsystem for no
 * reason when the underlying grammar is a public export of conflict-scan.ts
 * either way). It does NOT detect arbitrary semantic-prose contradictions
 * ("we fully migrated OFF Postgres to CockroachDB" vs "we use Postgres") —
 * confirmed empirically against the redteam eval fixture
 * (reports/2026-08-18-eval-redteam.md HIGH-2) while resolving this wave's
 * pre-loaded Challenge A: none of the three token extractors produce a
 * matching key with differing values for that pair (no version, no status
 * word, no `key: value`/`key is value` construction shared between the two
 * sentences). Prose-semantic contradiction detection is a genuinely harder,
 * separate problem (conflict-scan.ts's own header already says so) and is
 * explicitly OUT of this wave's scope — see the wave report's "prose-
 * semantic gap" follow-up section, not silently absorbed into this grammar.
 *
 * ALGORITHM: pairwise, O(n²) over one tier's already-scored item list (n is
 * a per-tier result count, bounded by `perTierLimit`, never the full corpus).
 * For every pair (i, j):
 *   1. GRAMMAR CHECK — same key across version/status/kv tokens, different
 *      value → conflict. Symmetric (order of i/j does not matter for
 *      whether a conflict exists, only for which side is stale — see 2).
 *   2. DIRECTION — decide which side is stale, if determinable at all:
 *        - both items carry a `date` and the dates differ → the OLDER
 *          `date` is superseded by the newer one (journal's own authored-
 *          date semantics; this only requires "the two dates differ", so it
 *          applies to any date-bearing tier, not journal-specifically —
 *          journal simply always has a `date`, so this branch always fires
 *          for it unless two journal hits share the exact SAME date).
 *        - dates are equal, or one/both undefined, AND both items carry an
 *          `order` that differs → the LOWER `order` is superseded by the
 *          HIGHER `order` (append-order tie-break: palace's same-day-tie
 *          policy, per this wave's Challenge B — `order` is populated from
 *          the room file's LINE NUMBER for palace items only; journal items
 *          are deliberately NOT given an `order` value by this wave's
 *          query-memory.ts wiring, so a same-date journal tie falls through
 *          to the next bullet instead of guessing off line position, per
 *          the wave brief's literal instruction).
 *        - neither resolves → AMBIGUOUS: both sides are annotated as
 *          conflicting with each other, NEITHER is marked superseded, and
 *          (by construction, see query-memory.ts's stage) neither is
 *          penalized. Never guess which side to demote from no signal.
 *
 * NEVER DROPS: this module only classifies relations between items already
 * present in the input array — it never removes, reorders, or mutates the
 * input array itself (that is query-memory.ts's stage's job, immediately
 * downstream). A caller that ignores this module's output entirely gets
 * back the exact same candidate set it passed in.
 */

import {
  extractVersionTokens,
  extractStatusTokens,
  extractKVTokens,
} from "../helpers/conflict-scan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The minimal shape this comparator needs from a candidate — deliberately
 * NOT `QueryMemoryItem` itself, so this module has zero dependency on
 * query-memory.ts (avoiding the import-cycle query-memory.ts's own header
 * already worries about for scope.ts, and keeping this module trivially
 * unit-testable without any pipeline machinery).
 */
export interface ContradictionItem {
  /** Text the grammar extractors scan — callers typically pass `${title} ${excerpt}`. */
  text: string;
  /** Best-effort ISO date (YYYY-MM-DD). Absent/unparseable dates never
   *  resolve a direction on their own — see DIRECTION above. */
  date?: string;
  /** Append-order signal (e.g. a room file's line number). Only meaningful
   *  as a same-tier, same-day tie-break — see DIRECTION above. A caller that
   *  never wants order-based tie-breaking (this wave's journal wiring) simply
   *  omits it. */
  order?: number;
}

export interface ContradictionResult {
  /**
   * index -> the OTHER indices this index's item conflicts with (grammar
   * match found), REGARDLESS of whether a direction could be resolved.
   * Symmetric: if `conflictsWith.get(i)` contains `j`, `conflictsWith.get(j)`
   * contains `i`. This is the full annotation set — a caller uses this for
   * the additive `conflictsWith` field even when no `supersededBy` could be
   * determined (the ambiguous, down-rank-neither case).
   */
  conflictsWith: Map<number, number[]>;
  /**
   * index of the STALE item -> index of the item that supersedes it. Only
   * populated for pairs where a direction was confidently resolved (see
   * DIRECTION above). An index present here is a candidate for down-
   * ranking; an index present ONLY in `conflictsWith` (never as a key here)
   * must be annotated but NOT penalized — the ambiguous-tie safety
   * guarantee this stage exists to prove.
   *
   * If more than one sibling supersedes the same stale item (3+ conflicting
   * items in one tier), this keeps the MOST CURRENT superseder found (the
   * one that would itself win a direct pairwise comparison against any
   * earlier candidate), not simply the last one processed.
   */
  supersededBy: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Grammar check — reuses conflict-scan.ts's token extractors verbatim; does
// not fork or reimplement the grammar (see this file's header).
// ---------------------------------------------------------------------------

/** True iff `a` and `b` share at least one grammar-extracted key with a
 *  differing value (version, status-category, or key-value). Symmetric. */
function grammarConflict(a: ContradictionItem, b: ContradictionItem): boolean {
  // 1. Version tokens — same key, different semver value.
  const av = extractVersionTokens(a.text);
  if (av.size > 0) {
    const bv = extractVersionTokens(b.text);
    for (const [key, val] of av) {
      const bval = bv.get(key);
      if (bval && bval !== val) return true;
    }
  }

  // 2. Status tokens — compare CATEGORIES, not raw words (mirrors
  // conflict-scan.ts's scanForConflicts / supersession.ts's
  // compareForConflicts: "blocked" and "stuck" are the same category and
  // must not be flagged as conflicting). Checked in both directions since
  // there is no fixed "new vs existing" side for a same-tier pairwise scan
  // — unlike version/kv tokens (which require a matching KEY before values
  // are ever compared), status tokens have no per-fact key at all, so this
  // is a WIDER match than version/kv: two same-tier candidates that each
  // merely mention a DIFFERENT, topically UNRELATED status word (e.g. "the
  // demo is done" vs "the backend is broken") get flagged conflicting even
  // though they assert nothing about the same fact (independent code
  // review, W5a, 2026-08-31 — see this wave's report for the fixture that
  // proves this precisely). This is also a strict widening of conflict-
  // scan.ts's own original one-directional semantics (`scanForConflicts`
  // only checks "does EXISTING have a category NEW lacks", gated on NEW
  // having >=1 status word at all) into a symmetric, gate-free check — a
  // deliberate consequence of reusing the SAME grammar for a genuinely
  // different comparison shape (pairwise among N same-tier candidates, not
  // one-new-vs-five-recalled), not a fork of it. NOT fixed with an
  // invented topical-relevance pre-filter this wave — that would be new,
  // unscoped grammar behavior beyond "reuse the existing extractors as-is"
  // (this wave's ASSERT_INVARIANTS). The blast radius is bounded by this
  // stage's own hard invariant instead: a false-positive status match can
  // only ever ANNOTATE + down-rank, never drop, a candidate — see
  // query-memory-pipeline.test.mjs PART E's dedicated coverage for both the
  // genuine-flip case and this documented over-inclusive case, proving the
  // safety net holds even when the match itself is topically wrong. A
  // topical/shared-keyword pre-check (mirroring version/kv's implicit key
  // scoping) is a reasonable follow-up if this proves too noisy in
  // practice, not implemented here.
  const asTokens = extractStatusTokens(a.text);
  const bsTokens = extractStatusTokens(b.text);
  if (asTokens.size > 0 && bsTokens.size > 0) {
    const aCats = new Set(asTokens.values());
    const bCats = new Set(bsTokens.values());
    for (const cat of aCats) if (!bCats.has(cat)) return true;
    for (const cat of bCats) if (!aCats.has(cat)) return true;
  }

  // 3. Key-value tokens — same key, different value.
  const akv = extractKVTokens(a.text);
  if (akv.size > 0) {
    const bkv = extractKVTokens(b.text);
    for (const [key, val] of akv) {
      const bval = bkv.get(key);
      if (bval && bval !== val) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Direction resolution
// ---------------------------------------------------------------------------

type Direction = "a-newer" | "b-newer" | "tie";

function resolveDirection(a: ContradictionItem, b: ContradictionItem): Direction {
  if (a.date && b.date) {
    const da = Date.parse(a.date);
    const db = Date.parse(b.date);
    if (!isNaN(da) && !isNaN(db) && da !== db) {
      return da > db ? "a-newer" : "b-newer";
    }
    // dates equal (same day) or unparseable — fall through to order.
  }
  if (a.order !== undefined && b.order !== undefined && a.order !== b.order) {
    return a.order > b.order ? "a-newer" : "b-newer";
  }
  return "tie";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Pairwise contradiction scan over one tier's candidate list. O(n²) — the
 * caller (query-memory.ts) is expected to run this AFTER tokenize+score
 * (so `items.length` is already bounded by `perTierLimit`, not the full
 * on-disk corpus) and to skip tiers with fewer than 2 items (nothing to
 * compare) or with no date signal at all (this wave: the insight tier).
 *
 * Never drops, never reorders, never mutates `items` — returns relations
 * ONLY. The caller decides what to do with them (annotate + down-rank,
 * per this wave's brief; a future caller could choose differently without
 * this module changing).
 */
export function detectContradictions(items: ContradictionItem[]): ContradictionResult {
  const conflictsWith = new Map<number, number[]>();
  const supersededBy = new Map<number, number>();

  const addConflict = (i: number, j: number) => {
    const existing = conflictsWith.get(i);
    if (existing) existing.push(j);
    else conflictsWith.set(i, [j]);
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!grammarConflict(items[i], items[j])) continue;
      addConflict(i, j);
      addConflict(j, i);

      const dir = resolveDirection(items[i], items[j]);
      if (dir === "tie") continue; // annotate-only, never guess a direction

      const staleIdx = dir === "a-newer" ? j : i;
      const currentIdx = dir === "a-newer" ? i : j;

      const existingSuperseder = supersededBy.get(staleIdx);
      if (existingSuperseder === undefined) {
        supersededBy.set(staleIdx, currentIdx);
      } else {
        // Keep whichever superseder is itself more current, so a stale item
        // conflicting with 3+ siblings always points at the most-current one.
        const better = resolveDirection(items[currentIdx], items[existingSuperseder]);
        if (better === "a-newer") supersededBy.set(staleIdx, currentIdx);
      }
    }
  }

  return { conflictsWith, supersededBy };
}
