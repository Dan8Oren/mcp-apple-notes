import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";
import { LanceSchema } from "@lancedb/lancedb/embedding";
import { Utf8 } from "apache-arrow";
import {
  createNotesTable,
  OnDeviceEmbeddingFunction,
  searchAndCombineResults,
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

const TEST_TABLE = "test-notes-" + Date.now();

// Test 1: Create table
console.log("Test 1: Create notes table...");
try {
  const { notesTable } = await createNotesTable(TEST_TABLE);
  assert(!!notesTable, "Table created");
  const count = await notesTable.countRows();
  assert(typeof count === "number", "Can count rows");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 2: Add note and vector search
console.log("\nTest 2: Add note and vector search...");
try {
  const { notesTable } = await createNotesTable(TEST_TABLE);
  await notesTable.add([
    {
      id: "1",
      title: "Meeting Notes",
      content: "Discussed project roadmap and quarterly goals",
      path: "iCloud/Work",
      creation_date: new Date().toISOString(),
      modification_date: new Date().toISOString(),
    },
    {
      id: "2",
      title: "Grocery List",
      content: "Apples bananas oranges grapes strawberries watermelon",
      path: "iCloud/Personal",
      creation_date: new Date().toISOString(),
      modification_date: new Date().toISOString(),
    },
  ]);

  const results = await searchAndCombineResults(notesTable, "quarterly goals roadmap");
  assert(results.length > 0, "Returns search results");
  assert(
    results.some((r) => r.title === "Meeting Notes"),
    "Finds the relevant note in results"
  );
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 3: Search with path filter
console.log("\nTest 3: Search with path filter...");
try {
  const { notesTable } = await createNotesTable(TEST_TABLE);
  const results = await searchAndCombineResults(notesTable, "project roadmap", {
    path: "iCloud/Personal",
  });
  assert(
    !results.some((r) => r.path === "iCloud/Work"),
    "Filters out non-matching paths"
  );
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 4: Search with limit
console.log("\nTest 4: Search with limit...");
try {
  const { notesTable } = await createNotesTable(TEST_TABLE);
  const results = await searchAndCombineResults(notesTable, "notes", {
    limit: 1,
  });
  assert(results.length <= 1, `Respects limit (got ${results.length})`);
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Cleanup: drop test table
try {
  const db = await lancedb.connect(
    path.join(os.homedir(), ".mcp-apple-notes", "data")
  );
  await db.dropTable(TEST_TABLE);
} catch (_) {}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
// Force exit — importing index.ts starts the MCP stdio server which keeps the process alive.
// The LanceDB mutex error on exit is cosmetic and safe to suppress.
process.on("uncaughtException", () => {});
process.exit(failed > 0 ? 1 : 0);
