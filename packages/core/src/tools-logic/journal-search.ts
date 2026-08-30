import { resolveProject } from "../storage/project.js";
import { ensurePalaceInitialized } from "../palace/rooms.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { readTierCandidates } from "../retrieval/candidates.js";
import { queryMemory } from "../retrieval/query-memory.js";

export interface JournalSearchInput {
  query: string;
  project?: string;
  section?: string;
  include_palace?: boolean;
  limit?: number;
  /** Filter journal results to entries on or after this date.
   *  Accepts ISO date string ("2026-05-01") or relative duration ("7d", "30d").
   *  Palace and insight results are unaffected. */
  since?: string;
  /** SCOPE stage (Wave 3b, retrieval/scope.ts) — threaded through to
   *  queryMemory() for forward-compat with future consumers of this seam.
   *  Currently a NO-OP for the journal tier: readTierCandidates("journal",
   *  project, ...) only ever reads `project`'s own tree, so every journal
   *  candidate is trivially "of project" — there is nothing cross-project
   *  to filter (see query-memory.ts's `SCOPE_ATTRIBUTED_TIERS`). Kept as an
   *  accepted parameter so a future genuinely cross-project journal-like
   *  tier does not require another signature change here. */
  scope?: string;
}

/**
 * Parse a `since` value into a Date cutoff.
 * Supports "Nd" (N days ago) and ISO date strings.
 */
export function parseSinceDate(since: string): Date {
  const relMatch = since.match(/^(\d+)d$/i);
  if (relMatch) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(relMatch[1], 10));
    return d;
  }
  return new Date(since);
}

export interface JournalSearchResult {
  results: Array<{ date: string; section: string; excerpt: string; line: number }>;
  palace_searched: boolean;
  _note?: string;
}

/**
 * Split query into keywords (length > 2) for keyword-based matching.
 * CJK-aware (P0-b, 2026-08-18): delegates to the shared tokenizer so an
 * unspaced Chinese/Japanese query segments into real words instead of
 * collapsing into one giant token — see ../helpers/tokenize.ts's header.
 * `tokenizeWords` default minLength=3 reproduces the original `length > 2`
 * floor exactly for ASCII input.
 */
function queryKeywords(query: string): string[] {
  return tokenizeWords(query);
}

/** Return true if line contains enough query keywords (threshold: ≥1 keyword match). */
function lineMatchesQuery(line: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lineLower = line.toLowerCase();
  return keywords.some((kw) => lineLower.includes(kw));
}

/** Find first keyword match position in line for excerpt anchoring. */
function firstMatchIndex(line: string, keywords: string[]): number {
  const lineLower = line.toLowerCase();
  let first = line.length;
  for (const kw of keywords) {
    const idx = lineLower.indexOf(kw);
    if (idx !== -1 && idx < first) first = idx;
  }
  return first;
}

export async function journalSearch(input: JournalSearchInput): Promise<JournalSearchResult> {
  const slug = await resolveProject(input.project);
  const keywords = queryKeywords(input.query); // still needed below for the include_palace branch's own local scan
  const limit = input.limit ?? 25;

  // Primary journal scan — migrated onto the shared pipeline (Wave 3b,
  // 2026-08-30, reports/2026-08-30-pipe-w3b-migrate-report.md STEP 1):
  // fetch + trust-filter + per-line scoring now all come from queryMemory()'s
  // journal tier (identical excerpt-window/tokenization logic, ported
  // verbatim into scoreJournalTier — see query-memory.ts) instead of this
  // function's own fs scan plus an inline call to the rescue-tag choke
  // predicate (helpers/journal-filter.ts).
  //
  // perTierLimit is requested effectively UNBOUNDED
  // (Number.MAX_SAFE_INTEGER) rather than this function's own `limit`,
  // because queryMemory()'s journal-tier scorer has no `section` concept —
  // the section filter below must see every match in the corpus before
  // truncating, not just the first `limit` unfiltered ones (requesting a
  // pipeline-level cap here would silently under-fill a section-scoped
  // result set that has plenty of matches beyond that cap). This mirrors
  // the ORIGINAL implementation's own shape: it scanned every file/line in
  // the corpus unconditionally too, refusing only to keep PUSHING past
  // `limit` — see this function's own equivalence notes in the Wave 3b
  // report for the one case where truncation ORDER now differs
  // (characterized, not silent — see below).
  const queryResult = await queryMemory({
    query: input.query,
    project: slug,
    tiers: ["journal"],
    scope: input.scope,
    since: input.since,
    journal: { includeRollupArchive: true, perTierLimit: Number.MAX_SAFE_INTEGER },
  });

  let results: JournalSearchResult["results"] = queryResult.items.map((it) => {
    const date = it.date ?? "";
    // `it.title` is always exactly "${date} / ${section}" — scoreJournalTier's
    // own construction (query-memory.ts). Strip the fixed "${date} / "
    // prefix to recover the raw section value, rather than adding a
    // redundant field to the shared QueryMemoryItem shape only this one
    // surface would consume.
    const section = it.title.slice(date.length + 3);
    return { date, section, excerpt: it.excerpt, line: it.line ?? 0 };
  });

  if (input.section) {
    const wanted = input.section.toLowerCase();
    results = results.filter((r) => r.section === wanted);
  }

  // Sort-before-truncate (matches the characterized recency-favoring
  // improvement already documented for the smart_recall migration,
  // query-memory.ts's CHALLENGE (c)-2): when total matches are within
  // `limit` this reproduces the ORIGINAL's own final sort byte-for-byte
  // (same matches, same order); when matches exceed `limit`, this keeps
  // the truly newest `limit` — not an arbitrary filesystem-enumeration-order
  // subset (the ORIGINAL's actual truncation behavior — its `limit` cutoff
  // fired DURING an unsorted raw-readdir traversal, before its own final
  // date-sort ever ran). See the Wave 3b report for the full equivalence
  // scoping. This is an intermediate sort — the join with include_palace
  // results below is re-sorted once more, at the very end, matching the
  // ORIGINAL's single final sort over the combined set.
  results.sort((a, b) => b.date.localeCompare(a.date));
  results = results.slice(0, limit);

  if (input.include_palace) {
    try {
      ensurePalaceInitialized(slug);
      // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
      // gap #4): was a raw fs.readdirSync+readFileSync glob over every room's
      // `.md` files with ZERO rescue-tag check. Routed through
      // readTierCandidates("palace-room", ...) — already trust-tagged +
      // safe-by-default (the SAME canonical trust-filter the primary journal
      // scan above now inherits via queryMemory()'s journal tier — Wave 3b,
      // 2026-08-30 — rather than each branch calling the choke predicate on
      // its own).
      const candidates = readTierCandidates("palace-room", slug);
      for (const c of candidates) {
        const lines = c.content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (lineMatchesQuery(lines[i], keywords)) {
            const matchIdx = firstMatchIndex(lines[i], keywords);
            const start = Math.max(0, matchIdx - 40);
            const end = Math.min(lines[i].length, matchIdx + 80);
            let excerpt = lines[i].slice(start, end).trim();
            if (start > 0) excerpt = "..." + excerpt;
            if (end < lines[i].length) excerpt = excerpt + "...";
            results.push({ date: `palace:${c.room}`, section: c.file.replace(".md", ""), excerpt, line: i + 1 });
          }
        }
      }
    } catch {
      // Palace search is optional
    }
  }

  results.sort((a, b) => b.date.localeCompare(a.date));
  return {
    results,
    palace_searched: !!input.include_palace,
    ...(!input.include_palace && {
      _note: "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.",
    }),
  };
}
