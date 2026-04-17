import { runJxa } from "run-jxa";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = "___MCP_DEL_" + Date.now() + "___";

const helpers = `
  function findById(app, id) {
    var rd = app.folders.whose({name: 'Recently Deleted'})[0];
    var rdIds = new Set(Array.from(rd.notes()).map(function(n) { return n.id(); }));
    return Array.from(app.notes()).filter(function(n) { return n.id() === id && !rdIds.has(n.id()); })[0];
  }
`;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// Create and capture ID
console.log("Setup: creating test note...");
const noteId = await runJxa(
  `const app = Application('Notes');
  const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>delete test</p>'}});
  return note.id();`,
  [NOTE]
);
await sleep(2000);

// Verify created
const exists = await runJxa(
  `${helpers}
  const app = Application('Notes');
  return !!findById(app, args[0]);`,
  [noteId]
);
assert(exists === true, "Test note created");

// Test 1: Delete note
console.log("\nTest 1: Delete note...");
try {
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    app.delete(note);
    return true;`,
    [noteId]
  );
  await sleep(1000);
  const stillActive = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return !!findById(app, args[0]);`,
    [noteId]
  );
  assert(stillActive === false, "Note deleted (moved to Recently Deleted)");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 2: Delete non-existent note throws
console.log("\nTest 2: Delete non-existent note throws...");
try {
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    if (!note) throw new Error('not found');
    app.delete(note);
    return true;`,
    ["x-coredata://fake-id-that-does-not-exist"]
  );
  failed++;
  console.error("  FAIL: Should have thrown");
} catch (e) {
  assert(true, "Throws for non-existent note");
}

// No extra cleanup needed — test 1 already deleted to Recently Deleted

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
