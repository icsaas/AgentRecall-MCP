/**
 * drill-down.ts — the lossless fallback half of the Bridge (Wave 4).
 *
 * When the model tier (compressed recall) is not confident, the bridge drills
 * DOWN into the lossless archive and attaches a verbatim source instead of
 * answering thinly. `fetchVerbatim(project, key)` resolves a result item's
 * `verbatimKey` to its raw text.
 *
 * Local-only this wave: the Supabase backend maps no `date` field and folds the
 * slug into `title`, so remote drill-down is unsound until the remote query is
 * extended (see plan §Wave 4 verified facts). Journal + palace local reads only.
 *
 * F4 (continuity wave, 2026-07-31) added a third kind, "archive": resolves a
 * smartRecall archive-source item's `verbatimKey` back to its raw file under
 * journal/archive/raw/, deliberately on a SEPARATE resolution path from
 * "journal" so the two can never collide (see the "archive" branch below).
 *
 * NEVER throws into recall — returns null on any error or path-escape attempt.
 *
 * ── SECURITY FIX (pre-ship red-team Break #2, 2026-09-01, wave/pipe-w5fix,
 * STEP 2) ──
 * The "palace" branch (below) used to do a raw `fs.readFileSync` with NO
 * trust check at all. `identity-trust-completeness.test.mjs`'s PART F
 * (multi-region residual check) previously allowlisted this branch as "SAFE
 * by structural argument" — reasoning that `key.room`/`key.file` are
 * caller-specified (a single explicit file, not a passive room glob) so no
 * LIVE caller could plant a rescue-tagged file at an attacker-chosen
 * location and have it surface here. That argument is about who CALLS this
 * function today; it says nothing about the function's OWN body, and
 * `fetchVerbatim` is a PUBLIC export with no caller-enforcement mechanism —
 * a future caller (or a caller reachable via a `verbatimKey` round-tripped
 * through a result item, which is exactly what this function exists to
 * resolve) could legitimately pass a `{kind:"palace", room, file}` pointing
 * at a rescue-tagged room file, and this branch would have returned its raw
 * content unfiltered. FIXED: the palace branch now calls
 * `isRescueSourcedContent` before returning, mirroring the journal branch's
 * own `readJournalFile` choke immediately above it — a rescue-tagged palace
 * file resolves to `null` (the same "nothing genuine found" contract a
 * missing file already gets), never fabricating a substitute. The
 * "structural argument" allowlist entry for this branch is retired in favor
 * of this code-enforced choke — see identity-trust-completeness.test.mjs's
 * updated PART F assertion.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readJournalFile } from "../helpers/journal-files.js";
import { isRescueSourcedContent } from "../helpers/journal-filter.js";
import { archiveRawDir, palaceDir, sanitizeSlug } from "../storage/paths.js";
import { scrubForCloud } from "../storage/content-guard.js";
import { getRoot } from "../types.js";

/** Locator stamped onto a recall result so the bridge can fetch its raw source. */
export interface VerbatimKey {
  kind: "journal" | "palace" | "archive";
  /** journal: YYYY-MM-DD (validated before any path use). */
  date?: string;
  /** palace: room slug + file slug (sanitized before path.join).
   *  archive: exact on-disk filename under journal/archive/raw/ — see the
   *  "archive" branch of fetchVerbatim below for the naming allowlist. */
  room?: string;
  file?: string;
}

export interface VerbatimSource {
  found: true;
  /** Human-readable provenance, e.g. "journal/2026-06-01" or "palace/decisions/ranking". */
  source: string;
  /** Verbatim text, capped to ~1200 chars. */
  text: string;
}

/** Cap to n chars (no ellipsis — this is verbatim source, not a summary). */
const VERBATIM_CAP = 1200;
function cap(s: string): string {
  return s.length <= VERBATIM_CAP ? s : s.slice(0, VERBATIM_CAP);
}

/**
 * Resolve a verbatimKey to its raw source text. Never throws.
 * Returns null when the date is malformed, the file is absent, or a path
 * escape is detected.
 */
export function fetchVerbatim(project: string, key: VerbatimKey | undefined): VerbatimSource | null {
  if (!key) return null;
  try {
    if (key.kind === "journal") {
      if (!key.date || !/^\d{4}-\d{2}-\d{2}$/.test(key.date)) return null;
      // Identity-trust (P0 trust-class closure, 2026-08-30, wave/pipe-p0-trustclass,
      // gap #2): readJournalFile now skips rescue-tagged content by default
      // (safe-by-default, matching readTierCandidates), so a hijacked card
      // can never be attached here as a "verbatim source" for a
      // resurrect()/recall() result.
      const text = readJournalFile(project, key.date);
      if (!text) return null;
      return { found: true, source: `journal/${key.date}`, text: cap(text) };
    }

    if (key.kind === "archive") {
      // F4 (continuity wave, 2026-07-31): archive/raw/*.md dumps are named
      // `${date}--${sessionId}.md` (see archiveSession, storage/archive-write.ts)
      // — the SAME `${date}--` prefix convention smart-named journal files use.
      // This is exactly why journalDirs() no longer descends into this
      // directory implicitly (storage/paths.ts) — the "journal" branch above
      // and this "archive" branch must stay on two separate, non-colliding
      // resolution paths. `key.file` is UNTRUSTED input reaching path.join, so
      // it is allowlisted against the exact archiveSession naming convention
      // (date/hyphens/underscores + a single trailing ".md") instead of being
      // routed through sanitizeSlug, which strips dots and would corrupt the
      // ".md" extension.
      if (!key.file || !/^[A-Za-z0-9_-]+\.md$/.test(key.file)) return null;
      const p = path.join(archiveRawDir(project), key.file);

      // Defense-in-depth path-escape assertion (mirror the palace branch below).
      const root = getRoot();
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (!p.startsWith(rootWithSep) && p !== root) {
        throw new Error(`Path escape blocked: archive file=${key.file}`);
      }

      if (!fs.existsSync(p)) return null;
      const text = fs.readFileSync(p, "utf-8");
      // P0-a (2026-08-18): archive/raw is the lossless, byte-for-byte
      // verbatim tier — its ON-DISK content must stay raw (never scrubbed at
      // write time; see archive-write.ts's own contract). But this function
      // is the SURFACING BOUNDARY: its return value is attached directly to
      // a recall()/resurrect() result as `bridged[].verbatim`, so it must be
      // scrubbed HERE, at the read/return edge, not on disk. Scrub before
      // cap() so a redaction placeholder is never truncated mid-marker.
      return { found: true, source: `archive/${key.file}`, text: cap(scrubForCloud(text)) };
    }

    // palace
    if (!key.room || !key.file) return null;
    const safeRoom = sanitizeSlug(key.room);
    const safeFile = sanitizeSlug(key.file);
    const p = path.join(palaceDir(project), "rooms", safeRoom, `${safeFile}.md`);

    // Defense-in-depth path-escape assertion (mirror compress.ts 169-173).
    const root = getRoot();
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!p.startsWith(rootWithSep) && p !== root) {
      throw new Error(`Path escape blocked: room=${key.room} file=${key.file}`);
    }

    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf-8");
    // Identity-trust (pre-ship red-team fix, Break #2, 2026-09-01): mirror
    // the journal branch's readJournalFile choke above — a rescue-tagged
    // palace file must never be attached as a "verbatim source" for a
    // resurrect()/recall() result, even for a caller-specified single file.
    if (isRescueSourcedContent(text)) return null;
    return { found: true, source: `palace/${key.room}/${key.file}`, text: cap(text) };
  } catch {
    return null; // never throw into recall
  }
}
