import * as fs from "node:fs";
import { resolveProject } from "../storage/project.js";
import { readJournalFile } from "../helpers/journal-files.js";
import { extractSection } from "../helpers/sections.js";
import { readTierCandidates } from "../retrieval/candidates.js";

export interface JournalReadInput {
  date?: string;
  project?: string;
  section?: string;
}

export interface JournalReadResult {
  content: string;
  date: string;
  project: string;
  error?: string;
}

export async function journalRead(input: JournalReadInput): Promise<JournalReadResult> {
  const slug = await resolveProject(input.project);
  let targetDate = input.date ?? "latest";

  if (targetDate === "latest") {
    // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
    // gap #1): was a hand-rolled listJournalFiles()+mtime scan with its OWN
    // raw fs.readFileSync, bypassing readJournalFile's choke entirely — a
    // rescue-tagged card could win "latest" and surface unfiltered. Routed
    // through readTierCandidates (already trust-tagged + safe-by-default:
    // drops untrusted candidates before returning), matching includeRollupArchive
    // to the original's `listJournalFiles(slug, true)` includeArchive=true scope.
    const candidates = readTierCandidates("journal", slug, { includeRollupArchive: true });
    if (candidates.length === 0) {
      return { content: "", date: "", project: slug, error: `No journal entries found for project '${slug}'` };
    }
    // Among candidates with the most recent date, pick the one with the
    // highest mtime (candidates are NOT guaranteed globally date-sorted:
    // the live half and the rollup-archive half are each sorted
    // independently, then concatenated — see candidates.ts's own header).
    const latestDate = candidates.reduce((max, c) => (c.date > max ? c.date : max), candidates[0].date);
    const recentCandidates = candidates.filter(c => c.date === latestDate);
    let bestCandidate = recentCandidates[0];
    let bestMtime = 0;
    for (const cand of recentCandidates) {
      try {
        const stat = fs.statSync(cand.sourcePath);
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestCandidate = cand;
        }
      } catch { /* skip unreadable files */ }
    }
    const section = input.section ?? "all";
    const extracted = extractSection(bestCandidate.content, section) || "";
    const content = extracted.length > 20000 ? extracted.slice(0, 20000) + "\n\n...(truncated)" : extracted;
    return { content, date: latestDate, project: slug };
  }

  const fileContent = readJournalFile(slug, targetDate);
  if (!fileContent) {
    return { content: "", date: targetDate, project: slug, error: `No journal entry found for ${targetDate} in project '${slug}'` };
  }

  const section = input.section ?? "all";
  const raw = extractSection(fileContent, section) || "";
  const content = raw.length > 20000 ? raw.slice(0, 20000) + "\n\n...(truncated)" : raw;
  return { content, date: targetDate, project: slug };
}
