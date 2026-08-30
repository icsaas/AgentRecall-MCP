import { resolveProject } from "../storage/project.js";
import { extractTitle, extractMomentum } from "../helpers/journal-files.js";
import { readTierCandidates } from "../retrieval/candidates.js";

export interface JournalListInput {
  project?: string;
  limit?: number;
}

export interface JournalListResult {
  project: string;
  entries: Array<{ date: string; title: string; momentum: string }>;
}

/**
 * Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass):
 * was a raw fs.readFileSync of every journal file's content (to extract
 * title/momentum) with ZERO rescue-tag check — a hijacked card's fabricated
 * title could surface directly in this list. Found while auditing the
 * broadened journal risk-pattern (this codebase's identity-trust-completeness
 * harness now also matches listJournalFiles()+its-own-readFileSync, not just
 * journalDirs()/archiveRawDir() directly) alongside the 6 named gaps. Routed
 * through readTierCandidates — already trust-tagged + safe-by-default.
 */
export async function journalList(input: JournalListInput): Promise<JournalListResult> {
  const slug = await resolveProject(input.project);
  let candidates = readTierCandidates("journal", slug);
  const limit = input.limit ?? 10;

  if (limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  const result = candidates.map((c) => ({
    date: c.date,
    title: extractTitle(c.content),
    momentum: extractMomentum(c.content),
  }));

  return { project: slug, entries: result };
}
