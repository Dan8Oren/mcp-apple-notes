import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";
import {
  createNotesTable,
  normalizeTitle,
  dedupeByTitleAndPath,
  findMatchingNotes,
  resolveNoteReference,
  getIndexedNotes,
} from "../index.ts";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

async function assertThrows(fn, expectedSubstring, msg) {
  try {
    await fn();
    failed++;
    console.error(`  FAIL: ${msg} (did not throw)`);
  } catch (e) {
    if (expectedSubstring && !e.message.includes(expectedSubstring)) {
      failed++;
      console.error(`  FAIL: ${msg} (threw "${e.message}", expected substring "${expectedSubstring}")`);
    } else {
      passed++;
      console.log(`  PASS: ${msg}`);
    }
  }
}

const TEST_TABLE = "test-resolver-" + Date.now();
const now = new Date().toISOString();

const FIXTURE = [
  { id: "1", title: "Weekly Standup", content: "standup notes", path: "iCloud/Work", creation_date: now, modification_date: now },
  { id: "2", title: "Weekly Standup", content: "archived standup", path: "iCloud/Work/Archive", creation_date: now, modification_date: now },
  { id: "3", title: "  Meeting  NOTES  ", content: "messy title", path: "iCloud/Work", creation_date: now, modification_date: now },
  { id: "4", title: "Meeting Notes", content: "clean title", path: "iCloud/Work", creation_date: now, modification_date: now },
  { id: "5", title: "Meeting Notes Q4", content: "quarterly", path: "iCloud/Work/Archive", creation_date: now, modification_date: now },
  { id: "6", title: "Shopping List", content: "groceries", path: "iCloud/Personal", creation_date: now, modification_date: now },
  { id: "7", title: "Shopping List - Groceries", content: "detailed groceries", path: "iCloud/Personal", creation_date: now, modification_date: now },
  { id: "8", title: "Budget 2025", content: "finances", path: "iCloud/Finance", creation_date: now, modification_date: now },
  { id: "9", title: "Quarterly Budget Review", content: "budget review", path: "iCloud/Finance", creation_date: now, modification_date: now },
];

// Setup
const { notesTable } = await createNotesTable(TEST_TABLE);
await notesTable.add(FIXTURE);

// ─── normalizeTitle ──────────────────────────────────────────────

console.log("normalizeTitle tests:");

assert(normalizeTitle("Hello World") === "hello world", "basic lowercasing");
assert(normalizeTitle("  Meeting  NOTES  ") === "meeting notes", "whitespace collapse + trim");
assert(normalizeTitle("Hello, World! #2025") === "hello world 2025", "strip punctuation, keep digits");
assert(normalizeTitle("Café Résumé") === "café résumé", "unicode letters preserved");
assert(normalizeTitle("") === "", "empty string");
assert(normalizeTitle("   ") === "", "whitespace-only string");
assert(normalizeTitle("already clean") === "already clean", "no-op on clean input");

// ─── dedupeByTitleAndPath ────────────────────────────────────────

console.log("\ndedupeByTitleAndPath tests:");

const dupeInput = [
  { title: "A", path: "p1", creation_date: now, modification_date: now },
  { title: "A", path: "p1", creation_date: now, modification_date: now },
  { title: "A", path: "p2", creation_date: now, modification_date: now },
];
const deduped = dedupeByTitleAndPath(dupeInput);
assert(deduped.length === 2, "removes same title+path duplicates");
assert(deduped.some((n) => n.path === "p1") && deduped.some((n) => n.path === "p2"), "preserves different paths");

const emptyDeduped = dedupeByTitleAndPath([]);
assert(emptyDeduped.length === 0, "handles empty array");

// ─── getIndexedNotes ─────────────────────────────────────────────

console.log("\ngetIndexedNotes tests:");

const indexed = await getIndexedNotes(notesTable);
assert(indexed.length === FIXTURE.length, `returns all ${FIXTURE.length} rows (got ${indexed.length})`);
assert("title" in indexed[0] && "path" in indexed[0], "has title and path fields");
assert("creation_date" in indexed[0] && "modification_date" in indexed[0], "has date fields");
assert(!("content" in indexed[0]), "does not include content");
assert(!("vector" in indexed[0]), "does not include vector");

// ─── findMatchingNotes ───────────────────────────────────────────

console.log("\nfindMatchingNotes tests:");

const exact1 = await findMatchingNotes(notesTable, "Shopping List");
assert(exact1.exactMatches.length === 1, "exact: single match for unique title");
assert(exact1.exactMatches[0].title === "Shopping List", "exact: correct title returned");

const exact2 = await findMatchingNotes(notesTable, "Weekly Standup");
assert(exact2.exactMatches.length === 2, "exact: finds both duplicates across paths");

const scoped = await findMatchingNotes(notesTable, "Weekly Standup", "iCloud/Work");
assert(scoped.exactMatches.length === 1, "exact + path scope: narrows to one");
assert(scoped.exactMatches[0].path === "iCloud/Work", "exact + path scope: correct path");

const norm1 = await findMatchingNotes(notesTable, "meeting notes");
assert(
  norm1.normalizedMatches.length >= 2,
  `normalized: finds case/whitespace variants (got ${norm1.normalizedMatches.length})`
);
assert(
  norm1.normalizedMatches.some((n) => n.title === "  Meeting  NOTES  "),
  "normalized: includes whitespace variant"
);
assert(
  norm1.normalizedMatches.some((n) => n.title === "Meeting Notes"),
  "normalized: includes clean variant"
);

const fuzzy1 = await findMatchingNotes(notesTable, "Meeting Notes");
assert(
  fuzzy1.fuzzyMatches.some((n) => n.title === "Meeting Notes Q4"),
  "fuzzy: finds substring match"
);

const fuzzy2 = await findMatchingNotes(notesTable, "Shopping List");
assert(
  fuzzy2.fuzzyMatches.some((n) => n.title === "Shopping List - Groceries"),
  "fuzzy: finds longer title containing query"
);

const noMatch = await findMatchingNotes(notesTable, "Completely Nonexistent");
assert(noMatch.exactMatches.length === 0, "no match: exactMatches empty");
assert(noMatch.normalizedMatches.length === 0, "no match: normalizedMatches empty");
assert(noMatch.fuzzyMatches.length === 0, "no match: fuzzyMatches empty");

const scopedNoMatch = await findMatchingNotes(notesTable, "Shopping List", "iCloud/Work");
assert(scopedNoMatch.exactMatches.length === 0, "path scope filters out notes in other paths");

// ─── resolveNoteReference ────────────────────────────────────────

console.log("\nresolveNoteReference tests:");

// Single exact match
const res1 = await resolveNoteReference(notesTable, "Shopping List");
assert(res1.matchType === "exact", "single exact: matchType is exact");
assert(res1.note.title === "Shopping List", "single exact: correct note returned");

// Exact ambiguity throws
await assertThrows(
  () => resolveNoteReference(notesTable, "Weekly Standup"),
  "Multiple notes exactly match",
  "exact ambiguity: throws with message"
);

// Exact ambiguity resolved by path
const res2 = await resolveNoteReference(notesTable, "Weekly Standup", "iCloud/Work");
assert(res2.matchType === "exact", "path resolves ambiguity: matchType is exact");
assert(res2.note.path === "iCloud/Work", "path resolves ambiguity: correct path");

// Falls through to normalized match (query in different case, no exact match)
const res3 = await resolveNoteReference(notesTable, "SHOPPING LIST");
assert(res3.matchType === "normalized", "normalized fallthrough: matchType is normalized");
assert(res3.note.title === "Shopping List", "normalized fallthrough: correct note");

// Normalized ambiguity throws (both "  Meeting  NOTES  " and "Meeting Notes" normalize the same)
await assertThrows(
  () => resolveNoteReference(notesTable, "meeting notes"),
  "Multiple notes closely match",
  "normalized ambiguity: throws"
);

// Normalized ambiguity resolved by path - scope to just one of the normalized matches
// "  Meeting  NOTES  " is at iCloud/Work, "Meeting Notes" is also at iCloud/Work — both match
// Need a path that only has one: neither is in Archive, so let's query with exact title instead
// Actually test: "BUDGET 2025" normalizes to "budget 2025" -> matches "Budget 2025" uniquely
const res3b = await resolveNoteReference(notesTable, "BUDGET 2025");
assert(res3b.matchType === "normalized", "single normalized: unique match after normalization");
assert(res3b.note.title === "Budget 2025", "single normalized: correct note");

// Falls through to fuzzy match - "Quarterly Budget" doesn't exact/normalized match anything,
// but fuzzy-matches "Quarterly Budget Review" (query is substring of title)
const res4 = await resolveNoteReference(notesTable, "Quarterly Budget");
assert(res4.matchType === "fuzzy", "fuzzy fallthrough: matchType is fuzzy");
assert(res4.note.title === "Quarterly Budget Review", "fuzzy fallthrough: correct note");

// Fuzzy ambiguity throws - "Shopping" fuzzy matches both "Shopping List" and "Shopping List - Groceries"
await assertThrows(
  () => resolveNoteReference(notesTable, "Shopping"),
  "ambiguous",
  "fuzzy ambiguity: throws"
);

// Not found throws
await assertThrows(
  () => resolveNoteReference(notesTable, "Completely Nonexistent Title XYZ"),
  "No note matched",
  "not found: throws"
);

// Not found with suggestions (token match) - "Budget" token matches "Budget 2025"
await assertThrows(
  () => resolveNoteReference(notesTable, "Budget Projection"),
  "No note matched",
  "not found with partial token overlap: throws with message"
);

// Not found with path scope
await assertThrows(
  () => resolveNoteReference(notesTable, "Shopping List", "iCloud/Work"),
  "No note matched",
  "not found in scoped path: throws"
);

// ─── Cleanup ─────────────────────────────────────────────────────

try {
  const db = await lancedb.connect(path.join(os.homedir(), ".mcp-apple-notes", "data"));
  await db.dropTable(TEST_TABLE);
} catch (_) {}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.on("uncaughtException", () => {});
process.exit(failed > 0 ? 1 : 0);
