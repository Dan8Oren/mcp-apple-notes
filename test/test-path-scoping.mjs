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

// ─── Setup: find two folders ─────────────────────────────────────

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
  console.log("SKIP: Need at least 2 folders for path-scoping tests. Only found: " + folders.join(", "));
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: 0 passed, 0 failed (skipped)`);
  process.exit(0);
}

const folderA = folders[0];
const folderB = folders[1];

async function createNoteInFolder(title, body, folderPath) {
  const id = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {name: args[0], body: args[1]}});
    const allFolders = Array.from(app.folders());
    const target = allFolders.find(function(f) { return getFolderPath(f) + '/' + f.name() === args[2]; });
    if (target) app.move(note, {to: target});
    return note.id();`,
    [title, body, folderPath]
  );
  cleanupIds.push(id);
  return id;
}

// ─── Test 1: Path-scoped edit targets correct note ───────────────

console.log("Test 1: Path-scoped edit targets correct note...");
const EDIT_NOTE = "___MCP_SCOPE_EDIT_" + TS + "___";
try {
  const editIdA = await createNoteInFolder(EDIT_NOTE, "<p>editA-original</p>", folderA);
  const editIdB = await createNoteInFolder(EDIT_NOTE, "<p>editB-original</p>", folderB);
  await sleep(2000);

  // Edit only the note in folderA using path scoping
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const title = args[0];
    const path = args[1];
    const newContent = args[2];
    const note = Array.from(app.notes()).find(function(n) {
      return n.name() === title && getFolderPath(n) === path;
    });
    if (!note) throw new Error('Note not found in path: ' + path);
    note.body = newContent;
    note.name = title;
    return true;`,
    [EDIT_NOTE, folderA, "<p>editA-MODIFIED</p>"]
  );

  // Verify A was edited
  const checkA = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return JSON.stringify({
      hasModified: note.body().includes('editA-MODIFIED'),
      hasOriginal: note.body().includes('editA-original')
    });`,
    [editIdA]
  );
  const parsedA = JSON.parse(checkA);
  assert(parsedA.hasModified, "Scoped edit: target note has new content");
  assert(!parsedA.hasOriginal, "Scoped edit: target note lost old content (replaced)");

  // Verify B was NOT edited
  const checkB = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return note.body().includes('editB-original');`,
    [editIdB]
  );
  assert(checkB === true, "Scoped edit: other note was NOT modified");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 2: Path-scoped edit with wrong path fails ──────────────

console.log("\nTest 2: Path-scoped edit with non-existent path fails...");
const EDIT_BAD = "___MCP_SCOPE_EDIT_BAD_" + TS + "___";
try {
  const badId = await createNoteInFolder(EDIT_BAD, "<p>exists</p>", folderA);
  await sleep(1500);

  let threwNotFound = false;
  try {
    await runJxa(
      `${helpers}
      const app = Application('Notes');
      const note = Array.from(app.notes()).find(function(n) {
        return n.name() === args[0] && getFolderPath(n) === args[1];
      });
      if (!note) throw new Error('Note not found');
      return true;`,
      [EDIT_BAD, "iCloud/Nonexistent/Path"]
    );
  } catch (e) {
    threwNotFound = e.message.includes("not found") || e.message.includes("Not found");
  }
  assert(threwNotFound, "Wrong path: throws not found");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 3: Path-scoped delete removes only targeted note ───────

console.log("\nTest 3: Path-scoped delete removes only targeted note...");
const DEL_NOTE = "___MCP_SCOPE_DEL_" + TS + "___";
try {
  const delIdA = await createNoteInFolder(DEL_NOTE, "<p>delA</p>", folderA);
  const delIdB = await createNoteInFolder(DEL_NOTE, "<p>delB</p>", folderB);
  await sleep(2000);

  // Delete only the note in folderB using path scoping
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const title = args[0];
    const folderPath = args[1];
    const note = Array.from(app.notes()).find(function(n) {
      return n.name() === title && getFolderPath(n) === folderPath;
    });
    if (!note) throw new Error('Note not found');
    app.delete(note);
    return true;`,
    [DEL_NOTE, folderB]
  );
  await sleep(1000);

  // Verify B is gone
  const bExists = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return !!findById(app, args[0]);`,
    [delIdB]
  );
  assert(bExists === false, "Scoped delete: target note deleted");

  // Verify A still exists
  const aExists = await runJxa(
    `${helpers}
    const app = Application('Notes');
    return !!findById(app, args[0]);`,
    [delIdA]
  );
  assert(aExists === true, "Scoped delete: other note still exists");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 4: Path-scoped move targets correct note ───────────────

console.log("\nTest 4: Path-scoped move targets correct note...");
const MOVE_NOTE = "___MCP_SCOPE_MV_" + TS + "___";
try {
  const moveIdA = await createNoteInFolder(MOVE_NOTE, "<p>moveA</p>", folderA);
  const moveIdB = await createNoteInFolder(MOVE_NOTE, "<p>moveB</p>", folderB);
  await sleep(2000);

  // Move the one in folderA to folderB, using path scoping
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const title = args[0];
    const sourcePath = args[1];
    const targetPath = args[2];
    const allFolders = Array.from(app.folders());
    const targetFolder = allFolders.find(function(f) {
      return getFolderPath(f) + '/' + f.name() === targetPath;
    });
    if (!targetFolder) throw new Error('Target folder not found');
    const note = Array.from(app.notes()).find(function(n) {
      return n.name() === title && getFolderPath(n) === sourcePath;
    });
    if (!note) throw new Error('Source note not found in path');
    app.move(note, {to: targetFolder});
    return true;`,
    [MOVE_NOTE, folderA, folderB]
  );
  await sleep(1500);

  // Verify the moved note is now in folderB
  const movedPath = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return getFolderPath(note);`,
    [moveIdA]
  );
  assert(String(movedPath) === folderB, `Scoped move: note moved to target folder (got ${movedPath})`);

  // Verify the other note in folderB is unaffected
  const otherPath = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return getFolderPath(note);`,
    [moveIdB]
  );
  assert(String(otherPath) === folderB, "Scoped move: other note still in its folder");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
}

// ─── Test 5: No-path operation on unique title (regression) ──────

console.log("\nTest 5: No-path edit on uniquely-titled note succeeds...");
const UNIQUE_NOTE = "___MCP_SCOPE_UNIQUE_" + TS + "___";
try {
  const uniqueId = await createNoteInFolder(UNIQUE_NOTE, "<p>unique-original</p>", folderA);
  await sleep(1500);

  // Edit without path — should find and edit the unique note
  await runJxa(
    `${helpers}
    const app = Application('Notes');
    const title = args[0];
    const note = Array.from(app.notes()).find(function(n) {
      return n.name() === title;
    });
    if (!note) throw new Error('Note not found');
    note.body = args[1];
    note.name = title;
    return true;`,
    [UNIQUE_NOTE, "<p>unique-edited</p>"]
  );

  const check = await runJxa(
    `${helpers}
    const app = Application('Notes');
    const note = findById(app, args[0]);
    return note.body().includes('unique-edited');`,
    [uniqueId]
  );
  assert(check === true, "No-path edit on unique title: content updated");
} catch (e) {
  failed++;
  console.error(`  FAIL: ${e.message}`);
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
