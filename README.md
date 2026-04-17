# MCP Apple Notes

![MCP Apple Notes](./images/logo.png)

> **Fork of [RafalWilinski/mcp-apple-notes](https://github.com/RafalWilinski/mcp-apple-notes)** — actively maintained with bug fixes and additional features.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables semantic search and RAG (Retrieval Augmented Generation) over your Apple Notes. Works with any MCP-compatible client — Claude Desktop, Cursor, Windsurf, Cline, and others.

![MCP Apple Notes](./images/demo.png)

## Features

- 🔍 Semantic search over Apple Notes using [`all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) on-device embeddings model
- 📝 Full-text search capabilities
- 📂 Folder support — list folders, browse by folder, filter search by folder
- 📊 Vector storage using [LanceDB](https://lancedb.github.io/lancedb/)
- 🤖 Works with any MCP-compatible client (Claude, Cursor, Windsurf, Cline, etc.)
- 🍎 Native Apple Notes integration via JXA
- 🏃‍♂️ Fully local execution - no API keys needed

## Prerequisites

- macOS (Apple Notes access via JXA)
- [Bun](https://bun.sh/docs/installation) or Node.js with npm
- Any MCP-compatible client (e.g. [Claude Desktop](https://claude.ai/download), Cursor, Windsurf, Cline)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/Dan8Oren/mcp-apple-notes
cd mcp-apple-notes
```

2. Install dependencies:

```bash
bun install
# or
npm install
```

## Usage

Add the server to your MCP client configuration. The config format below works with Claude Desktop, but other clients follow a similar pattern — refer to your client's MCP documentation.

### Claude Desktop

1. Open Settings -> Developer -> Edit Config

![Claude Desktop Settings](./images/desktop_settings.png)

2. Add the following to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-apple-notes/index.ts"]
    }
  }
}
```

Or if using Bun:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-apple-notes/index.ts"]
    }
  }
}
```

3. Restart your client. Start by indexing your notes — ask your AI assistant to "index my notes".

## Troubleshooting

For Claude Desktop, check logs at:

```bash
tail -n 50 -f ~/Library/Logs/Claude/mcp-server-apple-notes.log
# or
tail -n 50 -f ~/Library/Logs/Claude/mcp.log
```

## Available Tools

| Tool | Description |
|------|-------------|
| `list-notes` | List titles of all indexed notes |
| `list-folders` | List all Apple Notes folders with full paths and note counts |
| `get-note` | Get full content and details of a note by title |
| `get-notes-by-path` | Get all notes in a folder by its full path (e.g. `iCloud/Work/Projects`) |
| `search-notes` | Semantic + full-text search with optional path filter and limit |
| `index-notes` | Index all notes for search |
| `create-note` | Create a new Apple Note |

