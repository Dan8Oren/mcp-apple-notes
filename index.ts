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
  id: func.sourceField(new Utf8()),
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

const GetNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

const PathSchema = z.object({
  path: z.string(),
});

const EditNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional(),
    newTitle: z.string().optional(),
    newContent: z.string().optional(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

const MoveNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional(),
    targetPath: z.string(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

const DeleteNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

const AppendToNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    path: z.string().optional(),
    content: z.string(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

const FindNoteByTitleSchema = z.object({
  title: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const UpsertNoteSchema = z
  .object({
    noteId: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    folder: z.string().optional(),
  })
  .refine((d) => d.noteId || d.title, { message: "Either noteId or title must be provided" });

class NoteNotFoundError extends Error {
  constructor(
    identifier: string,
    path?: string,
    suggestions: { id: string; title: string; path: string }[] = []
  ) {
    super(
      suggestions.length > 0
        ? `No note matched "${identifier}"${path ? ` in ${path}` : ""}. Close matches: ${describeMatches(suggestions)}`
        : `No note matched "${identifier}"${path ? ` in ${path}` : ""}.`
    );
    this.name = "NoteNotFoundError";
  }
}

class AmbiguousNoteError extends Error {
  constructor(
    title: string,
    matches: { id: string; title: string; path: string }[],
    detail?: string
  ) {
    super(
      detail ||
        `Multiple notes match "${title}". Narrow with path. Matches: ${describeMatches(matches.slice(0, 5))}`
    );
    this.name = "AmbiguousNoteError";
  }
}

class FolderNotFoundError extends Error {
  constructor(path: string) {
    super(`Folder not found: ${path}`);
    this.name = "FolderNotFoundError";
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
        description:
          "Get a note full content and details by noteId or title. Optionally scope by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, skips title resolution.",
            },
            title: { type: "string" },
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
          },
          required: [],
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
        name: "list-notes-by-path",
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
          "Append HTML content to an existing Apple Note while preserving its title. Identify note by noteId or title.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, skips title resolution.",
            },
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
          required: ["content"],
        },
      },
      {
        name: "upsert-note",
        description:
          "Create a note if it does not exist; otherwise append HTML content to the resolved existing note. Identify existing note by noteId or title.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, appends to the existing note directly.",
            },
            title: { type: "string" },
            content: { type: "string" },
            folder: {
              type: "string",
              description:
                "Optional folder path used both for note creation and for resolving an existing note",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "edit-note",
        description:
          "Edit an existing Apple Note's title and/or content by noteId or current title",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, skips title resolution.",
            },
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
          required: [],
        },
      },
      {
        name: "move-note",
        description:
          "Move a note to a different folder by noteId or title. Optionally scope the source note by folder path. Use list-folders to get available paths.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, skips title resolution.",
            },
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
          required: ["targetPath"],
        },
      },
      {
        name: "delete-note",
        description:
          "Delete an Apple Note by noteId or title. The note will be moved to Recently Deleted. Optionally scope by folder path.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "Apple Notes ID. If provided, skips title resolution.",
            },
            title: { type: "string", description: "Title of the note to delete" },
            path: {
              type: "string",
              description: "Optional folder path to disambiguate duplicate titles",
            },
          },
          required: [],
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
      id: note.id(),
      title: note.properties().name,
      path: getNoteFolderPath(note)
    })));
  `);

  return JSON.parse(result as string) as { id: string; title: string; path: string }[];
};

export const getIndexedNotes = async (notesTable: lancedb.Table) => {
  const rows = await notesTable.query().toArray();
  return rows.map((row: any) => ({
    id: row.id,
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

export const dedupeById = <T extends { id: string }>(notes: T[]) =>
  Array.from(new Map(notes.map((note) => [note.id, note] as const)).values());

const describeMatches = (matches: { id: string; title: string; path: string }[]) =>
  matches.map((match) => `${match.title} (${match.path}, ${match.id})`).join(", ");

export const findMatchingNotes = async (
  notesTable: lancedb.Table,
  requestedTitle: string,
  path?: string
) => {
  const notes = dedupeById(await getIndexedNotes(notesTable));
  const scopedNotes = path ? notes.filter((note) => note.path === path) : notes;
  const normalizedQuery = normalizeTitle(requestedTitle);

  const exactMatches = scopedNotes.filter((note) => note.title === requestedTitle);
  const normalizedMatches = scopedNotes.filter(
    (note) => normalizeTitle(note.title) === normalizedQuery
  );
  const fuzzyMatches = scopedNotes
    .filter((note) => {
      const normalizedTitle = normalizeTitle(note.title);
      return normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle);
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

const resolveNoteId = async (
  notesTable: lancedb.Table,
  noteId?: string,
  title?: string,
  path?: string
) => {
  if (noteId) {
    const details = await getNoteDetailsById(noteId);
    if (!details.id) throw new NoteNotFoundError(noteId);
    return {
      note: { id: details.id, title: details.title, path: details.path },
      matchType: "id" as const,
    };
  }
  if (!title) throw new Error("Either noteId or title must be provided");
  return resolveNoteReference(notesTable, title, path);
};

const escapeSqlString = (value: string) => value.replace(/'/g, "''");

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
    throw new AmbiguousNoteError(
      requestedTitle,
      exactMatches,
      `Multiple notes exactly match "${requestedTitle}". Narrow with path. Matches: ${describeMatches(exactMatches.slice(0, 5))}`
    );
  }

  if (normalizedMatches.length === 1) {
    return { note: normalizedMatches[0], matchType: "normalized" as const };
  }
  if (normalizedMatches.length > 1) {
    throw new AmbiguousNoteError(
      requestedTitle,
      normalizedMatches,
      `Multiple notes closely match "${requestedTitle}". Narrow with path. Matches: ${describeMatches(normalizedMatches.slice(0, 5))}`
    );
  }

  if (fuzzyMatches.length === 1) {
    return { note: fuzzyMatches[0], matchType: "fuzzy" as const };
  }
  if (fuzzyMatches.length > 1) {
    throw new AmbiguousNoteError(
      requestedTitle,
      fuzzyMatches,
      `Title "${requestedTitle}" is ambiguous. Use find-note-by-title or provide path. Matches: ${describeMatches(fuzzyMatches.slice(0, 5))}`
    );
  }

  const suggestions = scopedNotes
    .filter((note) => {
      const normalizedTitle = normalizeTitle(note.title);
      return normalizedQueryTokens(normalizedQuery).some((token) =>
        normalizedTitle.includes(token)
      );
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
      id: note.id(),
      title: note.name(),
      path: targetPath,
      creation_date: note.creationDate().toLocaleString(),
      modification_date: note.modificationDate().toLocaleString()
    })));`,
    [folderPath]
  );

  return JSON.parse(result as string) as {
    id: string;
    title: string;
    path: string;
    creation_date: string;
    modification_date: string;
  }[];
};

const getNoteDetailsById = async (id: string) => {
  const note = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const id = args[0];

    try {
        const note = Array.from(app.notes()).find(note => {
            return note.id() === id;
        });
        if (!note) return "{}";

        const noteInfo = {
            id: note.id(),
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
    [id]
  );

  return JSON.parse(note as string) as {
    id: string;
    title: string;
    content: string;
    path: string;
    creation_date: string;
    modification_date: string;
  };
};

const assertNoteDetails = (
  note: Partial<{
    id: string;
    title: string;
    content: string;
    path: string;
    creation_date: string;
    modification_date: string;
  }>,
  identifier: string
) => {
  if (!note.id) {
    throw new NoteNotFoundError(identifier);
  }
  return note as {
    id: string;
    title: string;
    content: string;
    path: string;
    creation_date: string;
    modification_date: string;
  };
};

const noteToIndexRow = (note: {
  id: string;
  title: string;
  content: string;
  path: string;
  creation_date: string;
  modification_date: string;
}) => {
  try {
    return {
      ...note,
      content: turndown(note.content || ""),
    };
  } catch (error) {
    return note;
  }
};

export const indexNotes = async (notesTable: any) => {
  const start = performance.now();
  let report = "";
  const allNotes = (await getNotes()) || [];
  const notesDetails = await Promise.all(
    allNotes.map((note) => {
      try {
        return getNoteDetailsById(note.id);
      } catch (error) {
        report += `Error getting note details for ${note.title}: ${(error as Error).message}\n`;
        return {} as any;
      }
    })
  );

  const chunks = notesDetails
    .filter((n) => n.title)
    .map((node) => noteToIndexRow(assertNoteDetails(node, node.id || node.title || "unknown")));

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
  const tableName = overrideName || "notes";
  let notesTable = await db.createEmptyTable(tableName, notesTableSchema, {
    mode: "create",
    existOk: true,
  });
  const schema = await notesTable.schema();
  const hasIdColumn = schema.fields.some((field) => field.name === "id");
  if (!hasIdColumn) {
    await db.dropTable(tableName);
    notesTable = await db.createEmptyTable(tableName, notesTableSchema, {
      mode: "create",
      existOk: true,
    });
    await indexNotes(notesTable);
  }

  const indices = await notesTable.listIndices();
  if (!indices.find((index) => index.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }
  return { notesTable, time: performance.now() - start };
};

const refreshIndexedNoteById = async (notesTable: lancedb.Table, noteId: string) => {
  const note = assertNoteDetails(await getNoteDetailsById(noteId), noteId);
  await notesTable.delete(`id = '${escapeSqlString(noteId)}'`);
  await notesTable.add([noteToIndexRow(note)]);
  return note;
};

const removeIndexedNoteById = async (notesTable: lancedb.Table, noteId: string) => {
  await notesTable.delete(`id = '${escapeSqlString(noteId)}'`);
};

const createNote = async (title: string, content: string, folder?: string) => {
  const result = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const targetPath = args[2];
    const note = app.make({new: 'note', withProperties: {
      name: args[0],
      body: args[1]
    }});
    if (targetPath) {
      const allFolders = Array.from(app.folders());
      const targetFolder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
      if (!targetFolder) throw new Error('__FOLDER_NOT_FOUND__:' + targetPath);
      app.move(note, {to: targetFolder});
    }
    return note.id();`,
    [title, content, folder || ""]
  );
  return result as string;
};

const appendToNote = async (noteId: string, content: string) => {
  await runJxa(
    `const app = Application('Notes');
    const noteId = args[0];
    const contentToAppend = args[1];
    const note = Array.from(app.notes()).find(note => {
      return note.id() === noteId;
    });
    if (!note) throw new Error('__NOTE_NOT_FOUND__:' + noteId);
    const currentBody = note.body();
    note.body = currentBody + contentToAppend;
    note.name = note.name();
    return true;`,
    [noteId, content]
  );
};

const moveNote = async (noteId: string, targetPath: string) => {
  await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const noteId = args[0];
    const targetPath = args[1];
    const allFolders = Array.from(app.folders());
    const targetFolder = allFolders.find(f => getFolderPath(f) + '/' + f.name() === targetPath);
    if (!targetFolder) throw new Error('__FOLDER_NOT_FOUND__:' + targetPath);
    const note = Array.from(app.notes()).find(note => {
      return note.id() === noteId;
    });
    if (!note) throw new Error('__NOTE_NOT_FOUND__:' + noteId);
    app.move(note, {to: targetFolder});
    return true;`,
    [noteId, targetPath]
  );
};

const deleteNote = async (noteId: string) => {
  await runJxa(
    `const app = Application('Notes');
    const noteId = args[0];
    const note = Array.from(app.notes()).find(note => {
      return note.id() === noteId;
    });
    if (!note) throw new Error('__NOTE_NOT_FOUND__:' + noteId);
    app.delete(note);
    return true;`,
    [noteId]
  );
};

const editNote = async (noteId: string, newTitle?: string, newContent?: string) => {
  await runJxa(
    `const app = Application('Notes');
    const noteId = args[0];
    const newTitle = args[1];
    const newContent = args[2];
    const note = Array.from(app.notes()).find(note => {
      return note.id() === noteId;
    });
    if (!note) throw new Error('__NOTE_NOT_FOUND__:' + noteId);
    if (newContent) {
      note.body = newContent;
      note.name = newTitle || note.name();
    } else if (newTitle) {
      note.name = newTitle;
    }
    return true;`,
    [noteId, newTitle || "", newContent || ""]
  );
};

const serializeError = (error: unknown) => {
  if (error instanceof z.ZodError) {
    return {
      type: "ValidationError",
      message: error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
    };
  }
  if (
    error instanceof NoteNotFoundError ||
    error instanceof AmbiguousNoteError ||
    error instanceof FolderNotFoundError
  ) {
    return { type: error.name, message: error.message };
  }
  const message = (error as Error).message || String(error);
  if (message.startsWith("__FOLDER_NOT_FOUND__:")) {
    const path = message.replace("__FOLDER_NOT_FOUND__:", "");
    return { type: "FolderNotFoundError", message: new FolderNotFoundError(path).message };
  }
  if (message.startsWith("__NOTE_NOT_FOUND__:")) {
    const id = message.replace("__NOTE_NOT_FOUND__:", "");
    return { type: "NoteNotFoundError", message: new NoteNotFoundError(id).message };
  }
  return { type: "ToolExecutionError", message };
};

const createJsonResponse = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { notesTable } = await createNotesTable();
  const { name, arguments: args } = request.params;

  try {
    if (name === "create-note") {
      const { title, content, folder } = CreateNoteSchema.parse(args);
      const noteId = await createNote(title, content, folder);
      const note = await refreshIndexedNoteById(notesTable, noteId);
      return createJsonResponse({
        ok: true,
        data: note,
        message: `Created note "${title}"${folder ? ` in ${folder}` : ""}.`,
      });
    } else if (name === "list-notes") {
      const notes = await getIndexedNotes(notesTable);
      return createJsonResponse({ ok: true, data: notes });
    } else if (name == "get-note") {
      const { noteId, title, path } = GetNoteSchema.parse(args);
      const { note: resolvedNote, matchType } = await resolveNoteId(
        notesTable,
        noteId,
        title,
        path
      );
      const note = assertNoteDetails(await getNoteDetailsById(resolvedNote.id), resolvedNote.id);
      return createJsonResponse({ ok: true, data: { ...note, resolved_match: matchType } });
    } else if (name === "list-folders") {
      const folders = await getFolders();
      return createJsonResponse({ ok: true, data: folders });
    } else if (name === "list-notes-by-path") {
      const { path } = PathSchema.parse(args);
      const notes = await getNotesByPath(path);
      return createJsonResponse({ ok: true, data: notes });
    } else if (name === "index-notes") {
      const { time, chunks, report, allNotes } = await indexNotes(notesTable);
      return createJsonResponse({
        ok: true,
        data: {
          indexed_notes: chunks,
          source_notes: allNotes,
          duration_ms: time,
          report,
        },
      });
    } else if (name === "search-notes") {
      const { query, path, limit } = QueryNotesSchema.parse(args);
      const combinedResults = await searchAndCombineResults(notesTable, query, { path, limit });
      return createJsonResponse({ ok: true, data: combinedResults });
    } else if (name === "find-note-by-title") {
      const { title, path, limit } = FindNoteByTitleSchema.parse(args);
      const { exactMatches, normalizedMatches, fuzzyMatches } = await findMatchingNotes(
        notesTable,
        title,
        path
      );
      return createJsonResponse({
        ok: true,
        data: {
          query: title,
          path: path || null,
          exact_matches: exactMatches.slice(0, limit || 5),
          normalized_matches: normalizedMatches.slice(0, limit || 5),
          fuzzy_matches: fuzzyMatches.slice(0, limit || 5),
        },
      });
    } else if (name === "edit-note") {
      const { noteId, title, path, newTitle, newContent } = EditNoteSchema.parse(args);
      if (!newTitle && !newContent) {
        return createJsonResponse({
          ok: false,
          error: { type: "ValidationError", message: "Provide newTitle and/or newContent." },
        });
      }
      const { note: resolvedNote } = await resolveNoteId(notesTable, noteId, title, path);
      await editNote(resolvedNote.id, newTitle, newContent);
      const note = await refreshIndexedNoteById(notesTable, resolvedNote.id);
      return createJsonResponse({
        ok: true,
        data: note,
        message: `Updated note "${resolvedNote.title}"${newTitle ? ` → "${newTitle}"` : ""}.`,
      });
    } else if (name === "append-to-note") {
      const { noteId, title, path, content } = AppendToNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteId(notesTable, noteId, title, path);
      await appendToNote(resolvedNote.id, content);
      const note = await refreshIndexedNoteById(notesTable, resolvedNote.id);
      return createJsonResponse({
        ok: true,
        data: note,
        message: `Appended content to "${resolvedNote.title}".`,
      });
    } else if (name === "upsert-note") {
      const { noteId, title, content, folder } = UpsertNoteSchema.parse(args);
      try {
        const { note: resolvedNote, matchType } = await resolveNoteId(
          notesTable,
          noteId,
          title,
          folder
        );
        await appendToNote(resolvedNote.id, content);
        const note = await refreshIndexedNoteById(notesTable, resolvedNote.id);
        return createJsonResponse({
          ok: true,
          data: { ...note, resolved_match: matchType },
          message: `Appended content to existing note "${resolvedNote.title}".`,
        });
      } catch (error) {
        if (!(error instanceof NoteNotFoundError)) {
          throw error;
        }
      }
      const createdNoteId = await createNote(title!, content, folder);
      const note = await refreshIndexedNoteById(notesTable, createdNoteId);
      return createJsonResponse({
        ok: true,
        data: note,
        message: `Created note "${title}"${folder ? ` in ${folder}` : ""}.`,
      });
    } else if (name === "move-note") {
      const { noteId, title, path, targetPath } = MoveNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteId(notesTable, noteId, title, path);
      await moveNote(resolvedNote.id, targetPath);
      const note = await refreshIndexedNoteById(notesTable, resolvedNote.id);
      return createJsonResponse({
        ok: true,
        data: note,
        message: `Moved note "${resolvedNote.title}" to ${targetPath}.`,
      });
    } else if (name === "delete-note") {
      const { noteId, title, path } = DeleteNoteSchema.parse(args);
      const { note: resolvedNote } = await resolveNoteId(notesTable, noteId, title, path);
      await deleteNote(resolvedNote.id);
      await removeIndexedNoteById(notesTable, resolvedNote.id);
      return createJsonResponse({
        ok: true,
        data: { id: resolvedNote.id, title: resolvedNote.title, path: resolvedNote.path },
        message: `Deleted note "${resolvedNote.title}".`,
      });
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return createJsonResponse({ ok: false, error: serializeError(error) });
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Local Machine MCP Server running on stdio");

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
  const scores = new Map<
    string,
    { score: number; id: string; title: string; content: string; path: string }
  >();

  const processResults = (results: any[]) => {
    results.forEach((result, idx) => {
      const key = result.id;
      const score = 1 / (k + idx);
      const existing = scores.get(key);
      scores.set(key, {
        id: result.id,
        title: result.title,
        content: result.content,
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
    .map(([, { id, title, content, path }]) => {
      return { id, title, content, path };
    });

  return results;
};

const CreateNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
  folder: z.string().optional(),
});
