import { resolveProject } from "../storage/project.js";
import { extractTitle, extractMomentum } from "../helpers/journal-files.js";
import { listCandidateStubs } from "../retrieval/candidates.js";

export interface JournalListInput {
  project?: string;
  limit?: number;
}

export interface JournalListResult {
  project: string;
  entries: Array<{ date: string; title: string; momentum: string }>;
}

/** Title shown for a quarantined (rescue-sourced) entry — never the real, attacker-influenced title/momentum. */
export const QUARANTINE_TITLE = "[quarantined — rescue-sourced entry]";

/**
 * Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass;
 * REVISED by the independent-review FIX 1 pass, same date):
 *
 * ORIGINAL fix (this wave's first pass) routed through `readTierCandidates`,
 * which DROPS the whole rescue-tagged row before returning. Independent
 * review flagged this as an over-reach: `candidate.date` here is the
 * journal-live tier's FILENAME date, itself derived from `listJournalFiles`'s
 * own `dateMatch` guard at rescue-write time — i.e. system-clock-derived at
 * the moment `distillOneSession` wrote the card
 * (`storage/working-memory.ts`'s `writeSessionCard` call), NOT a value an
 * attacker's prompt content can influence. Only `title`/`momentum` (parsed
 * from the file's raw BODY) are the actual injection vector. Dropping the
 * whole row therefore hid the entry's EXISTENCE for no security reason —
 * and because `limit` was applied AFTER the drop, `journal_list(limit=N)`
 * silently backfilled the quota from further back in time, misrepresenting
 * recency/continuity with no signal to the caller that anything was hidden.
 *
 * THE FIX: use `listCandidateStubs` (packages/core/src/retrieval/
 * candidates.ts) instead of `readTierCandidates` — it preserves EVERY
 * candidate's existence (date/file) but strips `content` for any row whose
 * underlying candidate is untrusted. A quarantined row here renders with
 * `QUARANTINE_TITLE` and an empty momentum, AT its real date, in its real
 * chronological position — never dropped, never given a fabricated
 * title/momentum. `limit` is applied to the FULL rendered list (quarantined
 * rows included, in position), so the window never silently backfills past
 * a hidden entry.
 *
 * Error-path note (Worker Done-Definition #1): a journal-live-tier candidate's
 * `date` can never be malformed/unparseable here — `listJournalFiles` (the
 * live-tier reader `listCandidateStubs("journal", ...)` delegates to)
 * requires a leading `^\d{4}-\d{2}-\d{2}` filename match before a file is
 * even considered a candidate at all (see helpers/journal-files.ts), so
 * every candidate this function ever sees already carries a well-formed
 * date string by construction — no additional validation/fallback is needed
 * here for that path. (journalList never opts into rollup/raw-archive
 * candidates, whose date semantics differ — see candidates.ts's own header —
 * so this guarantee is not weakened by a future opt-in without a
 * corresponding review of this comment.)
 */
export async function journalList(input: JournalListInput): Promise<JournalListResult> {
  const slug = await resolveProject(input.project);
  const stubs = listCandidateStubs("journal", slug);
  const limit = input.limit ?? 10;

  const entries = stubs.map((s) => {
    if (!s.trusted) {
      return { date: s.date, title: QUARANTINE_TITLE, momentum: "" };
    }
    const content = s.content ?? "";
    return {
      date: s.date,
      title: extractTitle(content),
      momentum: extractMomentum(content),
    };
  });

  // Slice the FULL rendered list (quarantined rows included, in their real
  // chronological position) — never slice the raw candidate/stub array
  // before rendering. This is what closes the "silent backfill" bug: the
  // limit window's boundary is decided over the SAME set a caller sees.
  const result = limit > 0 ? entries.slice(0, limit) : entries;

  return { project: slug, entries: result };
}
