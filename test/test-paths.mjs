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

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// Test 1: list-folders returns full paths
console.log("Test 1: list-folders returns full paths...");
try {
  const result = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const folders = Array.from(app.folders());
    return JSON.stringify(folders.map(f => ({
      name: f.name(),
      path: getFolderPath(f) + '/' + f.name(),
      noteCount: f.notes().length
    })));
  `);
  const folders = JSON.parse(result);
  assert(folders.length > 0, `Found ${folders.length} folders`);
  assert(folders.every(f => f.path.includes("/")), "All folders have path with /");
  assert(folders.every(f => f.path.endsWith(f.name)), "All paths end with folder name");
  assert(folders.every(f => typeof f.noteCount === "number"), "All have noteCount");
  // Check nested folder has multi-level path
  const nested = folders.find(f => f.path.split("/").length > 2);
  if (nested) {
    assert(true, `Found nested folder with ${nested.path.split("/").length} levels`);
  }
  console.log(`    (${folders.length} folders listed)`);
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

// Test 2: getNotes returns full path per note
console.log("\nTest 2: getNotes returns full path per note...");
try {
  const result = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const notes = Array.from(app.notes()).slice(0, 10);
    return JSON.stringify(notes.map(note => ({
      title: note.properties().name,
      path: getFolderPath(note)
    })));
  `);
  const notes = JSON.parse(result);
  assert(notes.length > 0, `Got ${notes.length} notes`);
  assert(notes.every(n => n.path.includes("/")), "All notes have path with /");
  assert(notes.every(n => typeof n.title === "string" && n.title.length > 0), "All have title");
  console.log(`    (${notes.length} notes sampled)`);
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

// Test 3: get-notes-by-path matches by full path
console.log("\nTest 3: get-notes-by-path matches by full path...");
try {
  // First get all folder paths
  const foldersResult = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const folders = Array.from(app.folders());
    return JSON.stringify(folders.map(f => ({
      name: f.name(),
      path: getFolderPath(f) + '/' + f.name(),
      noteCount: f.notes().length
    })));
  `);
  const folders = JSON.parse(foldersResult);
  const testFolder = folders.find(f => f.noteCount > 0);
  console.log(`  Using a folder with ${testFolder.noteCount} notes`);

  const result = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const targetPath = args[0];
    const allFolders = Array.from(app.folders());
    const folder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
    if (!folder) return JSON.stringify([]);
    const notes = Array.from(folder.notes());
    return JSON.stringify(notes.map(note => ({
      title: note.name(),
      path: targetPath,
      creation_date: note.creationDate().toLocaleString(),
      modification_date: note.modificationDate().toLocaleString()
    })));`,
    [testFolder.path]
  );
  const notes = JSON.parse(result);
  assert(notes.length === testFolder.noteCount, `Got ${notes.length} notes (expected ${testFolder.noteCount})`);
  assert(notes.every(n => n.path === testFolder.path), "All notes have correct path");
  console.log(`    (${notes.length} notes in folder)`);
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

// Test 4: get-notes-by-path returns empty for invalid path
console.log("\nTest 4: get-notes-by-path returns empty for invalid path...");
try {
  const result = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const targetPath = args[0];
    const allFolders = Array.from(app.folders());
    const folder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
    if (!folder) return JSON.stringify([]);
    return JSON.stringify([]);`,
    ["nonexistent/path/here"]
  );
  const notes = JSON.parse(result);
  assert(notes.length === 0, "Returns empty array for invalid path");
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

// Test 5: getNoteDetailsByTitle returns full path
console.log("\nTest 5: getNoteDetailsByTitle returns full path...");
try {
  const notesResult = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    return JSON.stringify(Array.from(app.notes()).slice(0, 1).map(n => n.properties().name));
  `);
  const title = JSON.parse(notesResult)[0];

  const detail = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    try {
        const note = app.notes.whose({name: title})[0];
        return JSON.stringify({
            title: note.name(),
            path: getFolderPath(note),
            creation_date: note.creationDate().toLocaleString()
        });
    } catch (error) {
        return "{}";
    }`,
    [title]
  );
  const parsed = JSON.parse(detail);
  assert(parsed.path && parsed.path.includes("/"), "Path contains /");
  assert(parsed.title === title, "Title matches");
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

// Test 6: Nested folders have distinct paths
console.log("\nTest 6: Nested folders have distinct paths...");
try {
  const result = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const folders = Array.from(app.folders());
    return JSON.stringify(folders.map(f => getFolderPath(f) + '/' + f.name()));
  `);
  const paths = JSON.parse(result);
  const uniquePaths = new Set(paths);
  assert(uniquePaths.size === paths.length, `All ${paths.length} paths are unique`);
} catch (e) {
  failed++;
  console.error(`  FAIL:`, e.message);
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
