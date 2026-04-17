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
});

const PathSchema = z.object({
  path: z.string(),
});

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
        description: "Lists just the titles of all my Apple Notes",
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
        description: "Get a note full content and details by title",
        inputSchema: {
          type: "object",
          properties: {
            title: z.string(),
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
        name: "create-note",
        description:
          "Create a new Apple Note with specified title and content. Must be in HTML format WITHOUT newlines",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
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
`;

const getNotes = async () => {
  const result = await runJxa(`
    ${jxaGetFolderPath}
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const notes = Array.from(app.notes());
    return JSON.stringify(notes.map(note => ({
      title: note.properties().name,
      path: getFolderPath(note)
    })));
  `);

  return JSON.parse(result as string) as { title: string; path: string }[];
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

const getNoteDetailsByTitle = async (title: string) => {
  const note = await runJxa(
    `${jxaGetFolderPath}
    const app = Application('Notes');
    const title = args[0];

    try {
        const note = app.notes.whose({name: title})[0];

        const noteInfo = {
            title: note.name(),
            content: note.body(),
            path: getFolderPath(note),
            creation_date: note.creationDate().toLocaleString(),
            modification_date: note.modificationDate().toLocaleString()
        };

        return JSON.stringify(noteInfo);
    } catch (error) {
        return "{}";
    }`,
    [title]
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

  await notesTable.add(chunks);

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

const createNote = async (title: string, content: string) => {
  // Escape special characters and convert newlines to \n
  const escapedTitle = title.replace(/[\\'"]/g, "\\$&");
  const escapedContent = content
    .replace(/[\\'"]/g, "\\$&")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");

  await runJxa(`
    const app = Application('Notes');
    const note = app.make({new: 'note', withProperties: {
      name: "${escapedTitle}",
      body: "${escapedContent}"
    }});
    
    return true
  `);

  return true;
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { notesTable } = await createNotesTable();
  const { name, arguments: args } = request.params;

  try {
    if (name === "create-note") {
      const { title, content } = CreateNoteSchema.parse(args);
      await createNote(title, content);
      return createTextResponse(`Created note "${title}" successfully.`);
    } else if (name === "list-notes") {
      return createTextResponse(
        `There are ${await notesTable.countRows()} notes in your Apple Notes database.`
      );
    } else if (name == "get-note") {
      try {
        const { title } = GetNoteSchema.parse(args);
        const note = await getNoteDetailsByTitle(title);

        return createTextResponse(`${note}`);
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
});
