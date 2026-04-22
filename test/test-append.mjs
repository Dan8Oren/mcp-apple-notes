import { runJxa } from "run-jxa";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = "___MCP_APPEND_" + Date.now() + "___";
const DUP_NOTE = "___MCP_APPEND_DUP_" + Date.now() + "___";

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
  ${jxaGetFolderPath}
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

// ─── Test 1: Basic append preserves title and body ───────────────

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

// Cleanup test 1
await runJxa(
  `${helpers}
  const app = Application('Notes');
  var note = findById(app, args[0]);
  if (note) app.delete(note);
  return true;`,
  [noteId]
);

// ─── Test 2: Append without path to unique note (regression) ─────

console.log("\nTest 2: Append without path to uniquely-titled note...");
const uniqueNote = "___MCP_APPEND_UNIQUE_" + Date.now() + "___";
let uniqueId;
try {
  uniqueId = await runJxa(
    `const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>base</p>'}});
    return note.id();`,
    [uniqueNote]
  );
  await sleep(1500);

  // Append without any path — mirrors appendToNote(title, content) with no folderPath
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const title = args[0];
    const note = Array.from(app.notes()).find(function(n) {
      return n.name() === title;
    });
    if (!note) throw new Error('Note not found');
    note.body = note.body() + args[1];
    note.name = title;
    return true;`,
    [uniqueNote, "<p>appended-no-path</p>"]
  );

  const check = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return JSON.stringify({
      hasBase: note.body().includes('base'),
      hasAppend: note.body().includes('appended-no-path')
    });`,
    [uniqueId]
  );
  const parsed = JSON.parse(check);
  assert(parsed.hasBase, "Original content preserved (no path)");
  assert(parsed.hasAppend, "Appended content present (no path)");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}
// Cleanup
if (uniqueId) {
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    var note = findById(app, args[0]);
    if (note) app.delete(note);
    return true;`,
    [uniqueId]
  );
}

// ─── Test 3: Path-scoped append targets correct duplicate ────────

console.log("\nTest 3: Path-scoped append to correct note among duplicates...");

// Find two distinct folders
const foldersRaw = await runJxa(
  `${jxaGetFolderPath}
  const app = Application('Notes');
  const folders = Array.from(app.folders()).filter(function(f) {
    return f.name() !== 'Recently Deleted';
  });
  return JSON.stringify(folders.map(function(f) {
    return getFolderPath(f) + '/' + f.name();
  }));`
);
const folders = JSON.parse(foldersRaw);

if (folders.length < 2) {
  console.log("  SKIP: Need at least 2 folders for path-scoped test");
} else {
  const folderA = folders[0];
  const folderB = folders[1];
  let dupIdA, dupIdB;

  try {
    // Create two notes with identical title in different folders
    dupIdA = await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>folderA-content</p>'}});
      const allFolders = Array.from(app.folders());
      const target = allFolders.find(function(f) {
        return getFolderPath(f) + '/' + f.name() === args[1];
      });
      if (target) app.move(note, {to: target});
      return note.id();`,
      [DUP_NOTE, folderA]
    );

    dupIdB = await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>folderB-content</p>'}});
      const allFolders = Array.from(app.folders());
      const target = allFolders.find(function(f) {
        return getFolderPath(f) + '/' + f.name() === args[1];
      });
      if (target) app.move(note, {to: target});
      return note.id();`,
      [DUP_NOTE, folderB]
    );
    await sleep(2000);

    // Append ONLY to the note in folderB, using path scoping
    await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const title = args[0];
      const folderPath = args[1];
      const content = args[2];
      const note = Array.from(app.notes()).find(function(n) {
        return n.name() === title && getFolderPath(n) === folderPath;
      });
      if (!note) throw new Error('Note not found in path: ' + folderPath);
      note.body = note.body() + content;
      note.name = title;
      return true;`,
      [DUP_NOTE, folderB, "<p>scoped-marker</p>"]
    );

    // Verify folderB note has the marker
    const checkB = await runJxa(
      `${helpers}
      const app = Application('Notes');
      const note = findById(app, args[0]);
      return JSON.stringify({
        hasMarker: note.body().includes('scoped-marker'),
        hasOriginal: note.body().includes('folderB-content')
      });`,
      [dupIdB]
    );
    const parsedB = JSON.parse(checkB);
    assert(parsedB.hasMarker, "Path-scoped append: target note has appended content");
    assert(parsedB.hasOriginal, "Path-scoped append: target note kept original content");

    // Verify folderA note does NOT have the marker
    const checkA = await runJxa(
      `${helpers}
      const app = Application('Notes');
      const note = findById(app, args[0]);
      return JSON.stringify({
        hasMarker: note.body().includes('scoped-marker'),
        hasOriginal: note.body().includes('folderA-content')
      });`,
      [dupIdA]
    );
    const parsedA = JSON.parse(checkA);
    assert(!parsedA.hasMarker, "Path-scoped append: other note was NOT modified");
    assert(parsedA.hasOriginal, "Path-scoped append: other note kept its content");
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${e.message}`);
  }

  // Cleanup duplicates
  for (const id of [dupIdA, dupIdB].filter(Boolean)) {
    await runJxa(
      `${helpers}
      const app = Application('Notes');
      var note = findById(app, args[0]);
      if (note) app.delete(note);
      return true;`,
      [id]
    );
  }
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
