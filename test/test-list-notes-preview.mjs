// Verifies the contentPreviewChars feature on list-notes:
//   1. Schema: contentPreviewChars without path → rejected
//   2. Schema: contentPreviewChars with path     → accepted
//   3. JXA: real folder + previewChars returns trimmed previews
//      with content_truncated flag when applicable.

import { z } from "zod";
import { runJxa } from "run-jxa";

const ListNotesSchema = z
  .object({
    path: z.string().optional(),
    includeContent: z.boolean().optional(),
    contentPreviewChars: z.number().int().positive().optional(),
  })
  .refine((d) => !d.contentPreviewChars || !!d.path, {
    message: "contentPreviewChars requires path",
    path: ["contentPreviewChars"],
  });

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

console.log("Test 1: schema rejects contentPreviewChars without path");
{
  const r = ListNotesSchema.safeParse({ contentPreviewChars: 100 });
  ok(!r.success, "rejected as expected");
  ok(
    !r.success && r.error.issues.some((i) => i.message === "contentPreviewChars requires path"),
    "error message is the refine message"
  );
}

console.log("\nTest 2: schema accepts contentPreviewChars with path");
{
  const r = ListNotesSchema.safeParse({ path: "iCloud/Notes", contentPreviewChars: 100 });
  ok(r.success, "accepted as expected");
}

console.log("\nTest 3: schema accepts includeContent without path (unchanged)");
{
  const r = ListNotesSchema.safeParse({ includeContent: true });
  ok(r.success, "accepted as expected");
}

console.log("\nTest 4: schema accepts empty object (unchanged)");
{
  const r = ListNotesSchema.safeParse({});
  ok(r.success, "accepted as expected");
}

const jxaGetFolderPath = `
  function getFolderPath(item) {
    var parts = [];
    var current = item;
    while (true) {
      try { var c = current.container(); parts.unshift(c.name()); current = c; }
      catch(e) { break; }
    }
    return parts.join('/');
  }
`;

console.log("\nTest 5: JXA preview returns truncated, HTML-stripped content");
try {
  // Find a folder with notes that have non-trivial body length.
  const foldersJson = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const folders = Array.from(app.folders());
    return JSON.stringify(folders.map(f => ({
      path: getFolderPath(f) + '/' + f.name(),
      noteCount: f.notes().length
    })));
  `);
  const folders = JSON.parse(foldersJson);
  const target = folders
    .filter((f) => f.noteCount > 0 && f.noteCount < 200)
    .sort((a, b) => b.noteCount - a.noteCount)[0];
  if (!target) {
    console.log("  SKIP: no suitable folder with notes found");
  } else {
    console.log(`  using folder "${target.path}" (${target.noteCount} notes)`);

    // This is the exact JXA from getNotesByPath in index.ts.
    const previewChars = 80;
    const result = await runJxa(
      `${jxaGetFolderPath}
      const app = Application('Notes');
      app.includeStandardAdditions = true;
      const targetPath = args[0];
      const withContent = args[1] === 'true';
      const previewChars = parseInt(args[2], 10) || 0;
      const allFolders = Array.from(app.folders());
      const folder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
      if (!folder) return JSON.stringify([]);
      const notes = Array.from(folder.notes());
      return JSON.stringify(notes.map(note => {
        const base = {
          id: note.id(),
          title: note.name(),
          path: targetPath,
          creation_date: note.creationDate().toLocaleString(),
          modification_date: note.modificationDate().toLocaleString()
        };
        if (previewChars > 0) {
          const text = String(note.body())
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\\s+/g, ' ')
            .trim();
          base.content = text.slice(0, previewChars);
          if (text.length > previewChars) base.content_truncated = true;
        } else if (withContent) {
          base.content = note.body();
        }
        return base;
      }));`,
      [target.path, "false", String(previewChars)]
    );
    const notes = JSON.parse(result);
    ok(notes.length === target.noteCount, `returned all ${target.noteCount} notes`);
    ok(
      notes.every((n) => typeof n.content === "string"),
      "every note has a content field"
    );
    ok(
      notes.every((n) => n.content.length <= previewChars),
      `every content is <= ${previewChars} chars`
    );
    ok(
      notes.every((n) => !/<[a-zA-Z][^>]*>/.test(n.content)),
      "no HTML tags in previews"
    );
    const longOnes = notes.filter((n) => n.content.length === previewChars);
    if (longOnes.length > 0) {
      ok(
        longOnes.every((n) => n.content_truncated === true),
        "content_truncated flag set on truncated notes"
      );
    } else {
      console.log("  (no truncated samples in this folder — truncation flag untested)");
    }
    const untruncated = notes.filter((n) => n.content_truncated !== true);
    ok(
      untruncated.every((n) => n.content_truncated === undefined),
      "content_truncated absent (not false) when not truncated"
    );

    // Show a sample so a human can eyeball it.
    const sample = notes.find((n) => n.content.length > 10);
    if (sample) {
      console.log(
        `  sample: "${sample.title}" → "${sample.content.slice(0, 60)}..." (truncated=${!!sample.content_truncated})`
      );
    }
  }
} catch (e) {
  failed++;
  console.error("  FAIL:", e.message);
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
