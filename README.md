# JIT — Just-In-Time Skill & MCP Tool Loader

**JIT is a local MCP server and web dashboard that gives an agent one skill or
tool at a time, instead of every skill and tool schema at startup.**

The agent calls `JIT_FIND("create a Linear issue for the login bug")`. JIT
searches a local index and returns the single best match — or
`{"found": false}`, so the agent falls back to its built-in tools. During
retrieval, nothing leaves the machine unless you enable the optional Nebius
reranker.

The dashboard is the primary interface. Every number in it is computed from
the actual index: real body lengths, real entry counts, real cosine scores.
Nothing is hardcoded.

## Quick start

Requires **Node.js 24** and npm 11.

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
npm ci
npm run build
npm start
```

Open <http://localhost:3000>. The first-run panel lets you add an optional
Nebius API key, install from the marketplace, or import skills you already
use. Nothing is read from your client configs automatically.

For development:

```bash
npm run dev
# dashboard: http://127.0.0.1:5173
# API:       http://127.0.0.1:3000
```

The production build is a single self-contained `static/dashboard.html` served
by the Node process. There is no CDN, telemetry, or runtime frontend build.

## Connect your agent

Add JIT to your MCP client. For Claude Desktop, Cursor, or any client that uses
the standard `mcpServers` shape:

```json
{
  "mcpServers": {
    "jit": {
      "command": "node",
      "args": ["/absolute/path/to/jit/dist/cli.js", "serve"]
    }
  }
}
```

For OpenCode:

```json
{
  "mcp": {
    "jit": {
      "type": "local",
      "command": ["node", "/absolute/path/to/jit/dist/cli.js", "serve"],
      "enabled": true
    }
  }
}
```

If you ran `npm link` in the repo, `"command": "jit"` and
`"args": ["serve"]` also work.

Restart the client. The agent now sees four tools:

| Tool | What it does |
|---|---|
| `JIT_FIND(intent)` | Search skills and MCP tools. Returns the best match or `{"found": false}`. |
| `JIT_ADD(source)` | Add a skill file, folder, URL, inline markdown, or an installed JIT MCP server. |
| `JIT_CALL(tool_id, arguments)` | Execute an indexed MCP tool through its server. |
| `JIT_STATUS()` | Index counts, connected servers, and retrieval settings. |

### Triggering JIT

MCP is pull-based: the server cannot push a skill into the model's context.
JIT stays connected for the session, and the agent decides when to call it.
The tool descriptions tell the agent to call `JIT_FIND` for multi-step tasks
and skip it for trivial ones. A one-line client instruction removes the
remaining ambiguity. Add this to your system prompt or `AGENTS.md`:

```text
Before a multi-step task that may have a specialized workflow, call
JIT_FIND with a concrete intent: the action, the object, and the outcome.
Skip it for trivial tasks. If it returns {"found": false}, proceed normally.
```

Do not call JIT on every message. A needless retrieval adds latency and can
inject an irrelevant skill; the agent's own judgment is the filter. If the
first intent misses, the agent may retry once with a different phrasing, then
continue. There is no server-side retry loop.

A truly passive mode (retrieve on every user message and prepend the result)
requires a client-side hook or plugin, not an MCP server. The pull model is
cheaper and more predictable.

## The dashboard

A single-file React SPA served by the Node process.

- **Overview** — context per task vs. static loading, reduction or overhead,
  index composition, heaviest entries, categories.
- **Skills** — list, read, enable/disable, index a path, transfer, and remove.
- **Marketplace** — browse a bundled catalog of skills and MCP servers; install
  and uninstall explicitly.
- **MCP** — connect, disconnect, index tools, import a client config, export
  JIT-managed servers, add a server manually.
- **Search** — live retrieval with cosine, rerank score, RRF, threshold, and
  the exact result the agent would receive.
- **Settings** — Nebius key and models, dashboard auth, import/export, clear.

The first-run panel is skippable. The dashboard listens on `127.0.0.1` by
default. Use `--host 0.0.0.0` only behind a trusted proxy.

### Removal semantics

- **Unindex** (a skill imported from a local path) removes the index entry only.
  The source file is untouched.
- **Uninstall** (a JIT-owned copy, including marketplace skills) deletes the
  copy at `~/.jit/skills/<id>/SKILL.md` and its index entry. Any original local
  file is untouched.
- **Remove** (an MCP server) deletes JIT's own server definition and its
  indexed tools. The external server and any client config are untouched.

### Transfer semantics

- **Into JIT** copies a skill into `~/.jit/skills/<id>/SKILL.md`, or indexes a
  path in place without copying.
- **Out of JIT** exports indexed skills to
  `<destination>/<id>/SKILL.md`. The dashboard defaults to `~/jit-skills`;
  change it to target a client's skill folder.
- **MCP export** merges JIT-managed servers into a client config. JIT keeps its
  own copy. Both standard `mcpServers` and OpenCode's `mcp` shape are supported.

Nothing is imported from `~/.claude`, Cursor, or OpenCode automatically.
Imports are explicit, read-only on the source side, and shown before they run.

## How retrieval works

1. **Embeddings** — `Xenova/bge-small-en-v1.5` runs locally through
   Transformers.js (384 dimensions).
2. **Vector search** — cosine similarity over embeddings stored in SQLite.
3. **Keyword search** — BM25 over names, descriptions, aliases, and bodies.
4. **Fusion** — Reciprocal Rank Fusion merges both rankings.
5. **Rerank (optional)** — NVIDIA Nemotron Nano via Nebius Token Factory
   reorders the top candidates when an API key is configured.
6. **Threshold** — confidence is the best cosine or rerank score. The default
   is `0.60`; a reranked candidate can be promoted above it.
7. **Top-1** — the agent gets one body or `{"found": false}`. There is no
   retry loop inside the server.

The pipeline is deliberately single-pass. A miss costs one search and the agent
continues; it never stalls on retrieval. There is no chunking.

## Configuration

All settings are optional. The dashboard writes them to
`~/.jit/config.json` with `0600` permissions. Environment variables win over
the file and are never written back.

| Variable | Description | Default |
|---|---|---|
| `NEBIUS_API_KEY` | Enables Nemotron Nano reranking | unset |
| `NEBIUS_API_BASE` | Nebius Token Factory base URL | `https://api.studio.nebius.ai/v1` |
| `NEMOTRON_NANO_MODEL` | Reranker model | `nvidia/nemotron-nano-9b-v2` |
| `NEMOTRON_ULTRA_MODEL` | Demo agent model | `nvidia/nemotron-3-ultra` |
| `JIT_API_KEY` | Requires a key for `/api/*` | unset |
| `JIT_HOME` | Index and config directory | `~/.jit` |
| `JIT_MODEL_CACHE` | Local embedding-model cache | `$JIT_HOME/models` |
| `JIT_HOST` | Dashboard bind address | `127.0.0.1` |
| `JIT_PORT` | Dashboard port | `3000` |
| `JIT_CONFIDENCE_THRESHOLD` | Minimum confidence (cosine or rerank) | `0.60` |
| `JIT_TOP_K` | Candidates retrieved before fusion | `20` |
| `JIT_EMBEDDING_MODEL` | Transformers.js model | `Xenova/bge-small-en-v1.5` |
| `JIT_EMBEDDING_DIM` | Expected vector size | `384` |
| `JIT_MARKETPLACE_URL` | Optional remote catalog URL | unset |
| `JIT_MAX_REQUEST_BYTES` | Dashboard API body limit | `16777216` |
| `JIT_MAX_SKILL_BYTES` | Skill file limit | `2097152` |
| `JIT_LOG_LEVEL` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |

JIT does not load `.env` files automatically. Export variables in your shell
or pass them to Docker; the dashboard writes persistent settings to
`config.json`. On first use JIT downloads the embedding model once into
`JIT_MODEL_CACHE`; after that, retrieval is fully local.

Auth is opt-in. When `JIT_API_KEY` is set (or a key is saved in Settings),
`/api/*` requires `Authorization: Bearer <key>` or `X-API-Key: <key>`. The
dashboard HTML is served unauthenticated so the login form can load. The key is
checked with a constant-time comparison. The browser stores the key in
`localStorage`; the server stores only the configured key in a `0600` file.

## Skill format

Standard `SKILL.md` with YAML frontmatter. No conversion needed:

```markdown
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

The skill id comes from `name` (or the folder/file name if omitted). Default
scan paths, used only when you explicitly ask JIT to scan:

`~/.skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`,
`~/.config/opencode/skills`, `./.opencode/skills`, `./skills`.

## MCP tools

JIT manages its own server definitions in `~/.jit/mcp.json`. It does not load
servers from client configs at startup. On the MCP page you can:

- **Import configs** from `~/.cursor/mcp.json`, `~/.claude.json`,
  `~/.config/opencode/opencode.json`, `./.mcp.json`, and `./mcp.json`.
- **Export** JIT-managed servers into a client config.
- **Add** a stdio or streamable HTTP/SSE server manually.

Indexed tools are embedded alongside skills, so one `JIT_FIND` searches both.
`JIT_CALL` proxies execution to the owning server.

## Marketplace

The bundled catalog lives in `marketplace.json`. A remote catalog can be
merged in with `JIT_MARKETPLACE_URL`. Remote catalog and skill URLs must use
HTTPS; plain HTTP is accepted only for localhost. Installs are explicit:

- Skills are written to `~/.jit/skills/<id>/SKILL.md` and indexed.
- MCP servers are written to `~/.jit/mcp.json`, connected, and their tools are
  indexed. The dashboard requires an explicit “I understand this starts a local
  process” confirmation.
- Uninstalling a marketplace skill removes JIT's copy and index entry. Removing
  an MCP server leaves external configs and processes alone.

## Deployment

```bash
JIT_API_KEY="$(openssl rand -hex 24)" \
  node dist/cli.js dashboard --host 0.0.0.0 --port 3000
```

Docker:

```bash
docker build -t jit .
docker run --rm -p 3000:3000 -v jit-data:/data \
  -e JIT_API_KEY=replace-me jit
```

The image runs as a non-root user, warms the embedding model at build time, and
stores the index in the `/data` volume. The health endpoint is
`GET /api/health`.

For a public demo, terminate TLS at a reverse proxy and set `JIT_API_KEY`.
Do not expose the dashboard directly to the internet without auth.

## Architecture

```
web/ (React + Vite, single-file build)
        │  JSON over HTTP
        ▼
src/server/dashboard.ts ──► src/retrieval/retriever.ts
        │                         │
        │                         ▼
        │                  SQLite + BM25 + optional Nemotron
        ▼
src/indexer.ts ──► src/storage/db.ts ──► ~/.jit
        ▲
src/mcp-server.ts (stdio) ──► src/mcp/client.ts ──► stdio / HTTP / SSE
```

- **Storage** — SQLite (`node:sqlite`) is the source of truth. Embeddings are
  stored as blobs; there is no separate vector file to rebuild. WAL mode and a
  content hash keep the index self-consistent.
- **Retrieval cache** — the BM25 corpus is keyed on a SQLite data signature, so
  a dashboard edit is visible to a separately running `jit serve` immediately.
- **Concurrency** — the dashboard is async; the MCP client owns one connection
  per server, deduplicates concurrent connects, and times out hung connections.
- **Security** — the API is local by default, request bodies are size-limited,
  paths are resolved and checked before JIT-owned files are deleted, and
  secrets are written with `0600` permissions.

## NixOS

If the local ONNX runtime cannot find `libstdc++.so.6`, point JIT at a
directory that contains it:

```bash
export JIT_LD_LIBRARY_PATH=/nix/store/.../usr/lib64
```

The CLI re-execs itself once with that directory on the loader path. On other
systems this is a no-op.

## Hackathon

Built for the Nebius x NVIDIA Global AI Hackathon.

- **NVIDIA model** — Nemotron Nano for reranking; Nemotron 3 Ultra powers the
  demo agent.
- **Nebius platform** — Token Factory for model access.
- **Dashboard** — real measurements from the local index, not marketing copy.
- **License** — MIT.

## License

MIT. See [LICENSE](LICENSE).
