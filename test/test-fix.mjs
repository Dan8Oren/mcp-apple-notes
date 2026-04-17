import { runJxa } from "run-jxa";

const problemTitles = [
  '"feature_limitation_rule": {',
  '{"_id": "6d5edc49-76f4-4247-80a4-ef714286508f"',
  'First issue is that on `User selects a body part (e.g. mouth)` the…',
];

for (const title of problemTitles) {
  console.log(`Testing: ${title.substring(0, 50)}...`);
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
    const parsed = JSON.parse(note);
    console.log(`  OK: ${parsed.title ? "found" : "not found (empty)"}\n`);
  } catch (e) {
    console.error(`  FAIL: ${e.message}\n`);
  }
}

console.log("All problem titles handled without crashes.");
