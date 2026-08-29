/**
 * retrieval/candidates.ts — Wave 1 of the shared retrieval pipeline
 * (reports/2026-08-21-architecture-review.md §4, reports/2026-08-29-kickoff-plan.md §2,
 * plywood SOP 58053587).
 *
 * THE PROBLEM THIS FILE FIXES: the journal and palace-room storage tiers each
 * have MANY independent `readdir`+`readFileSync` scanners (9+ for journal,
 * ~10 for palace-room content — see this file's own header comment sections
 * below for the enumerated class), each deciding filtering/trust/scoping
 * independently. Per the architecture review: "a directory-scanning,
 * tokenizing, trust-tagging, or scoping boundary decided independently, once
 * per surface, with no single place that decision has to be made correctly
 * exactly once" is the actual root cause behind the L1/L2/redteam findings.
 *
 * THIS WAVE (1 of ~4-5): build ONE typed candidate reader per tier, with
 * identity-trust tagging baked in at read time (not deferred to a caller
 * that might forget it, per CRITICAL-1's "3 prior waves each missed
 * same-class members" lesson). `tier` is an ENUMERATED table entry
 * (`TIER_READERS` below) — adding a future tier (e.g. `"palace-pipeline"`,
 * see the CHALLENGE note below) is a new ROW, never a new branch.
 *
 * WAVE 1 SCOPE, EXPLICIT: this module is purely ADDITIVE. Zero existing call
 * site (`journalSearch`, `smartRecall`, `palaceSearch`, `resurrect`,
 * `sessionStart`, etc.) is touched or imports from here yet — that migration
 * is Wave 2+ (`retrieval/pipeline.ts`'s `queryMemory()`). This file only adds
 * a new, unused-by-anyone-yet reader, so it carries zero behavior-change
 * risk for any live surface.
 *
 * ── CHALLENGE outcome: does `tier` need a 3rd value for palace/pipeline? ──
 * The kickoff plan invited this challenge explicitly. Verdict: NO, not this
 * wave — `palace/pipeline/` (numbered `NNNN-slug.md` milestone files with
 * `phase`/`order`/`status`/`opened`/`closed` frontmatter, read via
 * `palace/pipeline.ts`'s `listMilestones()`/`parseMilestoneFile()`) is
 * structurally a DIFFERENT shape from `palace/rooms/<slug>/*.md` (no
 * `_room.json`, no `listRooms()` entry point, no salience/access-count
 * metadata, a different frontmatter schema entirely) — forcing it through
 * the SAME `"palace-room"` reader would be lossy, not a clean fit. It is a
 * genuine sibling tier and deserves its own `"palace-pipeline"` table row in
 * a later wave (architecture review P10 names this explicitly: "CONFIRM
 * this explicitly, don't assume" — confirmed here: it does NOT ride in for
 * free, a dedicated reader is still needed). Tier stays exactly
 * `"journal" | "palace-room"` for Wave 1, matching the task's literal scope.
 *
 * ── W2 INDEPENDENT-REVIEW FIX (2026-08-30): the leaf-utility-vs-pipeline-
 * stage anti-pattern, moved one level down ──
 * `readTierCandidates` is exported (this file's header above literally tells
 * a future surface to call it), but Wave 2's `queryMemory()` pipeline is the
 * ONLY thing that historically applied a trust filter to its output — a
 * naive caller of this function directly got raw, unfiltered rescue-tagged
 * content back, reopening CRITICAL-2. Fixed by making this reader SAFE BY
 * DEFAULT (`ReadTierCandidatesOpts.includeUntrusted`, default `false`, drops
 * `untrusted === true` before returning) and promoting the trust predicate
 * itself (`filterTrusted`, below) to a public, canonical export — the SAME
 * implementation `queryMemory()`'s own trust-filter stage now delegates to,
 * not a forked second copy. See retrieval/query-memory.ts's header for how
 * the pipeline's own stage stays intact around this change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { journalDir, archiveRawDir, palaceDir } from "../storage/paths.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { isRescueSourcedContent, extractFrontmatterSource } from "../helpers/journal-filter.js";
import { listRooms } from "../palace/rooms.js";

/**
 * Enumerated storage tiers `readTierCandidates` knows how to read. A future
 * tier is a new value here + a new `TIER_READERS` row — never a new
 * per-tier function (class-not-instance; see this file's own header).
 */
export type MemoryTier = "journal" | "palace-room";

/**
 * Distinguishes WHICH on-disk source produced a candidate, even within the
 * same declared `tier` — e.g. a `"journal"` tier candidate can come from the
 * live/rollup-archive journal directory (safe-by-default, always included)
 * or from the raw hook-archive verbatim tier (opt-in only, historically
 * gated behind smart-recall's explicit low-confidence "archive" source —
 * see `journalDirs()`'s own doc comment in storage/paths.ts for the
 * "accidental 4th journal source" incident this distinction preserves).
 */
export type CandidateSourceKind =
  | "journal-live"
  | "journal-rollup-archive"
  | "journal-archive-raw"
  | "palace-room";

/**
 * The typed unit every future retrieval surface will consume. Trust and
 * provenance are properties OF the candidate, computed once here — never
 * re-derived per surface (architecture review §4.1: "trust, staleness, and
 * scope become properties of the type, checked once by the pipeline").
 */
export interface MemoryCandidate {
  /** Raw file content (or, for a raw-archive candidate, the raw transcript dump). Never pre-scrubbed/truncated here — that is a rendering-boundary concern for a later stage, not the fetch stage. */
  content: string;
  /** Which enumerated tier this candidate was read from. */
  tier: MemoryTier;
  /** Project slug this candidate belongs to (assumed already resolved by the caller — this function does not call resolveProject). */
  project: string;
  /**
   * Best-effort ISO date (YYYY-MM-DD) for this candidate. **Semantics differ
   * by `tier` — this is NOT one consistent notion of "date" across the
   * type**, and a future consumer that compares/sorts across tiers must not
   * assume otherwise (independent review fix, 2026-08-29, plywood SOP
   * 58053587 — flagged as under-documented at the type level, only present
   * inline per-reader before this fix):
   *
   * - `tier: "journal"` — the FILENAME's date prefix (`YYYY-MM-DD--...`,
   *   or the leading `YYYY-MM-DD` match on an archive filename). This is the
   *   date the entry was AUTHORED/FILED, fixed at write time, independent of
   *   any later edit.
   * - `tier: "palace-room"` — the file's `mtime` (falling back to
   *   `RoomMeta.updated` if `stat()` fails), because room files carry no
   *   per-file authored-date of their own (rooms are living documents that
   *   get appended/edited in place — see `countRoomEntries`'s own
   *   per-entry-not-per-file granularity note in `palace/rooms.ts`). This is
   *   the date the file was LAST MODIFIED, which can drift forward every
   *   time an entry is added to an existing room file — the opposite
   *   stability property from the journal tier's fixed filename date.
   *
   * Empty string when undeterminable for either tier.
   */
  date: string;
  /** Absolute filesystem path this candidate was read from — the provenance field every caller needs for backlink resolution, dedup, or audit. */
  sourcePath: string;
  /** Basename of `sourcePath`. */
  file: string;
  /** Finer-grained provenance within `tier` — see `CandidateSourceKind`. */
  sourceKind: CandidateSourceKind;
  /**
   * True when this candidate's content carries the rescue-quarantine
   * provenance tag (`helpers/journal-filter.ts`'s `isRescueSourcedContent` —
   * an unauthenticated, self-claimed `cwd` majority-vote rather than a
   * verified identity signal). Computed HERE, inside the reader, so every
   * future consumer of `readTierCandidates` inherits trust-tiering for
   * free — this is the whole point of Wave 1 folding trust-tagging into the
   * same commit as the reader rather than deferring it (CRITICAL-1's "3
   * prior waves each missed same-class members" failure pattern).
   */
  untrusted: boolean;
  /**
   * The RAW frontmatter `source:` value this candidate's content carries
   * (e.g. `"hook-end"`, `"working-memory-rescue"`), via
   * `helpers/journal-filter.ts`'s `extractFrontmatterSource` — the same
   * value `untrusted` above is derived FROM (`isRescueSourceTag(sourceTag)`),
   * kept alongside it rather than reduced away.
   *
   * Independent review fix (2026-08-29, plywood SOP 58053587): `untrusted`
   * answers one cheap binary question ("is this rescue-sourced") and every
   * existing/near-term consumer should keep using it for that. `sourceTag`
   * preserves the full provenance string so a LATER wave's finer
   * trust/supersession stage (e.g. distinguishing multiple non-rescue
   * `source` values, or a future tag this file's author hasn't invented yet)
   * can branch on it WITHOUT re-parsing frontmatter per surface — exactly
   * the anti-pattern (independent re-parsing at each retrieval surface)
   * this whole module exists to kill. `undefined` when the candidate has no
   * frontmatter block, or no `source:` field within it (e.g. a legacy file
   * predating the frontmatter convention) — the SAME "absent" case
   * `isRescueSourceTag(undefined)` already treats as `false`/trusted, so
   * `untrusted` and `sourceTag` never disagree about a missing tag.
   */
  sourceTag?: string;
  /**
   * Forward-compatible bag for already-parsed frontmatter fields a LATER
   * wave's score stage will consume instead of re-parsing frontmatter per
   * surface (independent review fix, 2026-08-29, plywood SOP 58053587 —
   * the kickoff plan named a `scoreInputs` field this shipped type omitted;
   * CHALLENGED and resolved as `meta`, see this file's own PR report for the
   * full reasoning). Deliberately a `Record<string,string>` bag, not a typed
   * struct with named fields (`tag`/`salience`/…): Wave 1's reader parses
   * NOTHING from frontmatter beyond `source` (already surfaced via
   * `sourceTag` above) — it has no basis to invent a schema for fields it
   * doesn't read, and a fixed struct would force this wave to guess Wave 2's
   * scoring inputs rather than let Wave 2 add fields incrementally without
   * changing `MemoryCandidate`'s shape each time. THE READER'S JOB IS FETCH,
   * NOT SCORING: this field exists so a future frontmatter-field addition
   * has somewhere to land without re-opening this type — it is NOT a place
   * to pre-compute scores, salience, or ranking signals. Left `undefined`
   * on every candidate this wave (no call site below sets it) — a real,
   * documented "possibly-empty-now" placeholder, not a silently-broken
   * promise.
   */
  meta?: Record<string, string>;
  /** Room slug — present only for `tier: "palace-room"` candidates. */
  room?: string;
}

/** Options narrowing/widening what `readTierCandidates` reads within a tier. */
export interface ReadTierCandidatesOpts {
  /**
   * journal tier only. When true, also includes `journal/archive/*.md`
   * (rollup-archived entries) — matches `journalDirs(project, true)` /
   * `listJournalFiles(project, true)`'s existing `includeArchive` semantics.
   * Default false (matches `journalDirs`'s own safety default: counting
   * paths must not be inflated by archived entries).
   */
  includeRollupArchive?: boolean;
  /**
   * journal tier only. When true, ALSO includes `journal/archive/raw/*.md`
   * (the lossless, unstructured hook-archive verbatim tier) as
   * `sourceKind: "journal-archive-raw"` candidates. This is the tier
   * `journalDirs()`'s own doc comment says must NEVER be silently folded in
   * — "any caller that intentionally wants raw/ content should use
   * archiveRawDir(project) directly". Default false, preserving that
   * safety property: a caller must opt in explicitly to see raw-archive
   * candidates, same as every existing consumer of this tier does today
   * (resurrect.ts Source 2, smart-recall.ts's archiveSearch fallback).
   */
  includeRawArchive?: boolean;
  /**
   * palace-room tier only. When set, restricts to a single room slug
   * (matches `palaceSearch`'s `input.room` filter). Omit to read every
   * room.
   */
  room?: string;
  /**
   * Independent review fix (W2, 2026-08-30, reports/2026-08-29-pipe-w2-query-report.md):
   * `readTierCandidates` is a PUBLIC, exported function — a future surface
   * author calling it directly (as this file's own header instructs future
   * Wave 3+ migrations to do) got raw candidates back with `untrusted` as a
   * mere FIELD, no filtering applied, reopening the exact CRITICAL-2
   * rescue-quarantine injection gap this whole retrieval-pipeline effort
   * exists to close — just one function further down than `queryMemory()`.
   *
   * Default `false` (the safe, naive-caller default): every candidate whose
   * `untrusted` flag is exactly `true` is dropped via `filterTrusted` BEFORE
   * this function returns. A candidate with `untrusted === undefined` is
   * treated as trusted (kept) — `filterTrusted` only drops `=== true`, never
   * "anything not explicitly false". A candidate that carries a `sourceTag`
   * but is NOT untrusted is UNAFFECTED — `sourceTag` is a down-tier/
   * attribution axis, never a drop axis; dropping those would lose genuine,
   * merely-attributed content.
   *
   * Set `true` only when the caller has its own reason to see untrusted
   * candidates and will apply its own trust decision afterward — e.g.
   * `queryMemory()`'s own mandatory TRUST-FILTER pipeline stage (see
   * retrieval/query-memory.ts), which calls this with `includeUntrusted:
   * true` and then explicitly re-applies `filterTrusted` itself as a
   * separate, still-mandatory stage — preserving both "no bypassable
   * stage" AND this reader's own safe-by-default boundary.
   */
  includeUntrusted?: boolean;
}

/**
 * Canonical trust-filter: drops every candidate whose `untrusted` flag is
 * exactly `true`. A candidate with `untrusted === undefined` (never actually
 * produced by `readTierCandidates`'s own readers today, which always set a
 * boolean, but defensive for any future non-reader-produced MemoryCandidate)
 * is treated as trusted and kept — only a literal `true` drops.
 *
 * THE single implementation both `readTierCandidates`'s own safe-by-default
 * filtering AND `queryMemory()`'s mandatory TRUST-FILTER pipeline stage
 * delegate to (independent review fix, W2, 2026-08-30) — do not fork a
 * second copy of this predicate.
 */
export function filterTrusted(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates.filter((c) => c.untrusted !== true);
}

function safeReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null; // unreadable/missing file — never throw, caller skips it
  }
}

/**
 * journal tier — consolidates the ~5 independent journal-archive-raw
 * scanners (resurrect.ts Source 2, smart-recall.ts's archiveSearch,
 * session-end-reflect.ts's collectRawUnconsumed, store-doctor.ts ×2
 * filename-only scans) with `helpers/journal-files.ts`'s existing
 * `listJournalFiles()` as the live/rollup-archive half (per the kickoff
 * plan's "fold in listJournalFiles() as the live-file half"). See this
 * module's own PR report for the full scanner enumeration table.
 */
function readJournalCandidates(project: string, opts: ReadTierCandidatesOpts): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const primaryDir = journalDir(project);

  // ---- live half (delegates to the existing shared reader) ----
  // Deliberately called with includeArchive=false here — see the rollup-
  // archive half below for why archive/ is scanned independently rather
  // than via listJournalFiles(project, true).
  const entries = listJournalFiles(project, false);
  for (const entry of entries) {
    const sourcePath = path.join(entry.dir, entry.file);
    const content = safeReadFile(sourcePath);
    if (content === null) continue;
    out.push({
      content,
      tier: "journal",
      project,
      date: entry.date,
      sourcePath,
      file: entry.file,
      sourceKind: "journal-live",
      untrusted: isRescueSourcedContent(content),
      sourceTag: extractFrontmatterSource(content),
    });
  }

  // ---- opt-in rollup-archive half ----
  // NOT delegated to listJournalFiles(project, true): that path requires a
  // leading YYYY-MM-DD date match on every filename (its `dateMatch` guard),
  // which silently drops a week-summary-shaped file (`YYYY-Wnn.md`) living
  // in archive/ — exactly the shape journal-search.test.mjs's own fixture
  // uses and journal-search.ts's independent raw scan (readdirSync +
  // f.endsWith(".md"), NO date-match requirement) correctly picks up. This
  // divergence was found empirically while proving behavioral equivalence
  // (retrieval-candidates.test.mjs) — listJournalFiles() and journal-search.ts
  // are NOT strictly equivalent for archive/ content today. Scanning archive/
  // independently here, matching journal-search.ts's broader (no-date-match)
  // filter, is what makes this reader an honest superset of BOTH existing
  // scanners rather than silently inheriting the narrower one's gap.
  if (opts.includeRollupArchive) {
    const archiveDir = path.join(primaryDir, "archive");
    let archiveFiles: string[] = [];
    try {
      archiveFiles = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".md"));
    } catch {
      archiveFiles = []; // missing/unreadable archive dir — treat as empty, never throw
    }
    // Independent review fix (MEDIUM-1, W2, 2026-08-30): build this half into
    // its own array and sort it date-descending BEFORE appending to `out` —
    // same pattern the live half above already gets for free from
    // `listJournalFiles()`'s own `entries.sort((a,b) => b.date.localeCompare(a.date))`.
    // Without this, `archiveFiles` is in raw `readdirSync` enumeration order
    // (filesystem-dependent, not date order), so a downstream consumer that
    // truncates before fully consuming this half (e.g. query-memory.ts's
    // `scoreJournalTier` perTierLimit break) would keep an arbitrary
    // enumeration-order subset instead of the newest archived entries — the
    // exact "sort-before-truncate" bug class this fix closes for the archive
    // half, matching what the live half already had.
    const archiveCandidates: MemoryCandidate[] = [];
    for (const file of archiveFiles) {
      const sourcePath = path.join(archiveDir, file);
      const content = safeReadFile(sourcePath);
      if (content === null) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      archiveCandidates.push({
        content,
        tier: "journal",
        project,
        date: dateMatch ? dateMatch[1] : "",
        sourcePath,
        file,
        sourceKind: "journal-rollup-archive",
        untrusted: isRescueSourcedContent(content),
        sourceTag: extractFrontmatterSource(content),
      });
    }
    archiveCandidates.sort((a, b) => b.date.localeCompare(a.date));
    out.push(...archiveCandidates);
  }

  // ---- opt-in raw-archive half (the previously-unconsolidated 5 scanners) ----
  if (opts.includeRawArchive) {
    const dir = archiveRawDir(project);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md");
    } catch {
      files = []; // missing/unreadable raw-archive dir — treat as empty, never throw
    }
    for (const file of files) {
      const sourcePath = path.join(dir, file);
      const content = safeReadFile(sourcePath);
      if (content === null) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      out.push({
        content,
        tier: "journal",
        project,
        date: dateMatch ? dateMatch[1] : "",
        sourcePath,
        file,
        sourceKind: "journal-archive-raw",
        untrusted: isRescueSourcedContent(content),
        sourceTag: extractFrontmatterSource(content),
      });
    }
  }

  return out;
}

/**
 * palace-room tier — net-new; no existing function to copy (`palace/rooms.ts`
 * exports metadata only: `listRooms`/`getRoomMeta`/`countRoomEntries`, no
 * content reader). Matches the INCLUSIVE behavior most existing scanners
 * agree on (README.md counts as real room content — countRoomEntries's own
 * doc comment: "both README.md's '## Memories' section and any topic
 * files"): palace-search.ts, palace-walk.ts's readRoomContent,
 * journal-search.ts's include_palace branch, and session-start.ts's
 * autoBackfill all include README.md. A minority (palace-lint.ts, check.ts's
 * alignment-room scanner, palace/fan-out.ts's auto-link keyword scan)
 * exclude README.md/_room.json for their own narrower, non-retrieval
 * purposes (linting the topic files only; keyword-linking heuristics) — see
 * this module's own PR report for the full scanner enumeration table and
 * why those are narrower special-purpose scans, not full content readers.
 */
function readPalaceRoomCandidates(project: string, opts: ReadTierCandidatesOpts): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const pd = palaceDir(project);
  const allRooms = listRooms(project);
  const rooms = opts.room ? allRooms.filter((r) => r.slug === opts.room) : allRooms;

  for (const roomMeta of rooms) {
    const roomPath = path.join(pd, "rooms", roomMeta.slug);
    let files: string[] = [];
    try {
      if (!fs.existsSync(roomPath)) continue;
      files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // unreadable room dir — skip, never throw
    }
    for (const file of files) {
      const sourcePath = path.join(roomPath, file);
      const content = safeReadFile(sourcePath);
      if (content === null) continue;
      let date = "";
      try {
        date = fs.statSync(sourcePath).mtime.toISOString().slice(0, 10);
      } catch {
        date = (roomMeta.updated ?? "").slice(0, 10);
      }
      out.push({
        content,
        tier: "palace-room",
        project,
        date,
        sourcePath,
        file,
        sourceKind: "palace-room",
        untrusted: isRescueSourcedContent(content),
        sourceTag: extractFrontmatterSource(content),
        room: roomMeta.slug,
      });
    }
  }

  return out;
}

/**
 * Class-not-instance table: one row per enumerated tier. Extending coverage
 * (a future `"palace-pipeline"` tier, see this file's header CHALLENGE note)
 * is a new row here, never a new branch in `readTierCandidates` itself.
 */
const TIER_READERS: {
  [K in MemoryTier]: (project: string, opts: ReadTierCandidatesOpts) => MemoryCandidate[];
} = {
  journal: readJournalCandidates,
  "palace-room": readPalaceRoomCandidates,
};

/**
 * Read every candidate for one tier of one project, with identity-trust
 * tagging (`untrusted`) already computed. This is the SOLE function future
 * retrieval surfaces should call instead of touching `journalDirs()`/
 * `listRooms()`/raw `readdirSync` directly (Wave 2+ migration).
 *
 * SAFE BY DEFAULT (independent review fix, W2, 2026-08-30): unless
 * `opts.includeUntrusted` is `true`, every `untrusted === true` candidate is
 * dropped here, before returning — see `ReadTierCandidatesOpts.includeUntrusted`'s
 * own doc comment for the full reasoning. A direct caller that never learns
 * about `untrusted` at all still gets trusted-only content, closing the
 * public escape hatch around `queryMemory()`'s own trust-filter stage.
 */
export function readTierCandidates(
  tier: MemoryTier,
  project: string,
  opts: ReadTierCandidatesOpts = {},
): MemoryCandidate[] {
  const candidates = TIER_READERS[tier](project, opts);
  return opts.includeUntrusted ? candidates : filterTrusted(candidates);
}
