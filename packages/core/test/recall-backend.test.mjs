// packages/core/test/recall-backend.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("RecallBackend interface", () => {
  it("LocalRecallBackend is always available", async () => {
    const { LocalRecallBackend } = await import("agent-recall-core");
    const backend = new LocalRecallBackend();
    assert.equal(backend.available(), true);
  });

  it("getRecallBackend returns a local backend when no Supabase config", async () => {
    const { setRoot, resetRoot } = await import("agent-recall-core");
    const { getRecallBackend, LocalRecallBackend, LocalVectorRecallBackend, resetRecallBackend } = await import("agent-recall-core");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-backend-"));
    setRoot(tmpDir);
    resetRecallBackend();
    const backend = await getRecallBackend();
    // keyword backend (no OPENAI_API_KEY) or vector backend (OPENAI_API_KEY set) — both are local
    assert.ok(
      backend instanceof LocalRecallBackend || backend instanceof LocalVectorRecallBackend,
      `Expected local backend, got ${backend?.constructor?.name}`
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
    resetRecallBackend();
  });
});

// ── P0 independent-review FIX 2 (2026-08-30) ────────────────────────────────
// `SupabaseRecallBackend.search()` itself requires a live Supabase client +
// embedding provider — this repo has no dependency-injection seam for
// either, so constructing a live backend here is out of scope (the
// P0-trust-class-closure report already flagged this gap honestly). Instead,
// this exercises `mapSemanticRows`/`mapFtsRows` — the pure row->
// RecallResultItem mappers `search()` itself delegates to (extracted
// specifically for this test, see recall-backend.ts's own header comment) —
// with a HAND-CONSTRUCTED row matching the REAL on-wire shape: `metadata` is
// where `doSync()`'s `parseMemoryFile()` preserves a file's frontmatter
// (`source: working-memory-rescue`) after SPLITTING it out of `body` before
// upload — `body` itself never carries the tag, so a row's rescue-ness is
// only ever visible via `metadata.source`.
describe("P0 review-fix (FIX 2) — mapSemanticRows/mapFtsRows drop a rescue-tagged Supabase row, keep a genuine one", () => {
  function rescueRow(id) {
    return {
      id,
      store: "journal",
      slug: "rescue-slug",
      title: "HIJACKED_SUPABASE_ROW_TITLE",
      body: "HIJACKED_SUPABASE_ROW_BODY — body never carries the source: tag (parseMemoryFile strips it)",
      similarity: 0.99, // deliberately the HIGHEST score — would rank #1 if not dropped
      metadata: { source: "working-memory-rescue" },
    };
  }

  function genuineRow(id) {
    return {
      id,
      store: "journal",
      slug: "genuine-slug",
      title: "GENUINE_SUPABASE_ROW_TITLE",
      body: "GENUINE_SUPABASE_ROW_BODY",
      similarity: 0.5,
      metadata: { source: "hook-end" },
    };
  }

  it("mapSemanticRows: drops a metadata.source:working-memory-rescue row (even at the top similarity score); keeps a genuine row", async () => {
    const { mapSemanticRows } = await import("agent-recall-core");
    const rows = [rescueRow("rescue-1"), genuineRow("genuine-1")];
    const items = mapSemanticRows(rows);
    assert.ok(!items.some((i) => i.id === "rescue-1"), `a rescue-tagged row must never appear in mapSemanticRows' output, at any rank; got ${JSON.stringify(items)}`);
    assert.ok(items.some((i) => i.id === "genuine-1"), "a genuine (non-rescue) row must still pass through");
    const genuine = items.find((i) => i.id === "genuine-1");
    assert.equal(genuine.title, "GENUINE_SUPABASE_ROW_TITLE");
  });

  it("mapFtsRows: drops a metadata.source:working-memory-rescue row; keeps a genuine row", async () => {
    const { mapFtsRows } = await import("agent-recall-core");
    const rows = [rescueRow("rescue-2"), genuineRow("genuine-2")];
    const items = mapFtsRows(rows);
    assert.ok(!items.some((i) => i.id === "rescue-2"), `a rescue-tagged row must never appear in mapFtsRows' output; got ${JSON.stringify(items)}`);
    assert.ok(items.some((i) => i.id === "genuine-2"), "a genuine (non-rescue) row must still pass through");
  });

  it("a row with NO metadata.source at all (legacy pre-rescue-mechanism content) is treated as genuine, not dropped", async () => {
    const { mapSemanticRows } = await import("agent-recall-core");
    const legacyRow = { id: "legacy-1", store: "journal", slug: "legacy-slug", title: "LEGACY_ROW", body: "no metadata.source field", similarity: 0.7, metadata: {} };
    const items = mapSemanticRows([legacyRow]);
    assert.ok(items.some((i) => i.id === "legacy-1"), "a row with no source tag at all must not be dropped — 'absent tag => trusted' is the shipped, intentional default");
  });
});
