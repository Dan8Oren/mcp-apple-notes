import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as lancedb from "@lancedb/lancedb";
import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import TurndownService from "turndown";
import { EmbeddingFunction, LanceSchema, register } from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

const { turndown } = new TurndownService();
const db = await lancedb.connect(path.join(os.homedir(), ".mcp-apple-notes", "data"));
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

@register("openai")
export class OnDeviceEmbeddingFunction extends EmbeddingFunction<string> {
  toJSON(): object {
    return {};
  }
  ndims() {
    return 384;
  }
  embeddingDataType(): Float {
    return new Float32();
  }
  async computeQueryEmbeddings(data: string) {
    const output = await extractor(data, { pooling: "mean" });
    return output.data as number[];
  }
  async computeSourceEmbeddings(data: string[]) {
    return await Promise.all(
      data.map(async (item) => {
        const output = await extractor(item, { pooling: "mean" });

        return output.data as number[];
      })
    );
  }
}

const func = new OnDeviceEmbeddingFunction();

const notesTableSchema = LanceSchema({
  title: func.sourceField(new Utf8()),
  content: func.sourceField(new Utf8()),
  path: func.sourceField(new Utf8()),
  creation_date: func.sourceField(new Utf8()),
  modification_date: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});

const QueryNotesSchema = z.object({
  query: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const GetNoteSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
});

const PathSchema = z.object({
  path: z.string(),
});

const EditNoteSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
  newTitle: z.string().optional(),
  newContent: z.string().optional(),
});

const MoveNoteSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
  targetPath: z.string(),
});

const DeleteNoteSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
});

const AppendToNoteSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
  content: z.string(),
});

const FindNoteByTitleSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const UpsertNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
  folder: z.string().optional(),
});

class NoteNotFoundError extends Error {
  constructor(title: string, path?: string, suggestions: { title: string; path: string }[] = []) {
    super(
      suggestions.length > 0
        ? `No note matched "${title}"${path ? ` in ${path}` : ""}. Close matches: ${describeMatches(suggestions)}`
        : `No note matched "${title}"${path ? ` in ${path}` : ""}.`
    );
    this.name = "NoteNotFoundError";
  }
}

const server = new Server(
  {
    name: "my-apple-notes-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list-notes",
        description: "List indexed Apple Notes with title, path, and timestamps",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "index-notes",
        description:
          "Index all my Apple Notes for Semantic Search. Please tell the user that the sync takes couple of seconds up to couple of minutes depending on how many notes you have.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get-note",
        description: "Get a note full content and details by title. Optionally scope by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            title: z.string(),
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "list-folders",
        description: "Lists all folders in Apple Notes with note counts",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get-notes-by-path",
        description:
          "Get all notes in a specific Apple Notes folder by its full path (returns titles and metadata, no content). Use list-folders to get available paths.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full folder path (e.g. iCloud/Work/Projects)" },
          },
          required: ["path"],
        },
      },
      {
        name: "search-notes",
        description: "Search for notes by title or content. Optionally filter by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: {
              type: "string",
              description: "Optional: filter results to a specific folder path (e.g. iCloud/Work)",
            },
            limit: { type: "number", description: "Max results to return (default: 50)" },
          },
          required: ["query"],
        },
      },
      {
        name: "find-note-by-title",
        description:
          "Resolve a note by exact or fuzzy title match. Use this when a title may be incomplete or ambiguous.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            path: {
              type: "string",
              description: "Optional folder path to narrow matching",
            },
            limit: {
              type: "number",
              description: "Max matches to return (default: 5)",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "create-note",
        description:
          "Create a new Apple Note with specified title and content. Optionally place it in a folder path. Content must be HTML format WITHOUT newlines",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            folder: {
              type: "string",
              description:
                "Optional folder path to create the note in (e.g. iCloud/Work/Projects). Use list-folders to get available paths.",
            },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "append-to-note",
        description:
          "Append HTML content to an existing Apple Note while preserving its title. Optionally scope by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the note to append to" },
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
            content: {
              type: "string",
              description: "HTML content to append to the end of the note body",
            },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "upsert-note",
        description:
          "Create a note if it does not exist; otherwise append HTML content to the resolved existing note.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            folder: {
              type: "string",
              description:
                "Optional folder path used both for note creation and for resolving an existing note",
            },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "edit-note",
        description: "Edit an existing Apple Note's title and/or content by its current title",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Current title of the note to edit" },
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
            newTitle: { type: "string", description: "New title (optional)" },
            newContent: {
              type: "string",
              description: "New content in HTML format (optional, replaces entire content)",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "move-note",
        description:
          "Move a note to a different folder by specifying the target folder path. Optionally scope the source note by folder path. Use list-folders to get available paths.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the note to move" },
            path: {
              type: "string",
              description: "Optional current folder path to disambiguate duplicate titles",
            },
            targetPath: {
              type: "string",
              description: "Full folder path to move the note to (e.g. iCloud/Work/Projects)",
            },
          },
          required: ["title", "targetPath"],
        },
      },
      {
        name: "delete-note",
        description:
          "Delete an Apple Note by title. The note will be moved to Recently Deleted. Optionally scope by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the note to delete" },
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
          },
          required: ["title"],
        },
      },
    ],
  };
});

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

  function getNoteFolderPath(note) {
    var folder = note.container();
    return getFolderPath(folder) + '/' + folder.name();
  }
`;

const getNotes = async () => {
  const result = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const notes = Array.from(app.notes());
  return JSON.stringify(notes.map(note => ({
      title: note.properties().name,
      path: getNoteFolderPath(note)
    })));
  `);

  return JSON.parse(result as string) as { title: string; path: string }[];
};

export const getIndexedNotes = async (notesTable: lancedb.Table) => {
  const rows = await notesTable.query().toArray();
  return rows.map((row: any) => ({
    title: row.title,
    path: row.path,
    creation_date: row.creation_date,
    modification_date: row.modification_date,
  }));
};

export const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();

const normalizedQueryTokens = (normalizedTitle: string) =>
  normalizedTitle.split(" ").filter((token) => token.length >= 2);

export const dedupeByTitleAndPath = <
  T extends { title: string; path: string; creation_date?: string; modification_date?: string }
>(
  notes: T[]
) =>
  Array.from(
    new Map(notes.map((note) => [`${note.title}::${note.path}`, note] as const)).values()
  );

const describeMatches = (matches: { title: string; path: string }[]) =>
  matches.map((match) => `${match.title} (${match.path})`).join(", ");

export const findMatchingNotes = async (
  notesTable: lancedb.Table,
  requestedTitle: string,
  path?: string
) => {
  const notes = dedupeByTitleAndPath(await getIndexedNotes(notesTable));
  const scopedNotes = path ? notes.filter((note) => note.path === path) : notes;
  const normalizedQuery = normalizeTitle(requestedTitle);

  const exactMatches = scopedNotes.filter((note) => note.title === requestedTitle);
  const normalizedMatches = scopedNotes.filter((note) => normalizeTitle(note.title) === normalizedQuery);
  const fuzzyMatches = scopedNotes
    .filter((note) => {
      const normalizedTitle = normalizeTitle(note.title);
      return (
        normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)
      );
    })
    .sort((a, b) => {
      const aTitle = normalizeTitle(a.title);
      const bTitle = normalizeTitle(b.title);
      const aStarts = aTitle.startsWith(normalizedQuery) ? 1 : 0;
      const bStarts = bTitle.startsWith(normalizedQuery) ? 1 : 0;
      if (aStarts !== bStarts) return bStarts - aStarts;
      return aTitle.length - bTitle.length;
    });

  return {
    scopedNotes,
    exactMatches,
    normalizedMatches,
    fuzzyMatches,
  };
};

export const resolveNoteReference = async (
  notesTable: lancedb.Table,
  requestedTitle: string,
  path?: string
) => {
  const normalizedQuery = normalizeTitle(requestedTitle);
  const { scopedNotes, exactMatches, normalizedMatches, fuzzyMatches } = await findMatchingNotes(
    notesTable,
    requestedTitle,
    path
  );

  if (exactMatches.length === 1) {
    return { note: exactMatches[0], matchType: "exact" as const };
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `Multiple notes exactly match "${requestedTitle}". Narrow with path. Matches: ${describeMatches(exactMatches.slice(0, 5))}`
    );
  }

  if (normalizedMatches.length === 1) {
    return { note: normalizedMatches[0], matchType: "normalized" as const };
  }
  if (normalizedMatches.length > 1) {
    throw new Error(
      `Multiple notes closely match "${requestedTitle}". Narrow with path. Matches: ${describeMatches(normalizedMatches.slice(0, 5))}`
    );
  }

  if (fuzzyMatches.length === 1) {
    return { note: fuzzyMatches[0], matchType: "fuzzy" as const };
  }
  if (fuzzyMatches.length > 1) {
    throw new Error(
      `Title "${requestedTitle}" is ambiguous. Use find-note-by-title or provide path. Matches: ${describeMatches(fuzzyMatches.slice(0, 5))}`
    );
  }

  const suggestions = scopedNotes
    .filter((note) => {
      const normalizedTitle = normalizeTitle(note.title);
      return normalizedQueryTokens(normalizedQuery).some((token) => normalizedTitle.includes(token));
    })
    .slice(0, 5);

  throw new NoteNotFoundError(requestedTitle, path, suggestions);
};

const getFolders = async () => {
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

  return JSON.parse(result as string) as { name: string; path: string; noteCount: number }[];
};

const getNotesByPath = async (folderPath: string) => {
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
    [folderPath]
  );

  return JSON.parse(result as string) as {
    title: string;
    path: string;
    creation_date: string;
    modification_date: string;
  }[];
};

const getNoteDetailsByTitle = async (title: string, folderPath?: string) => {
  const note = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    const folderPath = args[1];

    try {
        const note = Array.from(app.notes()).find(note => {
            return note.name() === title && (!folderPath || getNoteFolderPath(note) === folderPath);
        });
        if (!note) return "{}";

        const noteInfo = {
            title: note.name(),
            content: note.body(),
            path: getNoteFolderPath(note),
            creation_date: note.creationDate().toLocaleString(),
            modification_date: note.modificationDate().toLocaleString()
        };

        return JSON.stringify(noteInfo);
    } catch (error) {
        return "{}";
    }`,
    [title, folderPath || ""]
  );

  return JSON.parse(note as string) as {
    title: string;
    content: string;
    path: string;
    creation_date: string;
    modification_date: string;
  };
};

export const indexNotes = async (notesTable: any) => {
  const start = performance.now();
  let report = "";
  const allNotes = (await getNotes()) || [];
  const notesDetails = await Promise.all(
    allNotes.map((note) => {
      try {
        return getNoteDetailsByTitle(note.title);
      } catch (error) {
        report += `Error getting note details for ${note.title}: ${(error as Error).message}\n`;
        return {} as any;
      }
    })
  );

  const chunks = notesDetails
    .filter((n) => n.title)
    .map((node) => {
      try {
        return {
          ...node,
          content: turndown(node.content || ""), // this sometimes fails
        };
      } catch (error) {
        return node;
      }
    })
    .map((note, index) => ({
      id: index.toString(),
      title: note.title,
      content: note.content,
      path: note.path || "Unknown",
      creation_date: note.creation_date,
      modification_date: note.modification_date,
    }));

  await notesTable.add(chunks, { mode: "overwrite" });

  return {
    chunks: chunks.length,
    report,
    allNotes: allNotes.length,
    time: performance.now() - start,
  };
};

export const createNotesTable = async (overrideName?: string) => {
  const start = performance.now();
  const notesTable = await db.createEmptyTable(overrideName || "notes", notesTableSchema, {
    mode: "create",
    existOk: true,
  });

  const indices = await notesTable.listIndices();
  if (!indices.find((index) => index.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }
  return { notesTable, time: performance.now() - start };
};

const createNote = async (title: string, content: string, folder?: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const targetPath = args[2];
    app.make({new: 'note', withProperties: {
      name: args[0],
      body: args[1]
    }});
    if (targetPath) {
      const allFolders = Array.from(app.folders());
      const targetFolder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
      if (!targetFolder) throw new Error('Folder not found: ' + targetPath);
      const note = app.notes.whose({name: args[0]})[0];
      app.move(note, {to: targetFolder});
    }
    return true;`,
    [title, content, folder || ""]
  );
};

const appendToNote = async (title: string, content: string, folderPath?: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    const contentToAppend = args[1];
    const folderPath = args[2];
    const note = Array.from(app.notes()).find(note => {
      return note.name() === title && (!folderPath || getNoteFolderPath(note) === folderPath);
    });
    if (!note) throw new Error('Note not found: ' + title);
    const currentBody = note.body();
    note.body = currentBody + contentToAppend;
    note.name = title;
    return true;`,
    [title, content, folderPath || ""]
  );
};

const moveNote = async (title: string, targetPath: string, sourcePath?: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    const targetPath = args[1];
    const sourcePath = args[2];
    const allFolders = Array.from(app.folders());
    const targetFolder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
    if (!targetFolder) throw new Error('Folder not found: ' + targetPath);
    const note = Array.from(app.notes()).find(note => {
      return note.name() === title && (!sourcePath || getNoteFolderPath(note) === sourcePath);
    });
    if (!note) throw new Error('Note not found: ' + title);
    app.move(note, {to: targetFolder});
    return true;`,
    [title, targetPath, sourcePath || ""]
  );
};

const deleteNote = async (title: string, folderPath?: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    const folderPath = args[1];
    const note = Array.from(app.notes()).find(note => {
      return note.name() === title && (!folderPath || getNoteFolderPath(note) === folderPath);
    });
    if (!note) throw new Error('Note not found: ' + title);
    app.delete(note);
    return true;`,
    [title, folderPath || ""]
  );
};

const editNote = async (title: string, path: string | undefined, newTitle?: string, newContent?: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];
    const path = args[1];
    const newTitle = args[2];
    const newContent = args[3];
    const note = Array.from(app.notes()).find(note => {
      return note.name() === title && (!path || getNoteFolderPath(note) === path);
    });
    if (!note) throw new Error('Note not found: ' + title);
    if (newContent) {
      note.body = newContent;
      note.name = newTitle || title;
    } else if (newTitle) {
      note.name = newTitle;
    }
    return true;`,
    [title, path || "", newTitle || "", newContent || ""]
  );
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { notesTable } = await createNotesTable();
  const { name, arguments: args } = request.params;

  try {
    if (name === "create-note") {
      const { title, content, folder } = CreateNoteSchema.parse(args);
      await createNote(title, content, folder);
      await indexNotes(notesTable);
      return createTextResponse(
        `Created note "${title}"${folder ? ` in ${folder}` : ""} successfully. Index updated.`
      );
    } else if (name === "list-notes") {
      const notes = await getIndexedNotes(notesTable);
      return createTextResponse(JSON.stringify(notes));
    } else if (name == "get-note") {
      try {
        const { title, path } = GetNoteSchema.parse(args);
        const { note: resolvedNote, matchType } = await resolveNoteReference(notesTable, title, path);
        const note = await getNoteDetailsByTitle(resolvedNote.title, resolvedNote.path);

        return createTextResponse(JSON.stringify({ ...note, resolved_match: matchType }));
      } catch (error) {
        return createTextResponse((error as Error).message);
      }
    } else if (name === "list-folders") {
      const folders = await getFolders();
      return createTextResponse(JSON.stringify(folders));
    } else if (name === "get-notes-by-path") {
      const { path } = PathSchema.parse(args);
      const notes = await getNotesByPath(path);
      return createTextResponse(JSON.stringify(notes));
    } else if (name === "index-notes") {
      const { time, chunks, report, allNotes } = await indexNotes(notesTable);
      return createTextResponse(
        `Indexed ${chunks} notes chunks in ${time}ms. You can now search for them using the "search-notes" tool.`
      );
    } else if (name === "search-notes") {
      const { query, path, limit } = QueryNotesSchema.parse(args);
      const combinedResults = await searchAndCombineResults(notesTable, query, { path, limit });
      return createTextResponse(JSON.stringify(combinedResults));
    } else if (name === "find-note-by-title") {
      const { title, path, limit } = FindNoteByTitleSchema.parse(args);
      const { exactMatches, normalizedMatches, fuzzyMatches } = await findMatchingNotes(
        notesTable,
        title,
        path
      );
      return createTextResponse(
        JSON.stringify({
          query: title,
          path: path || null,
          exact_matches: exactMatches.slice(0, limit || 5),
          normalized_matches: normalizedMatches.slice(0, limit || 5),
          fuzzy_matches: fuzzyMatches.slice(0, limit || 5),
        })
      );
    } else if (name === "edit-note") {
      const { title, path, newTitle, newContent } = EditNoteSchema.parse(args);
      if (!newTitle && !newContent) {
        return createTextResponse("Nothing to update — provide newTitle and/or newContent.");
      }
      const { note: resolvedNote } = await resolveNoteReference(notesTable, title, path);
      await editNote(resolvedNote.title, resolvedNote.path, newTitle, newContent);
      await indexNotes(notesTable);
      return createTextResponse(
        `Updated note "${resolvedNote.title}"${newTitle ? ` → "${newTitle}"` : ""} successfully. Index updated.`
      );
    } else if (name === "append-to-note") {
      const { title, path, content } = AppendToNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteReference(notesTable, title, path);
      await appendToNote(resolvedNote.title, content, resolvedNote.path);
      await indexNotes(notesTable);
      return createTextResponse(
        `Appended content to "${resolvedNote.title}" successfully. Index updated.`
      );
    } else if (name === "upsert-note") {
      const { title, content, folder } = UpsertNoteSchema.parse(args);
      try {
        const { note: resolvedNote, matchType } = await resolveNoteReference(notesTable, title, folder);
        await appendToNote(resolvedNote.title, content, resolvedNote.path);
        await indexNotes(notesTable);
        return createTextResponse(
          `Appended content to existing note "${resolvedNote.title}" (${matchType} match). Index updated.`
        );
      } catch (error) {
        if (!(error instanceof NoteNotFoundError)) {
          throw error;
        }
      }
      await createNote(title, content, folder);
      await indexNotes(notesTable);
      return createTextResponse(
        `Created note "${title}"${folder ? ` in ${folder}` : ""} successfully. Index updated.`
      );
    } else if (name === "move-note") {
      const { title, path, targetPath } = MoveNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteReference(notesTable, title, path);
      await moveNote(resolvedNote.title, targetPath, resolvedNote.path);
      await indexNotes(notesTable);
      return createTextResponse(`Moved note "${resolvedNote.title}" to ${targetPath}. Index updated.`);
    } else if (name === "delete-note") {
      const { title, path } = DeleteNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteReference(notesTable, title, path);
      await deleteNote(resolvedNote.title, resolvedNote.path);
      await indexNotes(notesTable);
      return createTextResponse(`Deleted note "${resolvedNote.title}". Index updated.`);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Local Machine MCP Server running on stdio");

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});

/**
 * Search for notes by title or content using both vector and FTS search.
 * The results are combined using RRF
 */
export const searchAndCombineResults = async (
  notesTable: lancedb.Table,
  query: string,
  options: { limit?: number; path?: string } = {}
) => {
  const { limit = 50, path } = options;
  const fetchLimit = path ? limit * 3 : limit;

  const [vectorResults, ftsSearchResults] = await Promise.all([
    notesTable.search(query, "vector").limit(fetchLimit).toArray(),
    notesTable.search(query, "fts", "content").limit(fetchLimit).toArray(),
  ]);

  const filterByPath = (results: any[]) =>
    path ? results.filter((r) => r.path === path) : results;

  const k = 60;
  const scores = new Map<string, { score: number; path: string }>();

  const processResults = (results: any[]) => {
    results.forEach((result, idx) => {
      const key = `${result.title}::${result.content}`;
      const score = 1 / (k + idx);
      const existing = scores.get(key);
      scores.set(key, {
        score: (existing?.score || 0) + score,
        path: result.path,
      });
    });
  };

  processResults(filterByPath(vectorResults));
  processResults(filterByPath(ftsSearchResults));

  const results = Array.from(scores.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([key, { path }]) => {
      const [title, content] = key.split("::");
      return { title, content, path };
    });

  return results;
};

const CreateNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
  folder: z.string().optional(),
});
