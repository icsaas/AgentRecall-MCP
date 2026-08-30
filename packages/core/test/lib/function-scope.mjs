// packages/core/test/lib/function-scope.mjs
//
// identity-trust-completeness harness rebuild (P0 trust-class closure,
// 2026-08-30, wave/pipe-p0-trustclass) — the unit-of-analysis upgrade this
// wave's brief calls for: WHOLE-FILE -> EXPORTED-ENTRY-FUNCTION (+ a bounded,
// explicit per-branch residual check for the handful of functions that mix a
// genuinely-safe region with a genuinely-unsafe one in the same body — see
// extractFunctionIfBranches below).
//
// WHY whole-file was the disease, not just an approximation: the ORIGINAL
// identity-trust-completeness.test.mjs's ALLOWLIST carried at least three
// entries whose safety argument was verified for ONE function in the file but
// silently applied to the WHOLE FILE, because CHOKE_PATTERN.test(fileText)
// returns true the instant *any* function anywhere in that file happens to
// call the choke:
//   - helpers/journal-files.ts was allowlisted with a reason describing
//     listJournalFiles()/hasCaptureLogs()/readRecentCaptures() (filename/
//     capture-log metadata only) — but the SAME FILE's readJournalFile()
//     returns raw file CONTENT to callers (journal-read.ts, drill-down.ts,
//     the MCP journal-resources.ts resource, the CLI's own recent-brief
//     render) with ZERO rescue-tag check. The file-level reason was TRUE for
//     3 of its exports and FALSE for a 4th — this is gap #1's date-branch and
//     gap #2, hiding in plain sight inside an already-"allowlisted" file.
//   - palace/rooms.ts's ONLY real content-adjacent function discussed in the
//     OLD reason was countRoomEntries (count-only, safe) — but the SAME FILE's
//     ensurePalaceInitialized() also matches the palace-room risk shape
//     (palaceDir()+readFileSync) and was never independently examined. Turns
//     out it's ALSO safe (a single hardcoded palace-index.json, never a room
//     .md glob) — but that had to be independently verified HERE, not
//     inherited from countRoomEntries's unrelated argument.
//   - tools-logic/session-end-reflect.ts was never in the old ALLOWLIST at
//     all specifically because one of its OTHER functions (the recent-journals
//     gatherer) already calls isRescueSourcedContent, making the whole file
//     look "already fixed" to a whole-file scan — while collectRawUnconsumed,
//     a completely separate function three functions down, reads
//     archiveRawDir() raw-archive content with zero choke call of its own
//     (verified safe here by the SAME structural argument drill-down.ts's
//     archive branch uses: distillOneSession/writeSessionCard never write to
//     archiveRawDir(), only archiveSession does — so this is a genuine,
//     independently-confirmed SAFE, not an inherited assumption).
//   - session-start.ts is the worst case: `sessionStart` itself already calls
//     isRescueSourcedContent at 3 separate read sites (today/yesterday briefs,
//     resume trajectory) — but `autoBackfill`, a SEPARATE, non-exported
//     top-level function 300+ lines further down in the SAME FILE, read BOTH
//     journal and palace-room content raw and fed it straight into
//     backfill() -> ar_entries, with NO choke call anywhere in ITS OWN body.
//     A whole-file scan sees session-start.ts's file-wide CHOKE_PATTERN hit
//     and never looks again — this is gap #5, and it is the single clearest
//     demonstration in this codebase of why "a file whose unrelated function
//     calls the trust guard is falsely certified safe" is not a hypothetical.
//
// THE FIX: parse every candidate file with the TypeScript compiler API
// (already used by ../../../mcp-server/test/lib/fence-ast.mjs — reused here
// verbatim via a relative cross-package import rather than re-implemented;
// resolves fine under this npm workspace's hoisted node_modules, see this
// wave's PR report for the standalone verification), extract every top-level
// function declaration + every class method as its own scannable unit, and
// run the SAME risk/read/choke regexes against each unit's OWN body text
// instead of the whole file. A file can now produce MULTIPLE rows in the
// completeness table — exactly what should have been happening from the
// start.
//
// ── TRUSTED WRAPPERS (mirrors fence-completeness.test.mjs's own pattern) ──
// Wave 1/2/3 of the shared retrieval pipeline deliberately routes fixes
// through a small number of shared FETCH-stage functions
// (readTierCandidates, readJournalFile, readRoomContent) rather than
// inlining an isRescueSourcedContent()/isRescueSourceTag() call at every
// call site — "a STAGE data is FORCED through, not a helper callers
// remember" (this wave's brief). A caller that routes through one of these
// is choked BY CONSTRUCTION, even though the literal string
// "isRescueSourcedContent(" never appears in the CALLER's own body text. If
// the completeness scanner didn't know this, EVERY caller of the safe
// shared readers would show hasChoke=false forever, and GREEN would be
// structurally unreachable under the new fix strategy — so, exactly as
// fence-completeness.test.mjs's own "wrapper self-check" section does for
// fenceMemory()/outputFenced()/withFenced(), this module exposes
// `isTrustedWrapperCall(text)` (checks for a literal call to one of
// TRUSTED_WRAPPER_NAMES) for callers to use ALONGSIDE a raw CHOKE_PATTERN
// test, and `wrapperSelfCheck(name)` for the completeness test file to
// independently verify — SEPARATELY, once per wrapper — that each trusted
// name's OWN implementation actually performs the safety work the trust
// depends on. Trusting a caller because it names a wrapper is only sound
// because that self-check exists and is run in the same test file.
export const TRUSTED_WRAPPER_NAMES = ["readJournalFile", "readTierCandidates", "readRoomContent"];

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFile, extractTopLevelFunction } from "../../../mcp-server/test/lib/fence-ast.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORE_SRC = path.join(__dirname, "..", "..", "src");

/** Direct, literal calls to the shared choke-point predicates. */
export const CHOKE_PATTERN = /isRescueSourcedContent\(|isRescueSourceTag\(/;

/**
 * Compute, AT TEST-RUN TIME against the REAL source tree, which of
 * TRUSTED_WRAPPER_NAMES are CURRENTLY actually safe — i.e. self-check them
 * live rather than assuming a name is forever trustworthy the moment it
 * appears in TRUSTED_WRAPPER_NAMES.
 *
 * THIS IS THE PIECE THAT MAKES THE RED/GREEN GATE WORK AT ALL: if wrapper
 * trust were a static, unconditional list, a caller of (say) readJournalFile
 * would show hasChoke=true FOREVER, including RIGHT NOW, before
 * readJournalFile has actually been taught to call isRescueSourcedContent —
 * which would make the completeness scanner blind to gap #1/#2 even in
 * today's genuinely-vulnerable codebase (verified empirically while building
 * this harness: a static trust list made journalRead/fetchVerbatim/
 * readRoomContent all show hasChoke=true BEFORE any fix was applied, purely
 * because the literal wrapper-function NAME already appears in their source
 * — the exact "class-blindness masks a real gap" failure this whole rebuild
 * exists to remove, recurring one level down through a naively-static trust
 * list). Gating trust on a LIVE self-check closes that hole: pre-fix,
 * readJournalFile's own body does not yet call isRescueSourcedContent, so
 * it is EXCLUDED from the effective trusted set, and every caller that only
 * calls readJournalFile (not a direct choke) correctly shows hasChoke=false
 * until the fix actually lands.
 */
export async function computeEffectiveTrustedWrappers() {
  const candidatesFile = path.join(CORE_SRC, "retrieval", "candidates.ts");
  const journalFilesFile = path.join(CORE_SRC, "helpers", "journal-files.ts");
  const palaceWalkFile = path.join(CORE_SRC, "tools-logic", "palace-walk.ts");
  const effective = [];

  // readTierCandidates is safe iff: it delegates to filterTrusted, AND both
  // tier readers set `untrusted` via isRescueSourcedContent, AND
  // filterTrusted itself actually drops on untrusted===true (not some other
  // condition that happens to look similar).
  const readTierText = await extractTopLevelFunction(candidatesFile, "readTierCandidates");
  const journalReaderText = await extractTopLevelFunction(candidatesFile, "readJournalCandidates");
  const palaceReaderText = await extractTopLevelFunction(candidatesFile, "readPalaceRoomCandidates");
  const filterTrustedText = await extractTopLevelFunction(candidatesFile, "filterTrusted");
  const readTierSafe = !!(
    readTierText && /\bfilterTrusted\(/.test(readTierText) &&
    journalReaderText && CHOKE_PATTERN.test(journalReaderText) &&
    palaceReaderText && CHOKE_PATTERN.test(palaceReaderText) &&
    filterTrustedText && /untrusted\s*!==\s*true/.test(filterTrustedText)
  );
  if (readTierSafe) effective.push("readTierCandidates");

  // readJournalFile is safe iff its own body directly calls the choke.
  const readJournalFileText = await extractTopLevelFunction(journalFilesFile, "readJournalFile");
  if (readJournalFileText && CHOKE_PATTERN.test(readJournalFileText)) effective.push("readJournalFile");

  // readRoomContent is safe iff it delegates to the (already-safe) readTierCandidates.
  const readRoomContentText = await extractTopLevelFunction(palaceWalkFile, "readRoomContent");
  if (readRoomContentText && /\breadTierCandidates\(/.test(readRoomContentText) && readTierSafe) {
    effective.push("readRoomContent");
  }

  return effective;
}

/** hasChoke test for one unit's body text: a direct choke call, OR a call to a name in `effectiveWrappers`. */
export function isChokedUnit(text, effectiveWrappers) {
  if (CHOKE_PATTERN.test(text)) return true;
  return effectiveWrappers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

/**
 * Walk `node` and all descendants (same tiny recursive generator
 * fence-ast.mjs uses internally, duplicated here because it is not
 * exported — small enough that copying it is cheaper and less coupled than
 * changing that file's public surface for one caller).
 */
function* walk(node, tsLib) {
  yield node;
  const children = [];
  tsLib.forEachChild(node, (c) => { children.push(c); });
  for (const c of children) yield* walk(c, tsLib);
}

/**
 * Extract every top-level (module-scope) callable UNIT in a source file:
 *   - `function name(...) {...}` / `export (async) function name(...) {...}`
 *   - every method of a top-level `class Name {...}`, id `Name.methodName`
 *   - `const name = (...) => {...}` / `export const name = async (...) => {...}`
 *     (arrow/function-expression-valued top-level const/let/var)
 * plus ONE synthetic residual unit, id `#module-scope`, covering whatever
 * top-level text is NOT inside any extracted unit (import/export
 * statements, top-level side-effecting calls, or any construct this
 * extractor does not recognize) — so a risk-pattern hit in code this
 * extractor can't classify is never silently invisible; it shows up as an
 * honestly-unresolved `#module-scope` row instead of vanishing.
 *
 * Deliberately NOT a full call-graph / control-flow walk (see this file's
 * header comment on the graceful-degradation boundary this wave's brief
 * sanctions) — this is function/method-BODY text-scan granularity, one
 * level finer than the whole-file scan it replaces, not full AST taint
 * tracking. A future wave extending this to real branch/statement-level
 * or cross-file call-graph analysis is a documented follow-up, not
 * attempted here.
 */
export async function extractTopLevelUnits(filePath) {
  const { sourceFile, text, tsLib } = await parseFile(filePath);
  const units = [];
  const coveredRanges = [];

  for (const stmt of sourceFile.statements) {
    if (tsLib.isFunctionDeclaration(stmt) && stmt.name) {
      units.push({ id: stmt.name.text, text: text.slice(stmt.pos, stmt.end) });
      coveredRanges.push([stmt.pos, stmt.end]);
    } else if (tsLib.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      for (const member of stmt.members) {
        if (tsLib.isMethodDeclaration(member) && member.name && tsLib.isIdentifier(member.name)) {
          units.push({ id: `${className}.${member.name.text}`, text: text.slice(member.pos, member.end) });
          coveredRanges.push([member.pos, member.end]);
        }
      }
      // Non-method members (fields, etc.) are not separately extracted —
      // none of this wave's target files use class field initializers for
      // content reads; documented boundary, not a silent gap for the files
      // actually in scope (verified by inspection, see PR report).
    } else if (tsLib.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          decl.initializer &&
          (tsLib.isArrowFunction(decl.initializer) || tsLib.isFunctionExpression(decl.initializer)) &&
          decl.name && tsLib.isIdentifier(decl.name)
        ) {
          units.push({ id: decl.name.text, text: text.slice(stmt.pos, stmt.end) });
          coveredRanges.push([stmt.pos, stmt.end]);
        }
      }
    }
  }

  coveredRanges.sort((a, b) => a[0] - b[0]);
  let residual = "";
  let cursor = 0;
  for (const [s, e] of coveredRanges) {
    if (s > cursor) residual += text.slice(cursor, s);
    cursor = Math.max(cursor, e);
  }
  residual += text.slice(cursor);
  if (residual.trim().length > 0) {
    units.push({ id: "#module-scope", text: residual });
  }
  return units;
}

/**
 * Given ONE already-named top-level function, split its body into named
 * REGIONS by an ordered list of `{ label, conditionPattern }` markers (each
 * matched against a top-level `if (...)` statement's CONDITION text, in
 * source order) plus a final `residual` region covering everything in the
 * function NOT claimed by a matched if-statement's then-block.
 *
 * WHY this exists (narrower than, and a documented companion to,
 * extractTopLevelUnits above): a handful of functions in this codebase mix
 * a genuinely-already-safe region with a genuinely-unsafe one in the SAME
 * function body — journalRead's `latest` vs `date` branches, journalSearch's
 * main journal loop vs its `include_palace` block, fetchVerbatim's
 * journal/archive/palace kinds. At pure function-granularity, ANY choke or
 * trusted-wrapper call ANYWHERE in the function masks an unchoked sibling
 * branch — the identical class-blindness bug this whole rebuild exists to
 * remove, recurring one level down. AST-based branch splitting (via the
 * IfStatement's own precise node boundaries, not brace-counting or
 * text-window heuristics) resolves it EXACTLY for these three named
 * functions.
 *
 * Deliberately NOT a generic "find every branch in every function"
 * mechanism — this is a small, explicit, hand-enumerated list (see this
 * wave's PR report for exactly which 3 functions need it and why) called
 * out by name at each call site, mirroring fence-ast.mjs's own
 * extractSubActions being a documented, narrower approximation one level
 * below its primary switch-case extraction. A future wave generalizing this
 * to automatic branch discovery for EVERY flagged function is a documented
 * follow-up (see this file's header), not attempted here — it would not
 * change today's scanner behavior for any function that does NOT mix safe
 * and unsafe regions, so the added complexity is not justified for this
 * pass ("do not rabbit-hole on AST").
 *
 * @returns {{ regions: Array<{label:string, text:string|null}>, residual: string } | null}
 *   null when the named function itself cannot be found (renamed/removed —
 *   caller should treat this as a hard failure, not silently skip).
 */
export async function extractFunctionIfBranches(filePath, functionName, markers) {
  const { sourceFile, text, tsLib } = await parseFile(filePath);
  let fnNode = null;
  for (const node of walk(sourceFile, tsLib)) {
    if (tsLib.isFunctionDeclaration(node) && node.name?.text === functionName) {
      fnNode = node;
      break;
    }
  }
  if (!fnNode || !fnNode.body) return null;

  // Walk the FULL function subtree (not just fnNode.body.statements) for a
  // matching IfStatement — several target functions (fetchVerbatim) nest
  // their branch dispatch one level inside a `try { ... } catch { ... }`
  // wrapper, not as a direct top-level statement of the function body.
  const regions = [];
  const matchedRanges = [];

  for (const marker of markers) {
    let found = null;
    for (const node of walk(fnNode.body, tsLib)) {
      if (tsLib.isIfStatement(node)) {
        const condText = text.slice(node.expression.pos, node.expression.end);
        if (marker.conditionPattern.test(condText)) {
          found = node;
          break;
        }
      }
    }
    if (found) {
      regions.push({ label: marker.label, text: text.slice(found.thenStatement.pos, found.thenStatement.end) });
      matchedRanges.push([found.pos, found.end]);
    } else {
      regions.push({ label: marker.label, text: null }); // marker not found — structure changed, caller must treat as a hard failure
    }
  }

  matchedRanges.sort((a, b) => a[0] - b[0]);
  let residual = "";
  let cursor = fnNode.pos;
  for (const [s, e] of matchedRanges) {
    if (s > cursor) residual += text.slice(cursor, s);
    cursor = Math.max(cursor, e);
  }
  residual += text.slice(cursor, fnNode.end);

  return { regions, residual };
}

/** Recursively list every non-`.d.ts` `.ts` file under `srcRoot` (node_modules/dist excluded). */
export function walkTsFiles(srcRoot) {
  const out = [];
  function inner(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        inner(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  }
  inner(srcRoot);
  return out;
}

/** Strip `//` and `/* *\/` comments from `text` (same simple approach fence-ast.mjs's extractSubActions uses for its own header-vs-body disambiguation) — used by the includeUntrusted escape-hatch guard so a doc-comment MENTION of the literal is never mistaken for an executable occurrence. */
export function stripComments(text) {
  return text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
