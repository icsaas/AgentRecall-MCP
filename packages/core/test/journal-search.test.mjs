// packages/core/test/journal-search.test.mjs
//
// F4 (continuity wave, 2026-07-31) — journal-search must still reach rollup
// archive/*.md entries (unchanged behavior) but must NEVER descend into
// journal/archive/raw/ (the unstructured hook-archive verbatim tier) anymore.
// That accidental "4th source" — journalDirs(slug, true) used to push
// journal/archive/raw unconditionally — is what caused raw transcript dumps
// to surface as noisy, unlabeled journal hits (reports/2026-07-31-continuity-
// fixture.md §4 Test 1). The gated, labeled replacement lives in smartRecall's
// explicit "archive" source (see smart-recall-archive-source.test.mjs).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot, journalDir, archiveSession, journalSearch } from "agent-recall-core";

const PROJECT = "journal-search-demo";

describe("journalSearch — archive scope (F4)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-jsearch-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("still finds a rollup archive/*.md entry (unchanged behavior)", async () => {
    const jdir = journalDir(PROJECT);
    const archiveDir = path.join(jdir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "2026-W01.md"),
      "## summary\nrollup mentions unique-rollup-keyword right here.\n",
      "utf-8"
    );

    const res = await journalSearch({ query: "unique-rollup-keyword", project: PROJECT });
    assert.ok(
      res.results.some((r) => r.excerpt.includes("unique-rollup-keyword")),
      `expected rollup hit, got ${JSON.stringify(res.results)}`
    );
  });

  it("does NOT find content that only exists under journal/archive/raw/ (F4 fix)", async () => {
    // Write a raw hook-archive dump containing a keyword that would ONLY be
    // found if journalSearch still (incorrectly) descended into archive/raw.
    archiveSession({
      project: PROJECT,
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      rawTranscript: "the user asked about unique-raw-only-keyword during this session",
    });

    const res = await journalSearch({ query: "unique-raw-only-keyword", project: PROJECT });
    assert.equal(
      res.results.length,
      0,
      `journalSearch must not surface raw/-only content; got ${JSON.stringify(res.results)}`
    );
  });

  it("a keyword present in BOTH a rollup entry and a raw dump only surfaces the rollup hit", async () => {
    const jdir = journalDir(PROJECT);
    const archiveDir = path.join(jdir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "2026-W02.md"),
      "## summary\ncurated note about shared-marker-term.\n",
      "utf-8"
    );
    archiveSession({
      project: PROJECT,
      sessionId: "bbbbbbbb-1111-2222-3333-444444444444",
      rawTranscript: "raw transcript noise also containing shared-marker-term",
    });

    const res = await journalSearch({ query: "shared-marker-term", project: PROJECT });
    assert.equal(res.results.length, 1, "only the curated rollup hit should surface, not the raw duplicate");
    assert.ok(res.results[0].excerpt.includes("curated note"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 3b (2026-08-30, reports/2026-08-30-pipe-w3b-migrate-report.md STEP 1)
// — equivalence guard for journalSearch's migration onto queryMemory().
// External contract `{results:[{date,section,excerpt,line}],palace_searched,
// _note?}` must be preserved exactly; section/since filtering and the
// final date-descending sort (journal-specific behavior queryMemory() itself
// has no concept of) must keep working identically to the pre-migration
// implementation.
// ─────────────────────────────────────────────────────────────────────────
describe("journalSearch — Wave 3b queryMemory() migration equivalence", () => {
  let tmpDir;
  const P = "journal-search-w3b-demo";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-jsearch-w3b-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("returns zero results (no crash) for a query with no matches anywhere — queryMemory()'s empty-items path must be handled cleanly", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--only.md"), "## note\nsomething unrelated\n", "utf-8");

    const res = await journalSearch({ query: "NONEXISTENT_TERM_XYZ", project: P });
    assert.deepEqual(res.results, [], "no matches must produce an empty array, not a crash or undefined");
    assert.equal(res.palace_searched, false);
    assert.ok(res._note, "the _note field must still be present when palace was not searched");
  });

  it("`section` filters to only the matching section — a line in a non-matching section never surfaces, even though it matches the keyword", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, "2026-08-30--card--sectioned.md"),
      ["## decisions", "we chose SECTIONFILTER_TERM for the rollout", "", "## blockers", "SECTIONFILTER_TERM is also mentioned here"].join("\n"),
      "utf-8",
    );

    const all = await journalSearch({ query: "SECTIONFILTER_TERM", project: P });
    assert.equal(all.results.length, 2, "precondition: both sections match without a section filter");

    const decisionsOnly = await journalSearch({ query: "SECTIONFILTER_TERM", project: P, section: "decisions" });
    assert.equal(decisionsOnly.results.length, 1, `expected exactly 1 result confined to the "decisions" section, got ${JSON.stringify(decisionsOnly.results)}`);
    assert.equal(decisionsOnly.results[0].section, "decisions");

    const blockersOnly = await journalSearch({ query: "SECTIONFILTER_TERM", project: P, section: "BLOCKERS" }); // case-insensitive
    assert.equal(blockersOnly.results.length, 1, "section filter must be case-insensitive, matching the pre-migration behavior");
    assert.equal(blockersOnly.results[0].section, "blockers");
  });

  it("`section` filtering does not silently under-fill below `limit` when matches beyond queryMemory()'s default per-tier cap exist", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    // 30 files, only in a NON-target section, so a naive "ask queryMemory for
    // `limit` items, THEN filter by section" implementation would starve the
    // section filter of candidates before it ever saw one of the 3 real
    // matching-section hits below (queryMemory's own default journal
    // perTierLimit is limit*1.5 when not overridden).
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(
        path.join(jdir, `2026-01-${String(i + 1).padStart(2, "0")}--card--noise${i}.md`),
        `## noise\nUNDERFILL_TERM noise entry ${i}\n`,
        "utf-8",
      );
    }
    fs.writeFileSync(
      path.join(jdir, "2026-08-30--card--target.md"),
      "## target\nUNDERFILL_TERM the one we actually want\n",
      "utf-8",
    );

    const res = await journalSearch({ query: "UNDERFILL_TERM", project: P, section: "target", limit: 5 });
    assert.equal(res.results.length, 1, `expected the single "target"-section match to survive despite 30 unrelated matches in other sections; got ${JSON.stringify(res.results)}`);
  });

  it("`since` filters out entries dated before the cutoff (byte-identical semantics to the pre-migration implementation, since both delegate to the same parseSinceDate)", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-01-01--card--old.md"), "# old\nSINCEFILTER_TERM old entry\n", "utf-8");
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--new.md"), "# new\nSINCEFILTER_TERM new entry\n", "utf-8");

    const unfiltered = await journalSearch({ query: "SINCEFILTER_TERM", project: P });
    assert.equal(unfiltered.results.length, 2, "precondition: both entries match without a since filter");

    const filtered = await journalSearch({ query: "SINCEFILTER_TERM", project: P, since: "2026-06-01" });
    assert.equal(filtered.results.length, 1, `expected only the 2026-08-30 entry to survive the since cutoff; got ${JSON.stringify(filtered.results)}`);
    assert.equal(filtered.results[0].date, "2026-08-30");
  });

  it("final ordering is date-descending, matching the pre-migration contract exactly, when total matches are within `limit`", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-01-15--card--mid.md"), "# mid\nORDERTERM middle entry\n", "utf-8");
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--newest.md"), "# newest\nORDERTERM newest entry\n", "utf-8");
    fs.writeFileSync(path.join(jdir, "2025-12-01--card--oldest.md"), "# oldest\nORDERTERM oldest entry\n", "utf-8");

    const res = await journalSearch({ query: "ORDERTERM", project: P });
    assert.equal(res.results.length, 3);
    assert.deepEqual(
      res.results.map((r) => r.date),
      ["2026-08-30", "2026-01-15", "2025-12-01"],
      `expected strict date-descending order, got ${JSON.stringify(res.results.map((r) => r.date))}`,
    );
  });

  it("CHARACTERIZED DIFF (not a silent regression): when matches exceed `limit`, the migrated implementation keeps the truly NEWEST `limit` matches — the pre-migration implementation kept an arbitrary filesystem-enumeration-order subset instead (query-memory.ts's own documented CHALLENGE (c)-2 precedent, now extended to journalSearch)", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    const dates = [];
    for (let i = 1; i <= 10; i++) dates.push(`2026-01-${String(i).padStart(2, "0")}`);
    for (const date of dates) {
      fs.writeFileSync(path.join(jdir, `${date}--card--x.md`), `# x\nTRUNCTERM entry ${date}\n`, "utf-8");
    }

    const res = await journalSearch({ query: "TRUNCTERM", project: P, limit: 3 });
    assert.equal(res.results.length, 3);
    assert.deepEqual(
      res.results.map((r) => r.date),
      ["2026-01-10", "2026-01-09", "2026-01-08"],
      `expected the 3 NEWEST dates to survive truncation, got ${JSON.stringify(res.results.map((r) => r.date))}`,
    );
  });

  it("`include_palace` still appends UNCAPPED palace matches on top of the (limit-capped) journal results, combined and re-sorted once at the end — matching the pre-migration two-phase structure exactly", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--j.md"), "# j\nCOMBOTERM journal hit\n", "utf-8");

    const { ensurePalaceInitialized, createRoom, palaceDir } = await import("agent-recall-core");
    ensurePalaceInitialized(P);
    createRoom(P, "combo-room", "Combo Room", "fixture", []);
    const roomDir = path.join(palaceDir(P), "rooms", "combo-room");
    fs.writeFileSync(path.join(roomDir, "topic.md"), "# topic\nCOMBOTERM palace hit\n", "utf-8");

    const res = await journalSearch({ query: "COMBOTERM", project: P, include_palace: true });
    assert.equal(res.palace_searched, true);
    assert.equal(res._note, undefined, "no _note when palace WAS searched");
    assert.equal(res.results.length, 2, `expected both the journal and palace hits combined; got ${JSON.stringify(res.results)}`);
    assert.ok(res.results.some((r) => r.excerpt.includes("journal hit")));
    assert.ok(res.results.some((r) => r.excerpt.includes("palace hit")));
  });

  // Independent review fix (W3b code-reviewer finding, 2026-08-30): before
  // this fix, query-memory.ts's scoreJournalTier derived each hit's
  // `QueryMemoryItem.id` from `${date} / ${section}` ALONE — not unique per
  // HIT — so applyRRF's per-tier accumulation Map (keyed by `item.id`)
  // silently collapsed TWO DISTINCT matching lines sharing the same
  // date+section into ONE surviving result, discarding the other's excerpt
  // entirely. journalSearch's PRE-migration implementation had no such
  // id/RRF grouping at all (every line match was pushed independently), so
  // this was a genuine, untested, silent data-loss regression newly exposed
  // on journalSearch's DEFAULT path by this wave's migration — caught by
  // code review, reproduced, and fixed (stableId now incorporates `line` +
  // `excerpt`, not just the coarser date/section title). This test pins it.
  it("REGRESSION GUARD: two distinct matching lines sharing the same date+section (a common real case — a verbose journal entry mentioning a term twice) BOTH survive, not just the first", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, "2026-08-30--card--dupsection.md"),
      "## notes\nDEDUPGUARD first distinct mention\nDEDUPGUARD second distinct mention\n",
      "utf-8",
    );

    const res = await journalSearch({ query: "DEDUPGUARD", project: P });
    assert.equal(res.results.length, 2, `expected BOTH distinct matches to survive; got ${JSON.stringify(res.results)}`);
    const excerpts = res.results.map((r) => r.excerpt);
    assert.ok(excerpts.some((e) => e.includes("first distinct mention")));
    assert.ok(excerpts.some((e) => e.includes("second distinct mention")));
  });

  it("REGRESSION GUARD: the same class of collision across TWO DIFFERENT FILES sharing the same date+section name also preserves both", async () => {
    const jdir = journalDir(P);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--fileone.md"), "## notes\nDEDUPGUARD2 file one mention\n", "utf-8");
    fs.writeFileSync(path.join(jdir, "2026-08-30--card--filetwo.md"), "## notes\nDEDUPGUARD2 file two mention\n", "utf-8");

    const res = await journalSearch({ query: "DEDUPGUARD2", project: P });
    assert.equal(res.results.length, 2, `expected both files' distinct matches to survive despite sharing date+section; got ${JSON.stringify(res.results)}`);
  });
});
