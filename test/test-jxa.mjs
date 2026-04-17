import { runJxa } from "run-jxa";

// Test 1: List notes
console.log("Test 1: Listing notes...");
try {
  const notes = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const notes = Array.from(app.notes());
    const titles = notes.map(note => note.properties().name);
    return titles;
  `);
  console.log(`  OK - Found ${notes.length} notes`);
} catch (e) {
  console.error(`  FAIL:`, e.message);
}

// Test 2: Get note details (using first note title)
console.log("\nTest 2: Get note by title...");
try {
  const notes = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const notes = Array.from(app.notes());
    return notes.map(note => note.properties().name);
  `);

  const title = notes[0];

  const note = await runJxa(
    `const app = Application('Notes');
    const title = args[0];

    try {
        const note = app.notes.whose({name: title})[0];

        const noteInfo = {
            title: note.name(),
            content: note.body().substring(0, 100),
            creation_date: note.creationDate().toLocaleString(),
            modification_date: note.modificationDate().toLocaleString()
        };

        return JSON.stringify(noteInfo);
    } catch (error) {
        return "{}";
    }`,
    [title]
  );
  const parsed = JSON.parse(note);
  console.log(`  OK: note retrieved (${parsed.content ? "has content" : "empty"})`);
} catch (e) {
  console.error(`  FAIL:`, e.message);
}

console.log("\nAll tests done.");
