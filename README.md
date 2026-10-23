# JIT — Just-In-Time Skill & MCP Tool Loader for AI Agents

**JIT** reduces context bloat by 97% for AI agents. Instead of loading 100 skill files and 60 MCP tool schemas upfront (8,000+ tokens), JIT indexes them locally and returns only the relevant one on demand (200 tokens).

## The problem

AI agents load every skill and tool schema into context at startup. With 100 skills + 60 MCP tools, that's 8,000+ tokens of context before the user even speaks. Most of it is irrelevant to any given task.

## The solution

JIT is a local MCP server with 3 tools:

| Tool | What it does |
|---|---|
| `JIT_FIND(intent)` | Universal search across skills + MCP tools. Returns the best match or `null`. |
| `JIT_ADD(source)` | Add skills or MCP tool manifests to the index. |
| `JIT_CALL(tool_id, args)` | Execute a discovered MCP tool. |

## Quick start

### 1. Install

```bash
pip install jit-mcp          # or: uv tool install jit-mcp
```

### 2. Start the dashboard

```bash
jit dashboard                # Opens web UI at http://localhost:8080
```

Everything is managed through the browser. No CLI needed.

### 3. Add skills

Open the dashboard → **Skills** tab → enter a path to your skills directory → click **Add**.

Default paths scanned: `~/.skills/`, `~/.claude/skills/`, `./skills/`

### 4. Configure (optional)

Go to **Manage** tab → enter your Nebius API key for Nemotron reranking (90%+ recall). Everything works without it (80% recall via hybrid search).

### 5. Connect to your AI agent

Add to your MCP client config (`~/.cursor/mcp.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "jit": {
      "command": "jit",
      "args": ["serve"]
    }
  }
}
```

### 6. Use

Your agent now has `JIT_FIND`, `JIT_ADD`, and `JIT_CALL`. Ask it to do something — it'll search JIT for the right skill or tool.

## How it works

```
Agent starts → only sees JIT_FIND, JIT_ADD, JIT_CALL (3 tools, ~200 tokens)
User: "Create a Linear issue for the login bug"
Agent: JIT_FIND("create a Linear issue") → returns skill body
Agent: follows skill instructions → creates issue
Only 1 skill's content entered context (not 100)
```

## Web dashboard

The dashboard is the primary interface. Everything is managed through the browser:

- **Overview** — tokens saved, reduction %, indexed counts, categories
- **Skills** — list, view, enable/disable, remove, add from path
- **MCP Servers** — list configured servers, connect, index tools
- **Search** — live search with confidence scores
- **Manage** — settings (Nebius API key), import/export, clear index

### Production deployment

```bash
# With auth
JIT_API_KEY=your-secret jit dashboard --host 0.0.0.0 --port 8080
```

### Docker

```bash
docker build -t jit .
docker run -p 8080:8080 -v ~/.jit:/root/.jit jit
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              Web Dashboard (localhost:8080)  │
│  (manage skills, MCPs, search, settings)    │
├─────────────────────────────────────────────┤
│              JIT MCP Server (stdio)          │
│  (JIT_FIND, JIT_ADD, JIT_CALL, JIT_STATUS)  │
├────────────┬────────────┬───────────────────┤
│   Indexer  │  Retriever │   MCP Client      │
│ (FAISS +   │ (BM25 +    │ (connect, list,   │
│  SQLite)   │  vector +  │  execute tools)   │
│            │  Nano)     │                   │
└────────────┴────────────┴───────────────────┘
```

## Retrieval pipeline

1. **BM25** keyword search (exact term matching)
2. **Vector search** via FAISS (semantic similarity, bge-small-en-v1.5)
3. **RRF merge** (Reciprocal Rank Fusion combines both)
4. **Nemotron Nano rerank** (optional, via Nebius Token Factory — improves recall 80%→95%)
5. **Confidence threshold** 0.60 (cosine similarity)
6. **Top-1** returned (or `null` if below threshold)

## MCP tool support

JIT can index MCP tools alongside skills:

1. **Discovery**: `jit dashboard` → MCP Servers tab → enter server name → Connect
2. **Indexing**: Click "Index Tools" to fetch tool manifests and embed them
3. **Retrieval**: `JIT_FIND` searches both skills and tools
4. **Execution**: `JIT_CALL(tool_id, arguments)` proxies to the MCP server

## Configuration

Settings are stored in `~/.jit/config.json` and can be edited via the web UI or environment variables:

| Variable | Description | Default |
|---|---|---|
| `JIT_API_KEY` | API key for dashboard auth | (auto-generated) |
| `NEBIUS_API_KEY` | Nebius API key for Nemotron reranking | (disabled) |
| `NEBIUS_API_BASE` | Nebius API base URL | `https://api.studio.nebius.ai/v1` |
| `JIT_LOG_LEVEL` | Logging level | `INFO` |

## Skill format

Standard `SKILL.md` with YAML frontmatter. No format changes needed:

```yaml
---
name: linear-create-issue
description: Create a new issue in a Linear team
categories: [project-management, issue-tracking]
aliases: [file a bug, open a ticket, report an issue]
when_to_use: User wants to create, file, or report an issue
---
# Linear: Create Issue
...
```

## Tech stack

| Component | Technology |
|---|---|
| Embeddings | bge-small-en-v1.5 (local, free) |
| Vector store | FAISS (IndexFlatIP) |
| Metadata | SQLite |
| Keyword search | BM25 (rank_bm25) |
| Reranking | Nemotron Nano (via Nebius Token Factory) |
| MCP server | Python MCP SDK (stdio) |
| Dashboard | Single HTML file (no build step) |
| Packaging | pip (jit-mcp) + npm wrapper (npx jit-mcp) |

## Hackathon

Built for the Nebius x NVIDIA Global AI Hackathon.

- **NVIDIA model**: Nemotron Nano for reranking
- **Nebius platform**: Token Factory for API access
- **Demo**: 100 skills + 60 MCP tools → 200 tokens context

## License

MIT