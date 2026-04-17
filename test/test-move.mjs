import { runJxa } from "run-jxa";

const jxaGetFolderPath = `
  function getFolderPath(item) {
    var parts = [];
    var current = item;
    while (true) {
      try {
        var c = current.container();
        parts.unshift(c.name());
        current = c;
      } catch(e) { break; }
    }
    return parts.join('/');
  }
`;

const helpers = `
  function findById(app, id) {
    var rd = app.folders.whose({name: 'Recently Deleted'})[0];
    var rdIds = new Set(Array.from(rd.notes()).map(function(n) { return n.id(); }));
    return Array.from(app.notes()).filter(function(n) { return n.id() === id && !rdIds.has(n.id()); })[0];
  }
`;

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = "___MCP_MOVE_" + Date.now() + "___";

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
  const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>move test</p>'}});
  return note.id();`,
  [NOTE]
);
await sleep(2000);

// Test 1: Move to a different folder
console.log("\nTest 1: Move note to different folder...");
try {
  const result = await runJxa(
    `${jxaGetFolderPath}
    ${helpers}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const note = findById(app, args[1]);
    const originalPath = getFolderPath(note);
    const allFolders = Array.from(app.folders());
    const target = allFolders.find(f => {
      var p = getFolderPath(f) + '/' + f.name();
      return p !== originalPath && f.name() !== 'Recently Deleted';
    });
    if (!target) return JSON.stringify({skip: true});
    app.move(note, {to: target});
    delay(1);
    var newPath = getFolderPath(note);
    var targetPath = getFolderPath(target) + '/' + target.name();
    return JSON.stringify({moved: newPath !== originalPath, correct: newPath === targetPath});`,
    [NOTE, noteId]
  );
  const parsed = JSON.parse(result);
  if (parsed.skip) {
    console.log("  SKIP: only one folder available");
  } else {
    assert(parsed.moved, "Note moved from original folder");
    assert(parsed.correct, "Note in target folder");
  }
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Test 2: Invalid path detection
console.log("\nTest 2: Move to invalid path detected...");
try {
  const result = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const allFolders = Array.from(app.folders());
    const folder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === 'nonexistent/fake/path');
    return JSON.stringify({found: !!folder});`,
    []
  );
  const parsed = JSON.parse(result);
  assert(!parsed.found, "Invalid path returns not found");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// Cleanup by ID
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
