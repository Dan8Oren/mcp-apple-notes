import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";
import { createNotesTable, indexNotes, mapWithConcurrency } from "../index.ts";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── mapWithConcurrency ──────────────────────────────────────────

console.log("\nmapWithConcurrency");

{
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 4, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(20 - i); // later items finish first
    inFlight--;
    return i * 2;
  });
  assert(maxInFlight === 4, `never more than 4 in flight (saw ${maxInFlight})`);
  assert(
    results.every((r, i) => r === i * 2),
    "results keep input order"
  );
}

{
  const results = await mapWithConcurrency([], 4, async () => 1);
  assert(Array.isArray(results) && results.length === 0, "empty input returns []");
}

{
  const results = await mapWithConcurrency([1, 2], 8, async (i) => i);
  assert(results.length === 2, "limit larger than input is fine");
}

// ─── indexNotes against real Apple Notes ─────────────────────────

console.log("\nindexNotes (real Apple Notes)");

const TEST_TABLE = "test-index-notes";
const { notesTable } = await createNotesTable(TEST_TABLE);
const result = await indexNotes(notesTable);
console.log(
  `  indexed ${result.chunks}/${result.allNotes} notes in ${(result.time / 1000).toFixed(1)}s`
);
assert(result.allNotes > 0, "found notes in the library");
assert(result.chunks === result.allNotes, "every note was indexed");
assert(result.report === "", "no per-note errors reported");
assert((await notesTable.countRows()) === result.chunks, "table row count matches");

// ─── Cleanup ─────────────────────────────────────────────────────

try {
  const db = await lancedb.connect(path.join(os.homedir(), ".mcp-apple-notes", "data"));
  await db.dropTable(TEST_TABLE);
} catch (_) {}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.on("uncaughtException", () => {});
process.exit(failed > 0 ? 1 : 0);
