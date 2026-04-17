import { runJxa } from "run-jxa";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = "___MCP_EDIT_" + Date.now() + "___";

// Helper: find active note by ID (excludes Recently Deleted)
const helpers = `
  function findById(app, id) {
    var rd = app.folders.whose({name: 'Recently Deleted'})[0];
    var rdIds = new Set(Array.from(rd.notes()).map(function(n) { return n.id(); }));
    return Array.from(app.notes()).filter(function(n) { return n.id() === id && !rdIds.has(n.id()); })[0];
  }
  function findByName(app, name) {
    var rd = app.folders.whose({name: 'Recently Deleted'})[0];
    var rdIds = new Set(Array.from(rd.notes()).map(function(n) { return n.id(); }));
    return Array.from(app.notes()).filter(function(n) { return n.name() === name && !rdIds.has(n.id()); })[0];
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
  const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>original</p>'}});
  return note.id();`,
  [NOTE]
);
await sleep(2000);

// Test 1: Edit content preserves title
console.log("\nTest 1: Edit content preserves title...");
try {
  // Mirrors editNote logic: set body, then re-set name
  const result = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[1]);
    var newContent = args[2];
    if (newContent) {
      note.body = newContent;
      note.name = args[0];
    }
    return JSON.stringify({title: note.name(), bodyHas: note.body().includes('brand new content')});`,
    [NOTE, noteId, "<p>brand new content</p>"]
  );
  const r = JSON.parse(result);
  assert(r.bodyHas, "Content updated");
  assert(r.title === NOTE, "Title preserved after content edit");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 2: Body-only edit WITHOUT name re-set WOULD overwrite title (proves the bug)
console.log("\nTest 2: Body edit without name fix overwrites title (bug proof)...");
try {
  const result = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[1]);
    note.body = '<p>sneaky override</p>';
    return note.name();`,
    [NOTE, noteId]
  );
  // Apple Notes will have changed the title to "sneaky override"
  assert(String(result) !== NOTE, "Title overwritten by body (confirms Apple Notes behavior)");
  // Fix it back for subsequent tests
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    note.name = args[1];
    return true;`,
    [noteId, NOTE]
  );
  await sleep(1000);
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 3: No-op edit
console.log("\nTest 3: No-op edit...");
try {
  const name = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[1]);
    var t = ''; var c = '';
    if (t) note.name = t;
    if (c) note.body = c;
    return note.name();`,
    [NOTE, noteId]
  );
  assert(String(name) === NOTE, "Unchanged");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 4: Edit title
console.log("\nTest 4: Edit title...");
const RENAMED = NOTE + "_R";
try {
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[1]);
    note.name = args[0];
    return true;`,
    [RENAMED, noteId]
  );
  await sleep(1000);
  const check = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return JSON.stringify({
      renamed: !!findByName(app, args[0]),
      oldGone: !findByName(app, args[1])
    });`,
    [RENAMED, NOTE]
  );
  const p = JSON.parse(check);
  assert(p.renamed, "New title exists");
  assert(p.oldGone, "Old title gone");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Cleanup by ID — always finds the note regardless of name changes
await runJxa(
  `${helpers}
  const app = Application('Notes');
  var note = findById(app, args[0]);
  if (note) app.delete(note);
  return true;`,
  [noteId]
);

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
