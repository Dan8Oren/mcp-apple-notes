# MCP Apple Notes

![MCP Apple Notes](./images/logo.png)

> **Fork of [RafalWilinski/mcp-apple-notes](https://github.com/RafalWilinski/mcp-apple-notes)** — actively maintained with bug fixes and additional features.

A [Model Context Protocol (MCP)](https://www.anthropic.com/news/model-context-protocol) server that enables semantic search and RAG (Retrieval Augmented Generation) over your Apple Notes. This allows AI assistants like Claude to search and reference your Apple Notes during conversations.

![MCP Apple Notes](./images/demo.png)

## Features

- 🔍 Semantic search over Apple Notes using [`all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) on-device embeddings model
- 📝 Full-text search capabilities
- 📂 Folder support — list folders, browse by folder, filter search by folder
- 📊 Vector storage using [LanceDB](https://lancedb.github.io/lancedb/)
- 🤖 MCP-compatible server for AI assistant integration
- 🍎 Native Apple Notes integration via JXA
- 🏃‍♂️ Fully local execution - no API keys needed

## Prerequisites

- [Bun](https://bun.sh/docs/installation) or Node.js with npm
- [Claude Desktop](https://claude.ai/download)

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

1. Open Claude desktop app and go to Settings -> Developer -> Edit Config

![Claude Desktop Settings](./images/desktop_settings.png)

2. Open the `claude_desktop_config.json` and add the following entry:

```json
{
  "mcpServers": {
    "local-machine": {
      "command": "/Users/<YOUR_USER_NAME>/.bun/bin/bun",
      "args": ["/Users/<YOUR_USER_NAME>/apple-notes-mcp/index.ts"]
    }
  }
}
```

Important: Replace `<YOUR_USER_NAME>` with your actual username.

3. Restart Claude desktop app. You should see this:

![Claude MCP Connection Status](./images/verify_installation.png)

4. Start by indexing your notes. Ask Claude to index your notes by saying something like: "Index my notes" or "Index my Apple Notes".

## Troubleshooting

To see logs:

```bash
tail -n 50 -f ~/Library/Logs/Claude/mcp-server-local-machine.log
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

