/**
 * retrieval-candidates.test.mjs — Wave 1 (2026-08-29, plywood SOP 58053587).
 *
 * Proves `readTierCandidates()` (packages/core/src/retrieval/candidates.ts)
 * is BEHAVIORALLY EQUIVALENT (content-hash superset, per the kickoff plan's
 * exit criterion #2) to >=2 existing independent scanners for EACH tier —
 * before anything migrates to call it — plus that identity-trust tagging
 * (isRescueSourcedContent) is correctly baked into both tiers.
 *
 * "Superset" (not exact-equal) is the deliberately chosen bar: MemoryCandidate
 * carries strictly more fields than any single existing scanner returns, and
 * a couple of existing scanners apply their OWN narrower filters (e.g.
 * palace-lint.ts excludes README.md for lint-specific reasons) — so this
 * suite hashes raw file CONTENT per candidate and asserts the new reader's
 * content-hash set is a superset of each comparison scanner's own set,
 * reproducing each scanner's read logic inline (not importing its internal,
 * unexported helpers) so the comparison is genuinely independent.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const TEST_ROOT = path.join(os.tmpdir(), "ar-retrieval-candidates-" + Date.now());

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

describe("retrieval/candidates.ts — readTierCandidates", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  // ── journal tier ─────────────────────────────────────────────────────────
  describe("journal tier", () => {
    const PROJECT = "candidates-journal-demo";

    function seedJournalFixture() {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(path.join(jdir, "2026-08-27--card--live1.md"), "# live entry one\nUNIQUE_LIVE_ONE\n", "utf-8");
      fs.writeFileSync(path.join(jdir, "2026-08-28--card--live2.md"), "# live entry two\nUNIQUE_LIVE_TWO\n", "utf-8");

      const archiveDir = path.join(jdir, "archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, "2026-W01.md"), "## rollup\nUNIQUE_ROLLUP_ENTRY\n", "utf-8");

      core.archiveSession({
        project: PROJECT,
        sessionId: "raw-session-0001",
        rawTranscript: "UNIQUE_RAW_ARCHIVE_TRANSCRIPT",
      });
    }

    it("default call (no opts) is a content-hash superset of listJournalFiles(project, false)'s own reads — live files only, no rollup/raw", () => {
      seedJournalFixture();

      // Independent comparison scanner #1: helpers/journal-files.ts's
      // listJournalFiles() — the existing partial shared reader.
      const listed = core.listJournalFiles(PROJECT, false);
      const expected = new Set(
        listed.map((e) => sha256(fs.readFileSync(path.join(e.dir, e.file), "utf-8"))),
      );
      assert.ok(expected.size > 0, "sanity: fixture must produce at least one live journal file");

      const candidates = core.readTierCandidates("journal", PROJECT);
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected) {
        assert.ok(got.has(hash), `readTierCandidates("journal") missing a hash listJournalFiles(false) returned`);
      }
      // No rollup/raw leaked in by default.
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_ROLLUP_ENTRY")), "default call must NOT include rollup archive");
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "default call must NOT include raw archive");
      assert.ok(candidates.every((c) => c.sourceKind === "journal-live"), "every default candidate must be sourceKind journal-live");
    });

    it("{includeRollupArchive:true} is a content-hash superset of listJournalFiles(project, true) AND of journal-search.ts's own independent journalDirs(slug,true) scan", () => {
      seedJournalFixture();

      // Comparison scanner #1: listJournalFiles(project, true).
      const listedWithArchive = core.listJournalFiles(PROJECT, true);
      const expected1 = new Set(
        listedWithArchive.map((e) => sha256(fs.readFileSync(path.join(e.dir, e.file), "utf-8"))),
      );

      // Comparison scanner #2: journal-search.ts's OWN independent scan —
      // reproduced inline (journalDirs(slug, true) + readdirSync + .md
      // filter), since journal-search.ts's real function does its own
      // keyword-matching, not a raw file dump.
      const dirs = core.journalDirs(PROJECT, true);
      const expected2 = new Set();
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
          expected2.add(sha256(fs.readFileSync(path.join(dir, f), "utf-8")));
        }
      }
      assert.ok(expected1.size > 0 && expected2.size > 0, "sanity: fixture must produce entries in both comparisons");

      const candidates = core.readTierCandidates("journal", PROJECT, { includeRollupArchive: true });
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected1) assert.ok(got.has(hash), "missing a hash from listJournalFiles(true)");
      for (const hash of expected2) assert.ok(got.has(hash), "missing a hash from journal-search.ts's own journalDirs(true) scan");
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "includeRollupArchive must still NOT include raw archive");
    });

    it("{includeRawArchive:true} is a content-hash superset of resurrect.ts's Source-2 scan AND smart-recall.ts's archiveSearch scan (both read archiveRawDir directly)", () => {
      seedJournalFixture();

      const rawDir = core.archiveRawDir(PROJECT);
      // Both resurrect.ts's Source 2 and smart-recall.ts's archiveSearch use
      // the identical filter: readdirSync + f.endsWith(".md"), raw content.
      const expected = new Set();
      for (const f of fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"))) {
        expected.add(sha256(fs.readFileSync(path.join(rawDir, f), "utf-8")));
      }
      assert.ok(expected.size > 0, "sanity: archiveSession must have produced a raw-archive file");

      const candidates = core.readTierCandidates("journal", PROJECT, { includeRawArchive: true });
      const rawCandidates = candidates.filter((c) => c.sourceKind === "journal-archive-raw");
      const got = new Set(rawCandidates.map((c) => sha256(c.content)));
      for (const hash of expected) assert.ok(got.has(hash), "missing a hash both resurrect.ts and smart-recall.ts's raw-archive scanners would have returned");
      assert.ok(rawCandidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "raw archive content must be reachable when opted in");
    });

    it("trust-tags a rescue-sourced journal entry as untrusted:true, leaves a genuine entry untrusted:false", () => {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--genuine.md"),
        ["---", "source: hook-end", "---", "", "# genuine card", "GENUINE_UNIQUE_TERM"].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--rescued.md"),
        ["---", "source: working-memory-rescue", "---", "", "# rescued card", "RESCUED_UNIQUE_TERM"].join("\n"),
        "utf-8",
      );

      const candidates = core.readTierCandidates("journal", PROJECT);
      const genuine = candidates.find((c) => c.content.includes("GENUINE_UNIQUE_TERM"));
      const rescued = candidates.find((c) => c.content.includes("RESCUED_UNIQUE_TERM"));
      assert.ok(genuine && rescued, "both fixture files must be discoverable as candidates");
      assert.equal(genuine.untrusted, false, "a hook-end-sourced card must not be tagged untrusted");
      assert.equal(rescued.untrusted, true, "a working-memory-rescue-sourced card must be tagged untrusted");
    });
  });

  // ── palace-room tier ─────────────────────────────────────────────────────
  describe("palace-room tier", () => {
    const PROJECT = "candidates-palace-demo";

    it("is a content-hash superset of palace-search.ts's own room-content enumeration AND palace-walk.ts's readRoomContent per-file reads", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "candidates-room", "Candidates Room", "fixture room", []);
      const pd = core.palaceDir(PROJECT);
      const roomPath = path.join(pd, "rooms", "candidates-room");
      // README.md already exists (createRoom scaffolds it) — add one more topic file.
      fs.writeFileSync(path.join(roomPath, "extra-topic.md"), "### 2026-08-29 — high\nUNIQUE_TOPIC_ENTRY\n", "utf-8");
      // Also append a distinguishing marker into README.md so its content is non-trivial.
      fs.appendFileSync(path.join(roomPath, "README.md"), "\n### 2026-08-29 — medium\nUNIQUE_README_ENTRY\n", "utf-8");

      // Comparison scanner #1: palace-search.ts's own enumeration —
      // listRooms(slug) -> per-room readdirSync().filter(f.endsWith(".md")) -> readFileSync.
      // Reproduced inline since palaceSearch() itself does keyword scoring,
      // not a raw dump.
      const rooms = core.listRooms(PROJECT);
      const expected1 = new Set();
      for (const room of rooms) {
        const rp = path.join(pd, "rooms", room.slug);
        if (!fs.existsSync(rp)) continue;
        for (const f of fs.readdirSync(rp).filter((f) => f.endsWith(".md"))) {
          expected1.add(sha256(fs.readFileSync(path.join(rp, f), "utf-8")));
        }
      }

      // Comparison scanner #2: palace-walk.ts's readRoomContent — same file
      // enumeration (readdirSync().filter(f.endsWith(".md")).sort()), full
      // per-file raw content BEFORE readRoomContent's own 2000-char
      // per-file truncation/concatenation (which is a rendering-stage
      // transform, not part of "what content exists").
      const expected2 = new Set();
      for (const f of fs.readdirSync(roomPath).filter((f) => f.endsWith(".md")).sort()) {
        expected2.add(sha256(fs.readFileSync(path.join(roomPath, f), "utf-8")));
      }

      assert.ok(expected1.size >= 2 && expected2.size >= 2, "sanity: fixture must produce >=2 files (README.md + extra-topic.md)");

      const candidates = core.readTierCandidates("palace-room", PROJECT);
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected1) assert.ok(got.has(hash), "missing a hash palace-search.ts's own enumeration would have returned");
      for (const hash of expected2) assert.ok(got.has(hash), "missing a hash palace-walk.ts's readRoomContent would have returned");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_README_ENTRY")), "README.md content must be included (matches the majority-scanner INCLUSIVE behavior)");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_TOPIC_ENTRY")), "a non-README topic file must be included");
      // ensurePalaceInitialized also scaffolds the 5 default rooms, so a
      // room-unfiltered call legitimately returns candidates from those too
      // — every candidate must still carry tier:"palace-room" and SOME room,
      // but only the fixture's own two candidates must carry THIS room.
      assert.ok(candidates.every((c) => c.tier === "palace-room" && typeof c.room === "string"), "every candidate must carry tier:palace-room and a room slug");
      const thisRoomCandidates = candidates.filter((c) => c.room === "candidates-room");
      assert.equal(thisRoomCandidates.length, 2, "candidates-room must contribute exactly its own 2 files (README.md + extra-topic.md)");
    });

    it("{room: <slug>} restricts to that single room only", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "room-a", "Room A", "fixture", []);
      core.createRoom(PROJECT, "room-b", "Room B", "fixture", []);
      const pd = core.palaceDir(PROJECT);
      fs.writeFileSync(path.join(pd, "rooms", "room-a", "topic.md"), "UNIQUE_ROOM_A_MARKER\n", "utf-8");
      fs.writeFileSync(path.join(pd, "rooms", "room-b", "topic.md"), "UNIQUE_ROOM_B_MARKER\n", "utf-8");

      const candidates = core.readTierCandidates("palace-room", PROJECT, { room: "room-a" });
      assert.ok(candidates.every((c) => c.room === "room-a"), "must only return room-a candidates");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_ROOM_A_MARKER")));
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_ROOM_B_MARKER")));
    });

    it("trust-tags a rescue-sourced room file as untrusted:true, leaves a genuine room file untrusted:false", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "trust-room", "Trust Room", "fixture", []);
      const pd = core.palaceDir(PROJECT);
      const roomPath = path.join(pd, "rooms", "trust-room");
      fs.writeFileSync(
        path.join(roomPath, "genuine-topic.md"),
        ["---", "source: hook-end", "---", "", "GENUINE_ROOM_TERM"].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(roomPath, "rescued-topic.md"),
        ["---", "source: working-memory-rescue", "---", "", "RESCUED_ROOM_TERM"].join("\n"),
        "utf-8",
      );

      const candidates = core.readTierCandidates("palace-room", PROJECT, { room: "trust-room" });
      const genuine = candidates.find((c) => c.content.includes("GENUINE_ROOM_TERM"));
      const rescued = candidates.find((c) => c.content.includes("RESCUED_ROOM_TERM"));
      assert.ok(genuine && rescued, "both fixture topic files must be discoverable as candidates");
      assert.equal(genuine.untrusted, false, "a hook-end-sourced room file must not be tagged untrusted");
      assert.equal(rescued.untrusted, true, "a working-memory-rescue-sourced room file must be tagged untrusted (defense-in-depth — see harness allowlist reasoning for why this shouldn't occur via the live write path today, but the READER must not assume that forever)");
    });
  });
});
