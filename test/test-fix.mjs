import { runJxa } from "run-jxa";

// Titles with special characters that previously caused JXA injection errors
const problemTitles = [
  '"some_json_key": {',
  '{"_id": "abc-123-def-456"',
  "Issue with `backticks` in title…",
];

let passed = 0;
let failed = 0;

for (const title of problemTitles) {
  const truncated = title.substring(0, 30) + (title.length > 30 ? "..." : "");
  process.stdout.write(`Testing special chars (${truncated})... `);
  try {
    const note = await runJxa(
      `const app = Application('Notes');
      const title = args[0];
      try {
          const note = app.notes.whose({name: title})[0];
          const noteInfo = {
              title: note.name(),
              content: note.body().substring(0, 50),
              creation_date: note.creationDate().toLocaleString(),
              modification_date: note.modificationDate().toLocaleString()
          };
          return JSON.stringify(noteInfo);
      } catch (error) {
          return "{}";
      }`,
      [title]
    );
    JSON.parse(note); // should not throw
    passed++;
    console.log("PASS (no crash)");
  } catch (e) {
    failed++;
    console.log(`FAIL: ${e.message}`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
