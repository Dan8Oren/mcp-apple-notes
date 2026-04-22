import { runJxa } from "run-jxa";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TS = Date.now();

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
  function findByName(app, name) {
    var rd = app.folders.whose({name: 'Recently Deleted'})[0];
    var rdIds = new Set(Array.from(rd.notes()).map(function(n) { return n.id(); }));
    return Array.from(app.notes()).filter(function(n) { return n.name() === name && !rdIds.has(n.id()); });
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

const cleanupIds = [];

// ─── Test 1: Upsert creates note when missing ───────────────────

console.log("Test 1: Upsert creates note when missing...");
const UPSERT_NEW = "___MCP_UPSERT_NEW_" + TS + "___";
try {
  // Verify note does not exist
  const preCheck = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return findByName(app, args[0]).length;`,
    [UPSERT_NEW]
  );
  assert(preCheck === 0, "Note does not exist before upsert");

  // Create (the "create" path of upsert)
  const newId = await runJxa(
    `const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: args[1]}});
    return note.id();`,
    [UPSERT_NEW, "<p>upsert-created</p>"]
  );
  cleanupIds.push(newId);
  await sleep(1500);

  const check = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return JSON.stringify({
      title: note.name(),
      hasContent: note.body().includes('upsert-created')
    });`,
    [newId]
  );
  const parsed = JSON.parse(check);
  assert(parsed.title === UPSERT_NEW, "Created note has correct title");
  assert(parsed.hasContent, "Created note has expected content");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 2: Upsert appends to existing note when found ─────────

console.log("\nTest 2: Upsert appends to existing note when found...");
const UPSERT_EXIST = "___MCP_UPSERT_EXIST_" + TS + "___";
try {
  const existId = await runJxa(
    `const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>original</p>'}});
    return note.id();`,
    [UPSERT_EXIST]
  );
  cleanupIds.push(existId);
  await sleep(1500);

  // "Upsert" finds the note, so it appends
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const matches = findByName(app, args[0]);
    if (matches.length !== 1) throw new Error('Expected 1 match, got ' + matches.length);
    const note = matches[0];
    note.body = note.body() + args[1];
    note.name = args[0];
    return true;`,
    [UPSERT_EXIST, "<p>upserted-append</p>"]
  );

  const check = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return JSON.stringify({
      hasOriginal: note.body().includes('original'),
      hasAppend: note.body().includes('upserted-append'),
      appendAfterOriginal: note.body().indexOf('original') < note.body().indexOf('upserted-append')
    });`,
    [existId]
  );
  const parsed = JSON.parse(check);
  assert(parsed.hasOriginal, "Existing content preserved");
  assert(parsed.hasAppend, "Appended content present");
  assert(parsed.appendAfterOriginal, "Append is after original");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 3: Upsert detects ambiguous match ──────────────────────

console.log("\nTest 3: Upsert detects ambiguous match (multiple same-titled notes)...");
const UPSERT_AMB = "___MCP_UPSERT_AMB_" + TS + "___";
let ambId1, ambId2;
try {
  ambId1 = await runJxa(
    `const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>amb-1</p>'}});
    return note.id();`,
    [UPSERT_AMB]
  );
  ambId2 = await runJxa(
    `const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>amb-2</p>'}});
    return note.id();`,
    [UPSERT_AMB]
  );
  cleanupIds.push(ambId1, ambId2);
  await sleep(1500);

  const matchCount = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return findByName(app, args[0]).length;`,
    [UPSERT_AMB]
  );
  assert(matchCount >= 2, `Ambiguity detected: ${matchCount} notes with same title`);

  // Attempting to upsert should detect ambiguity (not blindly pick one)
  let threwOnAmbiguity = false;
  try {
    await runJxa(
      `${helpers}
      const app = Application('Notes');
      const matches = findByName(app, args[0]);
      if (matches.length > 1) throw new Error('Ambiguous: ' + matches.length + ' notes match');
      return true;`,
      [UPSERT_AMB]
    );
  } catch (e) {
    threwOnAmbiguity = e.message.includes("Ambiguous");
  }
  assert(threwOnAmbiguity, "Upsert throws on ambiguous title match");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 4: Upsert with folder scoping resolves ambiguity ───────

console.log("\nTest 4: Upsert with folder scoping resolves ambiguity...");

// Get available folders
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
  console.log("  SKIP: Need at least 2 folders for scoped upsert test");
} else {
  const UPSERT_SCOPED = "___MCP_UPSERT_SCOPED_" + TS + "___";
  const folderA = folders[0];
  const folderB = folders[1];
  let scopedIdA, scopedIdB;

  try {
    // Create duplicate-titled notes in two folders
    scopedIdA = await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>scoped-A</p>'}});
      const allFolders = Array.from(app.folders());
      const target = allFolders.find(function(f) { return getFolderPath(f) + '/' + f.name() === args[1]; });
      if (target) app.move(note, {to: target});
      return note.id();`,
      [UPSERT_SCOPED, folderA]
    );
    scopedIdB = await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const note = app.make({new: 'note', withProperties: {name: args[0], body: '<p>scoped-B</p>'}});
      const allFolders = Array.from(app.folders());
      const target = allFolders.find(function(f) { return getFolderPath(f) + '/' + f.name() === args[1]; });
      if (target) app.move(note, {to: target});
      return note.id();`,
      [UPSERT_SCOPED, folderB]
    );
    cleanupIds.push(scopedIdA, scopedIdB);
    await sleep(2000);

    // Upsert scoped to folderB — should append only to that note
    await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      const title = args[0];
      const folderPath = args[1];
      const note = Array.from(app.notes()).find(function(n) {
        return n.name() === title && getFolderPath(n) === folderPath;
      });
      if (!note) throw new Error('Not found in path');
      note.body = note.body() + args[2];
      note.name = title;
      return true;`,
      [UPSERT_SCOPED, folderB, "<p>scoped-upsert-marker</p>"]
    );

    // Verify B has the marker
    const checkB = await runJxa(
      `${helpers}
      const app = Application('Notes');
      const note = findById(app, args[0]);
      return note.body().includes('scoped-upsert-marker');`,
      [scopedIdB]
    );
    assert(checkB === true, "Scoped upsert: target note has appended content");

    // Verify A does NOT have the marker
    const checkA = await runJxa(
      `${helpers}
      const app = Application('Notes');
      const note = findById(app, args[0]);
      return note.body().includes('scoped-upsert-marker');`,
      [scopedIdA]
    );
    assert(checkA === false, "Scoped upsert: other note was NOT modified");
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${e.message}`);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────

for (const id of cleanupIds) {
  try {
    await runJxa(
      `${helpers}
      const app = Application('Notes');
      var note = findById(app, args[0]);
      if (note) app.delete(note);
      return true;`,
      [id]
    );
  } catch (_) {}
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
