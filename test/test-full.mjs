import { runJxa } from "run-jxa";
import { pipeline } from "@huggingface/transformers";
import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";
import TurndownService from "turndown";

console.log("1. Testing TurndownService...");
const td = new TurndownService();
const md = td.turndown("<h1>Hello</h1><p>World</p>");
console.log(`   OK: "${md}"`);

console.log("2. Testing LanceDB connection...");
const db = await lancedb.connect(path.join(os.homedir(), ".mcp-apple-notes", "data"));
console.log("   OK: connected");

console.log("3. Testing embedding model...");
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const output = await extractor("test", { pooling: "mean" });
console.log(`   OK: ${output.data.length} dims`);

console.log("4. Testing JXA note listing...");
const notes = await runJxa(`
  const app = Application('Notes');
  app.includeStandardAdditions = true;
  const notes = Array.from(app.notes());
  return notes.map(note => note.properties().name);
`);
console.log(`   OK: ${notes.length} notes`);

console.log("5. Testing JXA note detail fetch...");
const title = notes[0].replace(/[\\'"]/g, "\\$&");
const detail = await runJxa(
  `const app = Application('Notes');
  const title = "${title}";
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
  }`
);
console.log(`   OK: "${JSON.parse(detail).title}"`);

console.log("\nAll tests passed!");
