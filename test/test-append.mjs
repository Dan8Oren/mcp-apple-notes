import { runJxa } from "run-jxa";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = "___MCP_APPEND_" + Date.now() + "___";

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

console.log("Setup: creating test note...");
const noteId = await runJxa(
  `const app = Application('Notes');
  const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>alpha</p>'}});
  return note.id();`,
  [NOTE]
);
await sleep(2000);

console.log("\nTest 1: Append content preserves title and existing body...");
try {
  const result = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    const originalBody = note.body();
    note.body = originalBody + args[1];
    note.name = args[2];
    return JSON.stringify({
      title: note.name(),
      hasOriginal: note.body().includes('alpha'),
      hasAppend: note.body().includes('omega'),
      appendAfterOriginal: note.body().indexOf('alpha') < note.body().indexOf('omega')
    });`,
    [noteId, "<p>omega</p>", NOTE]
  );
  const parsed = JSON.parse(result);
  assert(parsed.title === NOTE, "Title preserved after append");
  assert(parsed.hasOriginal, "Original body content kept");
  assert(parsed.hasAppend, "Appended body content present");
  assert(parsed.appendAfterOriginal, "New content appended to the end");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

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
