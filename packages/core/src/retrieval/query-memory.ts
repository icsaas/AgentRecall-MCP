/**
 * retrieval/query-memory.ts — Wave 2 of the shared retrieval pipeline
 * (reports/2026-08-21-architecture-review.md §4, reports/2026-08-29-kickoff-plan.md
 * Wave 2, plywood SOP ecbd4351).
 *
 * THE PROBLEM THIS FILE FIXES: Wave 1 (retrieval/candidates.ts) built a shared
 * TYPED reader with trust-tagging baked in, but shipped it as a LEAF UTILITY —
 * nothing was forced to call it. The architecture review's whole point is that
 * a leaf utility gets forgotten by exactly the surfaces that matter most. This
 * file is the fix: a MANDATORY PIPELINE every candidate is forced through
 * before it can be ranked or surfaced — `queryMemory()` composes six stages
 * (fetch -> trust-filter -> tokenize+score -> scope -> rank/fuse -> fence) and
 * NO stage is individually callable/skippable by a consumer; a caller gets
 * `queryMemory()`'s return value or nothing.
 *
 * WAVE 2 SCOPE: build the pipeline, then migrate exactly ONE caller onto it —
 * `smartRecall()` (tools-logic/smart-recall.ts). journalSearch, palaceSearch,
 * recallInsight, resurrect, session_start are UNCHANGED this wave (Wave 3).
 *
 * ── CHALLENGE (a): one canonical scoring formula, or pluggable per tier? ──
 * PLUGGABLE PER TIER — confirmed, not unified. smart-recall.ts's own file
 * header (still true, read in full before writing this file) spends 100 lines
 * justifying why journal (Ebbinghaus S=2, fast episodic decay), palace
 * (S=9999, salience-weighted, near-zero decay) and insight (confirmation-count
 * driven, not time-based at all) encode three genuinely different memory-type
 * semantics — collapsing them into one formula would not be "reconciliation",
 * it would be the same cross-source-raw-score-averaging bug smart-recall.ts's
 * own Fix 1 (RRF) already fixed once, reintroduced one level up. What DOES
 * unify into "ONE score stage" is the STAGE itself (TOKENIZE+SCORE as one named
 * step in the pipeline, always run, never skippable) with an internal per-tier
 * strategy table (`scoreJournalTier`/`scorePalaceTier`/`scoreInsightTier`
 * below) — this is exactly the architecture review's own §4.2 step 3 wording:
 * "applies one scoring strategy per tier ... no scoring behavior needs to
 * change on day one." The five formulas smart-recall.ts documents (RRF k=60,
 * Ebbinghaus, hot-window recency, betaUtility feedback, two-stage fusion) are
 * split by WHERE they belong in a genuinely reusable pipeline, not merged:
 *   - RRF (two-stage: applyRRF + fuseCanonical) + hot-window recency:
 *     pipeline-owned (RANK/FUSE stage below) — generic to any date-bearing,
 *     multi-tier candidate set, not smart_recall-specific.
 *   - Ebbinghaus decay, palace salience/IDF blend, insight confirmation blend:
 *     pipeline-owned (TOKENIZE+SCORE stage, per-tier) — these ARE the
 *     per-tier strategies the review names.
 *   - betaUtility feedback multiplier + calibratedConfidence labeling:
 *     LEFT IN smart-recall.ts, NOT pulled into the pipeline. Both are
 *     smart_recall-SPECIFIC concepts (a user feedback log keyed by
 *     result id/title; a confidence scale built to compare smart_recall's
 *     OWN local-vs-remote backends) that no other Wave-3 migration target
 *     (journalSearch, palaceSearch, resurrect, session_start) has any
 *     equivalent of today. Baking them into queryMemory() would force every
 *     future consumer to inherit smart_recall's own feedback-log semantics
 *     whether or not they make sense for that surface — exactly the
 *     "leaf utility everyone must remember NOT to blindly trust" anti-pattern
 *     this effort exists to close, just relocated one level deeper. They stay
 *     as smart-recall.ts's OWN post-pipeline processing, applied uniformly to
 *     whatever queryMemory() returns.
 *
 * ── CHALLENGE (b): the Wave-1 superset — what does smart_recall now SEE? ──
 * readTierCandidates("palace-room", ...) surfaces every `.md` file in a room,
 * whereas the OLD smart-recall.ts called `palaceSearch()` directly, which has
 * a KNOWN, DOCUMENTED gap (packages/core/test/identity-trust-completeness.test.mjs's
 * `ALLOWLIST_PALACE["tools-logic/palace-search.ts"]`, marked "(KNOWN GAP)"):
 * palaceSearch() never calls the rescue-quarantine choke, so a rescue-tagged
 * file planted in a room would have surfaced through smart_recall's OLD palace
 * source completely unfiltered. Wave 2's migration CLOSES this gap for the
 * smart_recall path specifically (see `scorePalaceTier` below: trust-filter
 * runs before scoring, unconditionally) — a genuine, characterized SECURITY
 * IMPROVEMENT, not a neutral refactor; see this file's own destination-proof
 * test (retrieval/query-memory.test.mjs) for the planted-rescue-content proof.
 * `palaceSearch()` itself (the standalone MCP tool / `ar palace search`
 * surface) is UNCHANGED and still carries the gap — only smart_recall's
 * INTERNAL route to palace-room content no longer does. This wave's report
 * updates identity-trust-completeness.test.mjs's ALLOWLIST_PALACE entry for
 * palace-search.ts to say so precisely (the function is still a known gap;
 * smart-recall.ts no longer calls it).
 *
 * Week-summaries / rollup-archive: smart-recall.ts's journal source already
 * reads rollup-archive today (journalSearch(...) internally calls
 * `journalDirs(slug, true)`) — `scoreJournalTier` below defaults
 * `includeRollupArchive: true` to match, so this is NOT new surface area, it
 * is preserved surface area.
 *
 * Raw-archive: NOT part of the competing tier set here (see the "archive
 * never enters RRF" note on `queryArchiveFallback` below) — unchanged
 * structurally, just relocated into this module.
 *
 * ── CHALLENGE (c): where "exact equivalence" genuinely cannot hold ──
 * Documented per-decision below, not glossed over:
 *   1. FENCE (stage 6) is NOT applied inside this pipeline to `smart_recall`'s
 *      per-item fields. See `renderFenced()`'s doc comment — forcing
 *      `fenceMemory()` onto every candidate excerpt would corrupt
 *      `SmartRecallResultItem.excerpt` (breaking the very "preserve external
 *      contract exactly" requirement this wave is graded on) AND double-fence
 *      the payload, since `packages/mcp-server/src/tools/{smart-recall,recall}.ts`
 *      ALREADY correctly call `fenceMemory()` ONCE around the whole rendered
 *      payload at the true MCP-tool surfacing boundary (P1 fence, TOW2-388,
 *      predates this wave). This is a genuine architectural conflict between
 *      the SOP's literal "fence as the final stage" wording and the
 *      already-shipped, already-tested, more-correct fencing architecture —
 *      resolved in favor of the shipped architecture; see `renderFenced()`.
 *   2. Journal-tier truncation order: the OLD `journalSearch()` applies its
 *      `limit` cutoff DURING an unsorted (raw `readdirSync` order)
 *      directory/file/line traversal, THEN sorts by date descending — so
 *      when total matches exceed `limit`, WHICH matches survive depends on
 *      filesystem enumeration order, not recency. `scoreJournalTier` below
 *      iterates `readTierCandidates`'s already-date-sorted-descending live
 *      half first — a characterized IMPROVEMENT (more predictable, favors
 *      recency, matches the tier's own Ebbinghaus-decay intent), not a
 *      silent behavior change; identical output whenever total matches <=
 *      limit (the common case). CORRECTION (independent review, W2,
 *      2026-08-30): this file's initial cut only sorted the live half — the
 *      rollup-archive half (candidates.ts) and the legacy-journal half
 *      (`readLegacyJournalCandidates` below) were still built in raw,
 *      filesystem-enumeration order before being concatenated on, so a
 *      truncation that spilled into either half would still keep an
 *      arbitrary subset rather than the newest. Both halves are now ALSO
 *      sorted date-descending before concatenation — the sort-before-
 *      truncate class is closed across live AND archive (and legacy).
 *   3. Legacy journal directory (`~/.claude/projects/<entry>/memory/journal/` —
 *      `storage/paths.ts`'s `journalDirs()` legacy-fallback branch): Wave 1's
 *      `readTierCandidates` does NOT cover this (confirmed by reading
 *      candidates.ts — it never imports `getLegacyRoot`). `journalSearch()`
 *      today DOES scan it (via `journalDirs(slug, true)`). Rather than
 *      silently dropping this surface for smart_recall (a real, if likely
 *      rare, regression) or re-opening Wave 1's already-merged, already-tested
 *      `candidates.ts` to add it there, this file adds a small, self-contained
 *      `readLegacyJournalCandidates()` below that mirrors `journalDirs()`'s own
 *      legacy-root traversal — closing the gap without touching Wave 1's file.
 *      Also now sorted date-descending before returning (see item 2's
 *      correction above) — it is a third half of the same journal-tier
 *      concatenation, not exempt from the same truncation hazard.
 *
 * ── SCOPE NOTE (independent review, W2, 2026-08-30) ──
 * CRITICAL-2 (rescue-quarantine injection) is closed for `smart_recall` this
 * wave. `palaceSearch()` / `journalSearch()` / `recallInsight()` /
 * `resurrect()` / `session_start()` remain on their own pre-pipeline paths
 * and are UNCHANGED — they carry whatever trust-filtering (or lack of it)
 * they had before this wave, until they are migrated onto `queryMemory()` in
 * Wave 3/4. Do not read this file's fixes as closing the gap workspace-wide.
 */

import { readTierCandidates, filterTrusted, type MemoryCandidate } from "./candidates.js";
import { listRooms, recordAccess, ensurePalaceInitialized } from "../palace/rooms.js";
import { stem, expandQuery } from "../helpers/normalize.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { recallInsight } from "../tools-logic/recall-insight.js";
import { parseSinceDate } from "../tools-logic/journal-search.js";
import { CONFIDENCE_FLOOR } from "../tools-logic/confidence.js";
import { scrubForCloud, fenceMemory } from "../storage/content-guard.js";
import { getLegacyRoot } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three tiers that compete inside the shared RRF fusion this wave. */
export type QueryMemoryTier = "journal" | "palace" | "insight";

/** Every source label a `QueryMemoryItem` can carry, including the
 *  non-competing archive fallback (see `queryArchiveFallback`). */
export type QueryMemorySource = QueryMemoryTier | "archive";

/**
 * The pipeline's per-candidate output shape — deliberately close to (but
 * independent of, to avoid a circular import) `SmartRecallResultItem`.
 * `confidence`/`calibrated` are NOT here — those are smart_recall-specific
 * post-processing (see this file's header, CHALLENGE (a)).
 */
export interface QueryMemoryItem {
  id: string;
  source: QueryMemorySource;
  alsoFoundIn?: QueryMemorySource[];
  title: string;
  excerpt: string;
  /** Cross-source fusion identity override — see smart-recall.ts's original
   *  Fix 5b doc comment (ported verbatim in spirit): insight items set this
   *  because their displayed excerpt is too low-entropy to serve as a fusion
   *  identity on its own. */
  fusionKey?: string;
  /** Tier-internal score before fusion; post-fusion RRF score after. */
  score: number;
  room?: string;
  /** Palace-room file basename, without `.md` — needed to reconstruct a
   *  `VerbatimKey` for the Bridge (kept generic here; smart-recall.ts builds
   *  the actual `VerbatimKey` object, since this module must not depend on
   *  tools-logic/drill-down.ts's own dependents to avoid coupling). */
  file?: string;
  date?: string;
  severity?: string;
  /** Palace-only: exposed because smart-recall.ts's original item shape
   *  carried it (`keyword_score` on `PalaceSearchResult`) — forward-compat,
   *  currently unused by any consumer post-migration but not worth dropping. */
  keywordScore?: number;
}

export interface QueryMemoryInput {
  query: string;
  /** Already-resolved project slug — this module does not call
   *  resolveProject(), matching Wave 1's `readTierCandidates` convention. */
  project: string;
  tiers: QueryMemoryTier[];
  /** SCOPE stage seam (Wave 3 wires the real project-vs-global decision).
   *  Accepted and threaded through so call sites don't need to change again
   *  next wave, but `applyScope()` below is a passthrough this wave. */
  scope?: string;
  /** Final result cap, applied AFTER fusion (matches smart-recall.ts's
   *  `finalResults = results.slice(0, limit)` semantics, but the fused list
   *  itself is NOT truncated here — callers that need the untruncated fused
   *  list for their own gating (e.g. smart_recall's archive-fallback
   *  confidence gate) get it via `QueryMemoryResult.items`, uncut. */
  limit?: number;
  /** journal tier only — matches smart_recall's/journalSearch's `since`. */
  since?: string;
  journal?: { includeRollupArchive?: boolean; perTierLimit?: number };
  palace?: { room?: string; perTierLimit?: number };
  insight?: { perTierLimit?: number; includeAwareness?: boolean };
}

export interface QueryMemoryResult {
  /** Fused + ranked (RRF, two-stage canonical fusion, hot-window recency
   *  boost applied) — UNCUT, UNFENCED. Caller applies its own limit/labeling/
   *  feedback adjustments. */
  items: QueryMemoryItem[];
  /** Raw pre-fusion candidate counts per competing tier (Fix 4/5 semantics —
   *  BEFORE cross-source fusion collapses same-excerpt duplicates). */
  candidatesBySource: Partial<Record<QueryMemoryTier, number>>;
  /** Every tier that was successfully queried (did not throw), independent
   *  of hit count — matches smart-recall.ts's original `sourcesQueried`
   *  semantics exactly. */
  sourcesQueried: QueryMemoryTier[];
  /**
   * FENCE stage (pipeline stage 6) — the pipeline's OWN canonical
   * "wrap retrieved content before it reaches an agent" implementation, for
   * consumers that want a ready-to-surface rendered TEXT blob straight from
   * queryMemory() (e.g. a future markdown-brief-returning caller). Joins
   * `items` (up to `limit`) into one block and wraps it via `fenceMemory()`
   * EXACTLY ONCE.
   *
   * `smart_recall` does NOT call this. Its structured `SmartRecallResultItem[]`
   * output is serialized directly (JSON.stringify) by its OWN MCP tool
   * wrapper (`packages/mcp-server/src/tools/{smart-recall,recall}.ts`), which
   * ALREADY correctly calls `fenceMemory()` ONCE around the entire rendered
   * payload — this is the shipped, tested (fence-completeness.test.mjs) P1
   * fence architecture (TOW2-388), predating this wave. Calling
   * `fenceMemory()` a SECOND time here, per-item, would (a) inject the fence
   * open/close lines into every `excerpt` string, corrupting the exact field
   * values `SmartRecallResultItem` promises callers ("preserve external
   * contract exactly" — this wave's own success condition), and (b) produce
   * a doubly-fenced, garbled blob once the MCP wrapper's own outer
   * `fenceMemory()` wraps the already-fenced JSON a second time. See this
   * file's header, CHALLENGE (c)-1, for the full reasoning. The completeness
   * guarantee ("a queryMemory-based surface cannot bypass fencing") is
   * enforced by keeping `packages/mcp-server/test/fence-completeness.test.mjs`
   * green against the UNCHANGED MCP-tool-layer fenceMemory() call sites, not
   * by mutating this function's structured output.
   */
  renderFenced(limit?: number): string;
}

// ---------------------------------------------------------------------------
// Math helpers — ported from smart-recall.ts, unchanged formulas (see
// CHALLENGE (a) above for why these stay per-tier, not unified).
// ---------------------------------------------------------------------------

const RRF_K = 60;

const EBBINGHAUS_S = {
  journal: 2,
  palace: 9999,
} as const;

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 365;
  return Math.max(0, (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function ebbinghaus(days: number, S: number): number {
  return Math.exp(-days / S);
}

/** Keyword overlap ratio between query and text — ported verbatim from
 *  smart-recall.ts's `keywordExactness` (CJK-aware via the shared tokenizer). */
function keywordExactness(query: string, text: string): number {
  const rawWords = tokenizeWords(query);
  if (rawWords.length === 0) return 0;
  const expandedQuery = expandQuery(rawWords);
  const textWords = tokenizeWords(text).map((w) => stem(w));
  const textSet = new Set(textWords);
  const textLower = text.toLowerCase();
  const matches = expandedQuery.filter((w) => textSet.has(w) || textLower.includes(w));
  return Math.min(1.0, matches.length / rawWords.length);
}

/** Simple stable hash for result IDs — ported verbatim from smart-recall.ts. */
function stableId(source: string, title: string): string {
  let hash = 0;
  const str = `${source}:${title}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function normalizeExcerpt(excerpt: string): string {
  return excerpt.toLowerCase().replace(/\s+/g, " ").trim();
}

function fusionIdentity(item: QueryMemoryItem): string {
  return normalizeExcerpt(item.fusionKey ?? item.excerpt);
}

/** Find first keyword match position in a line, for excerpt anchoring
 *  (ported from journal-search.ts's `firstMatchIndex`). */
function firstMatchIndex(line: string, keywords: string[]): number {
  const lineLower = line.toLowerCase();
  let first = line.length;
  for (const kw of keywords) {
    const idx = lineLower.indexOf(kw);
    if (idx !== -1 && idx < first) first = idx;
  }
  return first;
}

function lineMatchesQuery(line: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lineLower = line.toLowerCase();
  return keywords.some((kw) => lineLower.includes(kw));
}

// ---------------------------------------------------------------------------
// TRUST-FILTER stage — mandatory, applied to every candidate before scoring.
// Not individually callable/skippable: every tier-scoring function below
// filters through `filterTrusted` as its FIRST step, before any
// tokenize/score work.
//
// Independent review fix (W2, 2026-08-30): this stage now delegates to
// `filterTrusted` (retrieval/candidates.ts) — the SAME canonical
// implementation `readTierCandidates`'s own safe-by-default filtering uses —
// rather than a local, forked `!c.untrusted` predicate. Every `readTierCandidates`
// call site below passes `includeUntrusted: true` so this stage still sees
// (and still filters) the full candidate set — the reader's own new
// safe-by-default drop is bypassed here on purpose, because this pipeline
// stage is the mandatory, non-bypassable place that decision belongs;
// keeping BOTH the reader's own default-safe boundary AND this stage intact
// preserves queryMemory()'s exact pre-existing ranking (byte-identical —
// see this wave's report for the smartRecall() equivalence proof) while
// closing the direct-caller escape hatch a naive `readTierCandidates()`
// caller previously had.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SCOPE stage — Wave 3 seam. Passthrough this wave (no existing smart_recall
// call site enforces project-vs-global scoping today either, so this is not a
// behavior change — see kickoff plan Wave 3/P7).
// ---------------------------------------------------------------------------

function applyScope<T>(items: T[], _project: string, _scope: string | undefined): T[] {
  return items;
}

// ---------------------------------------------------------------------------
// CHALLENGE (c)-3: legacy journal directory. Wave 1's readTierCandidates does
// not cover `~/.claude/projects/<entry>/memory/journal/` (storage/paths.ts's
// journalDirs() legacy-fallback branch) — journalSearch()/smart_recall today
// DO scan it. Mirrors journalDirs()'s own traversal exactly, read-only, never
// throws. Untrusted always false: this content predates the working-memory
// rescue mechanism's existence entirely (it is a pre-package memory format),
// so it structurally cannot carry a `source: working-memory-rescue` tag.
//
// Independent review fix (MEDIUM-1, W2, 2026-08-30): returns date-descending
// (sorted below, before returning) — same sort-before-truncate closure this
// wave applies to candidates.ts's rollup-archive half. Raw traversal order
// here is nested-readdirSync (project-dir enumeration outer, file-within-dir
// enumeration inner) — filesystem-dependent, not date order — so a caller
// truncating this list (scoreJournalTier's perTierLimit break, after
// concatenating this onto the already-sorted live+rollup-archive half) must
// not see an arbitrary enumeration-order subset when total legacy entries
// exceed the limit.
// ---------------------------------------------------------------------------

function readLegacyJournalCandidates(project: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  let legacyRoot: string;
  try {
    legacyRoot = getLegacyRoot();
  } catch {
    return out;
  }
  if (!fs.existsSync(legacyRoot)) return out;
  let entries: string[];
  try {
    entries = fs.readdirSync(legacyRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.includes(project)) continue;
    const legacyJournal = path.join(legacyRoot, entry, "memory", "journal");
    if (!fs.existsSync(legacyJournal)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(legacyJournal).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const sourcePath = path.join(legacyJournal, file);
      let content: string;
      try {
        content = fs.readFileSync(sourcePath, "utf-8");
      } catch {
        continue;
      }
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      out.push({
        content,
        tier: "journal",
        project,
        date: dateMatch ? dateMatch[1] : "",
        sourcePath,
        file,
        sourceKind: "journal-live",
        untrusted: false,
      });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// ---------------------------------------------------------------------------
// TOKENIZE+SCORE stage — one strategy per tier.
// ---------------------------------------------------------------------------

/** Journal tier: ported from journal-search.ts's per-line matching (section
 *  tracking, excerpt window) + smart-recall.ts's Ebbinghaus×exactness scoring —
 *  now operating on already-fetched MemoryCandidate content instead of a
 *  fresh fs read. */
function scoreJournalTier(
  project: string,
  query: string,
  opts: { includeRollupArchive?: boolean; perTierLimit?: number; since?: string },
): QueryMemoryItem[] {
  const candidates = filterTrusted(
    readTierCandidates("journal", project, {
      includeRollupArchive: opts.includeRollupArchive ?? true,
      includeUntrusted: true,
    }),
  ).concat(filterTrusted(readLegacyJournalCandidates(project)));

  const keywords = tokenizeWords(query);
  if (keywords.length === 0) return [];
  const sinceCutoff = opts.since ? parseSinceDate(opts.since) : null;
  const limit = opts.perTierLimit ?? 25;

  interface Hit { title: string; excerpt: string; date: string }
  const hits: Hit[] = [];

  for (const candidate of candidates) {
    if (hits.length >= limit) break;
    if (sinceCutoff && candidate.date) {
      const fileDate = new Date(candidate.date);
      if (!isNaN(fileDate.getTime()) && fileDate < sinceCutoff) continue;
    }
    const lines = candidate.content.split("\n");
    let currentSection = "top";
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) break;
      const line = lines[i];
      if (line.startsWith("## ")) {
        currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, "_");
      }
      if (!lineMatchesQuery(line, keywords)) continue;
      const date = candidate.date || candidate.file;
      const matchIdx = firstMatchIndex(line, keywords);
      const start = Math.max(0, matchIdx - 100);
      const end = Math.min(line.length, matchIdx + 150);
      let excerpt = line.slice(start, end).trim();
      if (start > 0) excerpt = "..." + excerpt;
      if (end < line.length) excerpt = excerpt + "...";
      hits.push({ title: `${date} / ${currentSection}`, excerpt, date });
    }
  }

  const items: QueryMemoryItem[] = hits.map((h) => {
    const id = stableId("journal", h.title);
    const days = daysSince(h.date);
    const recency = ebbinghaus(days, EBBINGHAUS_S.journal);
    const exactness = keywordExactness(query, h.excerpt);
    const internalScore = recency * 0.5 + exactness * 0.5;
    return { id, source: "journal", title: h.title, excerpt: h.excerpt, score: internalScore, date: h.date };
  });
  items.sort((a, b) => b.score - a.score);
  return items;
}

/** Palace tier: ported from palace-search.ts's tagBonus + per-line matching +
 *  IDF re-scoring, operating on already-fetched room-file MemoryCandidates
 *  instead of a fresh fs read, then blended with salience exactly as
 *  smart-recall.ts's original `internalScore = keyScore*0.65 + salience*0.35`.
 *  TRUST-FILTERED before any of this runs — CLOSES the known gap
 *  documented in this file's header, CHALLENGE (b). */
function scorePalaceTier(
  project: string,
  query: string,
  opts: { room?: string; perTierLimit?: number },
): QueryMemoryItem[] {
  // Matches palace-search.ts's own first executable step — scaffolds the
  // palace dir + default rooms (writing each default room's `_room.json`) on
  // first touch. Without this, `listRooms()` (both here and inside
  // `readTierCandidates("palace-room", ...)`) silently sees zero rooms for a
  // project whose palace/ has never been initialized, even when `rooms/*/`.md
  // content already exists on disk — `listRooms()` requires a `_room.json`
  // per room dir, which only `ensurePalaceInitialized`/`createRoom` write.
  ensurePalaceInitialized(project);
  const candidates = filterTrusted(
    readTierCandidates("palace-room", project, { room: opts.room, includeUntrusted: true }),
  );
  const rooms = listRooms(project);
  const salienceByRoom = new Map(rooms.map((r) => [r.slug, r.salience]));

  const rawQueryWords = tokenizeWords(query);
  const projectVariants = new Set<string>();
  {
    const base = project.toLowerCase();
    projectVariants.add(base);
    projectVariants.add(base.replace(/[-_\s]+/g, ""));
    projectVariants.add(stem(base));
    for (const part of base.split(/[-_\s]+/)) {
      if (part.length > 2) {
        projectVariants.add(part);
        projectVariants.add(stem(part));
      }
    }
  }
  const filteredRawQueryWords = rawQueryWords.filter(
    (w) => !projectVariants.has(w) && !projectVariants.has(stem(w)),
  );
  const queryWords = expandQuery(filteredRawQueryWords);
  if (queryWords.length === 0) return [];

  interface Hit { room: string; file: string; excerpt: string; line: number; keywordScore: number }
  const hits: Hit[] = [];
  const roomsWithHits = new Set<string>();

  function parseFrontmatterTags(content: string): string[] {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return [];
    const tagsLine = match[1].split("\n").find((l) => l.trim().startsWith("tags:"));
    if (!tagsLine) return [];
    const arrayMatch = tagsLine.match(/tags:\s*\[([^\]]*)\]/);
    if (!arrayMatch) return [];
    return arrayMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter((t) => t.length > 0);
  }

  for (const candidate of candidates) {
    const room = candidate.room ?? "";
    const file = candidate.file.replace(".md", "");
    const lines = candidate.content.split("\n");
    const fileTags = parseFrontmatterTags(candidate.content);
    const tagBonus = queryWords.some((w) => fileTags.some((t) => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
      ? 0.10
      : 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (/^#{1,6}\s/.test(lines[i])) continue; // skip structural headings
      const lineWords = tokenizeWords(lineLower).map((w) => stem(w));
      const lineWordSet = new Set(lineWords);
      const matchedWords = queryWords.filter((w) => lineWordSet.has(w) || lineLower.includes(w));
      if (matchedWords.length === 0) continue;

      const rawKeywordScore = matchedWords.length / queryWords.length;
      const keywordScore = Math.min(1.0, rawKeywordScore + tagBonus);

      const firstKw = matchedWords[0];
      const matchIdx = lineLower.indexOf(firstKw);
      const start = Math.max(0, matchIdx - 40);
      const end = Math.min(lines[i].length, matchIdx + firstKw.length + 80);
      let excerpt = lines[i].slice(start, end).trim();
      if (start > 0) excerpt = "..." + excerpt;
      if (end < lines[i].length) excerpt = excerpt + "...";

      hits.push({ room, file, excerpt, line: i + 1, keywordScore });
      roomsWithHits.add(room);
    }
  }

  // IDF re-scoring — ported verbatim from palace-search.ts's Fix RC3.
  if (hits.length > 0) {
    const totalDocs = new Set(hits.map((h) => `${h.room}/${h.file}`)).size;
    const docFreq = new Map<string, Set<string>>();
    for (const h of hits) {
      const docId = `${h.room}/${h.file}`;
      const combined = (h.excerpt + " " + h.room + " " + h.file).toLowerCase();
      for (const w of queryWords) {
        if (combined.includes(w)) {
          if (!docFreq.has(w)) docFreq.set(w, new Set());
          docFreq.get(w)!.add(docId);
        }
      }
    }
    const idfRaw = new Map<string, number>();
    for (const w of queryWords) {
      const df = docFreq.get(w)?.size ?? 0;
      idfRaw.set(w, Math.log(1 + totalDocs / (df + 1)));
    }
    const maxIdf = Math.max(1, ...Array.from(idfRaw.values()));
    const idf = new Map<string, number>();
    for (const [w, v] of idfRaw) idf.set(w, v / maxIdf);

    for (const h of hits) {
      const combined = (h.excerpt + " " + h.room + " " + h.file).toLowerCase();
      const matchedIdfWords = queryWords.filter((w) => combined.includes(w));
      if (matchedIdfWords.length === 0) continue;
      const idfWeightedScore = matchedIdfWords.reduce((sum, w) => sum + (idf.get(w) ?? 0), 0) / queryWords.length;
      h.keywordScore = Math.min(1.0, idfWeightedScore * 0.70 + h.keywordScore * 0.30);
    }
  }

  // recordAccess side effect — matches palaceSearch()'s original behavior
  // (once per room that contributed >=1 hit).
  for (const room of roomsWithHits) {
    try {
      recordAccess(project, room);
    } catch { /* best-effort, never block scoring on a bookkeeping write */ }
  }

  const limit = opts.perTierLimit ?? 40; // matches smart-recall's `limit*2` request to palaceSearch
  // Score ALL hits first, sort by the SAME internal score used for RRF
  // ranking, THEN truncate — a single consistent truncation criterion.
  // (The original palaceSearch() truncates internally by a DIFFERENT
  // criterion — keyword_score * raw roomMeta.salience, no floor — before
  // smart-recall.ts re-scores by keyScore*0.65+salienceFloor*0.35 for its own
  // ranking; this collapses that two-stage, two-criteria truncation into one,
  // a characterized simplification, not a regression — see this file's header.)
  const items: QueryMemoryItem[] = hits.map((h) => {
    const title = `${h.room}/${h.file}`;
    const id = stableId("palace", title);
    const salience = Math.max(0.4, salienceByRoom.get(h.room) ?? 0.5);
    const internalScore = h.keywordScore * 0.65 + salience * 0.35;
    const datePattern = h.excerpt.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      id,
      source: "palace",
      title,
      excerpt: h.excerpt,
      score: internalScore,
      room: h.room,
      file: h.file,
      date: datePattern ? datePattern[1] : undefined,
      keywordScore: h.keywordScore,
    };
  });
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

/** Insight tier: delegates to recallInsight() (its own single-owner tier,
 *  per the architecture review §4.1 — insights are a curated
 *  confirmed-pattern store, not raw retrievable file content, so there is no
 *  MemoryCandidate/trust-tag notion for this tier; every insight item is
 *  `untrusted: false` by construction, a deliberate, documented decision —
 *  not an oversight). Scoring formula ported verbatim from smart-recall.ts. */
async function scoreInsightTier(
  query: string,
  opts: { perTierLimit?: number },
): Promise<QueryMemoryItem[]> {
  const limit = opts.perTierLimit ?? 20;
  const insightResults = await recallInsight({ context: query, limit, include_awareness: false });
  const maxRelevance = Math.max(1, ...insightResults.matching_insights.map((i) => i.relevance));

  const items: QueryMemoryItem[] = insightResults.matching_insights.map((i) => {
    const id = stableId("insight", i.title);
    const relevance = i.relevance / maxRelevance;
    const exactness = keywordExactness(query, i.title);
    const confirmation = Math.min(1.0, Math.log2(i.confirmed + 1) / 3);
    const internalScore = relevance * 0.40 + exactness * 0.35 + confirmation * 0.25;
    const rawExcerpt = `[${i.severity}] ${i.applies_when.join(", ")}`;
    const fusionSeed = `${i.title} ${rawExcerpt}`;
    return {
      id,
      source: "insight",
      title: i.title,
      excerpt: rawExcerpt.length > 300 ? rawExcerpt.slice(0, 300) + "..." : rawExcerpt,
      fusionKey: fusionSeed.length > 300 ? fusionSeed.slice(0, 300) + "..." : fusionSeed,
      score: internalScore,
      severity: i.severity,
    };
  });
  items.sort((a, b) => b.score - a.score);
  return items;
}

// ---------------------------------------------------------------------------
// RANK/FUSE stage — two-stage RRF + canonical fusion + hot-window recency
// boost. Ported verbatim from smart-recall.ts's applyRRF/fuseCanonical
// (Fix 5/5b) — this IS the "one implementation" the architecture review's
// §4.1 diagram names; it does not vary per tier.
// ---------------------------------------------------------------------------

interface RRFEntry {
  score: number;
  item: QueryMemoryItem;
  sources: Set<QueryMemorySource>;
}

function applyRRF(rankedItems: QueryMemoryItem[], rrfMap: Map<string, RRFEntry>): void {
  rankedItems.forEach((item, idx) => {
    const rank = idx + 1;
    const contribution = 1 / (RRF_K + rank);
    const existing = rrfMap.get(item.id);
    if (existing) {
      existing.score += contribution;
    } else {
      rrfMap.set(item.id, { score: contribution, item, sources: new Set([item.source]) });
    }
  });
}

function fuseCanonical(rrfMap: Map<string, RRFEntry>): Map<string, RRFEntry> {
  const canonical = new Map<string, RRFEntry>();
  for (const entry of rrfMap.values()) {
    const key = fusionIdentity(entry.item);
    const existing = canonical.get(key);
    if (existing) {
      existing.score += entry.score;
      for (const s of entry.sources) existing.sources.add(s);
    } else {
      canonical.set(key, { score: entry.score, item: entry.item, sources: new Set(entry.sources) });
    }
  }
  return canonical;
}

function applyHotWindowBoost(fusedMap: Map<string, RRFEntry>): void {
  for (const entry of fusedMap.values()) {
    if (entry.item.date) {
      const hoursAgo = (Date.now() - new Date(entry.item.date).getTime()) / (1000 * 60 * 60);
      if (hoursAgo < 6) entry.score *= 3.0;
      else if (hoursAgo < 24) entry.score *= 2.0;
      else if (hoursAgo < 72) entry.score *= 1.3;
    }
  }
}

// ---------------------------------------------------------------------------
// queryMemory() — the mandatory pipeline entry point.
// ---------------------------------------------------------------------------

const TIER_SCORERS: {
  [K in QueryMemoryTier]: (input: QueryMemoryInput) => Promise<QueryMemoryItem[]>;
} = {
  journal: async (input) =>
    scoreJournalTier(input.project, input.query, {
      includeRollupArchive: input.journal?.includeRollupArchive,
      // Matches smart-recall.ts's original `journalSearch({..., limit: Math.ceil(limit*1.5)})`.
      perTierLimit: input.journal?.perTierLimit ?? Math.ceil((input.limit ?? 10) * 1.5),
      since: input.since,
    }),
  palace: async (input) =>
    scorePalaceTier(input.project, input.query, {
      room: input.palace?.room,
      // Matches smart-recall.ts's original `palaceSearch({..., limit: limit*2})`.
      perTierLimit: input.palace?.perTierLimit ?? (input.limit ?? 10) * 2,
    }),
  insight: async (input) =>
    scoreInsightTier(input.query, {
      // Matches smart-recall.ts's original `recallInsight({..., limit: limit*2})`.
      perTierLimit: input.insight?.perTierLimit ?? (input.limit ?? 10) * 2,
    }),
};

export async function queryMemory(input: QueryMemoryInput): Promise<QueryMemoryResult> {
  const sourcesQueried: QueryMemoryTier[] = [];
  const candidatesBySource: Partial<Record<QueryMemoryTier, number>> = {};
  const byTier: Partial<Record<QueryMemoryTier, QueryMemoryItem[]>> = {};

  for (const tier of input.tiers) {
    try {
      // FETCH + TRUST-FILTER + TOKENIZE+SCORE (per-tier strategy table above).
      let items = await TIER_SCORERS[tier](input);
      // SCOPE stage seam (Wave 3) — passthrough this wave.
      items = applyScope(items, input.project, input.scope);
      byTier[tier] = items;
      candidatesBySource[tier] = items.length;
      sourcesQueried.push(tier);
    } catch {
      // A tier failing to initialize (e.g. palace not yet created) must not
      // fail the whole query — matches smart-recall.ts's original per-source
      // try/catch isolation.
    }
  }

  // RANK/FUSE stage.
  const rrfMap = new Map<string, RRFEntry>();
  for (const tier of input.tiers) {
    const items = byTier[tier];
    if (items) applyRRF(items, rrfMap);
  }
  const fusedMap = fuseCanonical(rrfMap);
  applyHotWindowBoost(fusedMap);

  const seen = new Set<string>();
  const fused: QueryMemoryItem[] = [];
  for (const { score, item, sources } of fusedMap.values()) {
    const key = fusionIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const alsoFoundIn = [...sources].filter((s) => s !== item.source);
    fused.push({ ...item, score, ...(alsoFoundIn.length > 0 ? { alsoFoundIn } : {}) });
  }
  fused.sort((a, b) => b.score - a.score);

  return {
    items: fused,
    candidatesBySource,
    sourcesQueried,
    renderFenced(limit?: number): string {
      const capped = typeof limit === "number" ? fused.slice(0, limit) : fused;
      const lines = capped.map(
        (it, i) => `[${i + 1}][${it.source}${it.room ? `/${it.room}` : ""}] ${it.title} — ${it.excerpt}`,
      );
      return fenceMemory(lines.join("\n"));
    },
  };
}

// ---------------------------------------------------------------------------
// Archive fallback — F4 (continuity wave, 2026-07-31), relocated here from
// smart-recall.ts per this wave's brief ("archiveSearch composition ... move
// INTO the pipeline"). Deliberately NOT part of `queryMemory()`'s `tiers`
// array / RRF fusion: the ORIGINAL design's own doc comment says this can
// "NEVER be part of the palace/journal/insight RRF fusion" — it is a
// confidence-GATED last resort, and the gate (fused top confidence vs
// CONFIDENCE_FLOOR.medium) is a smart_recall-SPECIFIC policy decision, not a
// generic pipeline stage. Baking that gate into queryMemory() itself would
// leak surface-specific policy into the shared pipeline — the same
// "leaf utility everyone must remember not to (mis)trust" anti-pattern this
// whole effort exists to close, just at a different layer. So: the FETCH +
// TRUST-FILTER + capped-SCORE logic moves here (this file); the GATING
// decision (when to call it) stays exactly where it always was —
// smart-recall.ts's own post-fusion policy, unchanged.
// ---------------------------------------------------------------------------

export function queryArchiveFallback(project: string, query: string, limit: number): QueryMemoryItem[] {
  const keywords = tokenizeWords(query);
  if (keywords.length === 0 || limit <= 0) return [];

  const candidates = filterTrusted(
    readTierCandidates("journal", project, { includeRawArchive: true, includeUntrusted: true }).filter(
      (c) => c.sourceKind === "journal-archive-raw",
    ),
  );
  // Newest raw dump first — matches the original's `files.sort((a,b) =>
  // b.localeCompare(a))` file-order preference for a last-resort fallback.
  candidates.sort((a, b) => b.file.localeCompare(a.file));

  const items: QueryMemoryItem[] = [];
  for (const candidate of candidates) {
    if (items.length >= limit) break;
    const lines = candidate.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (items.length >= limit) break;
      const line = lines[i];
      const lineLower = line.toLowerCase();
      if (!keywords.some((kw) => lineLower.includes(kw))) continue;

      let matchIdx = line.length;
      for (const kw of keywords) {
        const idx = lineLower.indexOf(kw);
        if (idx !== -1 && idx < matchIdx) matchIdx = idx;
      }
      const start = Math.max(0, matchIdx - 100);
      const end = Math.min(line.length, matchIdx + 150);
      let snippet = line.slice(start, end).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < line.length) snippet = snippet + "...";
      if (!snippet) continue;
      snippet = scrubForCloud(snippet);

      const provenance = path.join("journal", "archive", "raw", candidate.file);
      const rawScore = Math.min(keywordExactness(query, line), CONFIDENCE_FLOOR.medium - 0.01);

      items.push({
        id: stableId("archive", `${candidate.file}:${i}`),
        source: "archive",
        title: `archive/${candidate.file}`,
        excerpt: `[raw-archive · low-confidence · ${provenance}] ${snippet}`,
        score: rawScore,
        file: candidate.file,
        date: candidate.date || undefined,
      });
    }
  }
  return items;
}
