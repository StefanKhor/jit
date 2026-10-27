# JIT — a search engine for agent skills and tools

**An agent describes the task; JIT returns the tested procedure — a skill
body, or the right MCP tool from a connected server. Everything stays local.**

```
agent: "deploy a node app to azure"
   |
   v
JIT_FIND  ->  deploy-node-azure    (skill: full procedure)
          ->  deploy_azure_app     (MCP tool, server "tester")
   |
agent reads both, then runs the tool on that server itself
```

## Quick start

Requires **Node.js 24** (runtime) and **Bun** (package manager).

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
bun install
bun run build
bun run start
```

Open <http://localhost:3000>. For development: `bun run dev`
(dashboard on :5173, API on :3000).

## Connect your agent

Add JIT to your MCP client — Claude Desktop, Cursor, or any client using the
standard shape:

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

If you ran `bun link` in the repo, `"command": "jit"` and `"args": ["serve"]`
also work.

Restart the client. The agent sees two tools:

| Tool | What it does |
|---|---|
| `JIT_FIND(intent)` | Search. One sentence like `"deploy a node app to azure"`. Returns the best-fitting skill body — or `{"found": false}` with `near_misses` when nothing clears the bar. A hit can also be an MCP tool: its content names the server to call it on and the arguments it takes. |
| `JIT_RUN(name)` | Load one entry's body by exact name — a skill the agent wants directly, or the tool name `JIT_FIND` surfaced. |

That is the whole agent-facing surface. JIT routes; it never executes an MCP
tool for the agent — the agent calls it on the server that owns it. Indexing
happens on the dashboard, not through the agent.

A short client instruction makes triggering reliable. Add this to your system
prompt or `AGENTS.md`:

```text
Before any multi-step task — and again whenever the work shifts to a new kind
of task (a new platform, domain, or unfamiliar tool), not just the first task
of the session — call JIT_FIND. Phrase the intent like a search query: one
sentence, concrete action plus platform or domain, e.g. "deploy a node app to
azure". Leave out file paths and task details. Skip it for single-step actions
you can do directly, or when a skill for this kind of work is already in
context. On {"found": false} with near_misses, retry once with different
phrasing, then proceed normally. A hit may return several skills when more
than one fits the same intent, and may list related skills — call again for
the next domain. Checking is the default, skipping is the exception: a lookup is
cheap, a missed skill is expensive.
```

`JIT_FIND` is declared `readOnlyHint` and `idempotentHint`, so clients that
gate tool calls on those hints can auto-approve it. Do not call JIT on every
message — a needless retrieval adds latency and can inject an irrelevant
skill; the agent's own judgment is the filter.

## Getting skills in

Open **Skills → Transfer** in the dashboard. Three doors, all explicit —
nothing is ever auto-scanned:

1. **Pull from repo** — enter `owner/name` or an https clone URL. JIT clones
   it (shallow) into `~/.jit/repos/<repo>` and offers the discovered skills for
   import. Re-pulling runs `git pull`, so updates are one click.
2. **Local folder** — point at a directory; copy the skills into JIT, or index
   them in place with no copy (JIT reads the files where they are).
3. **Scan** — sweep the standard folders you already use (`~/.claude/skills`,
   `~/.agents/skills`, `~/.codex/skills`, `~/.config/opencode/skills`,
   `~/.skills`, and JIT's own `~/.jit/skills`). Only when you press the button.

Skills are standard `SKILL.md` with YAML frontmatter; the id comes from
`name` (or the folder name if omitted). Removal: **Unindex** drops just the
index row (source file untouched); **Uninstall** deletes JIT's own copy too.
**Out of JIT** exports skills to a destination folder of your choice.

## Skills and MCP tools live in one index

JIT indexes two kinds of entries and searches them together:

- **Skills** — the index stores names, descriptions, paths, and vectors;
  bodies are read from disk only for the entries returned, so keep indexed
  skills where they were indexed.
- **MCP tools** — every server connected on the **MCP** page gets its tools
  indexed under `mcp/<server>/<tool>`, with the description and argument
  sketch stored in the index. Disconnecting a server sweeps its entries;
  reconnecting re-indexes them.

The MCP page manages JIT's own server definitions in `~/.jit/mcp.json`:
import from client configs (`~/.cursor/mcp.json`, `~/.claude.json`,
`~/.config/opencode/opencode.json`, `./.mcp.json`, `./mcp.json`), add a stdio
or HTTP/SSE server manually, connect/disconnect, and run a tool by hand — a
human convenience for testing a connection. The agent path never goes through
JIT's execution: `JIT_FIND` routes, the agent calls the tool on its server
directly. JIT does not forward tool calls, resources, prompts, or
notifications; connect the servers your client needs directly to it.

## How retrieval works

1. **Embeddings** — local `Xenova/bge-small-en-v1.5` (384 dims) by default, or
   a configured OpenAI-compatible API. Embeddings are mandatory: if the model
   or the stored vectors are unavailable, JIT returns no match with an
   explanation rather than degrading to keyword search.
2. **Vector search** — cosine similarity over `index.json`. Each entry is
   embedded from its name, description, and the opening prose of its body.
3. **Rerank** — when a chat-completions endpoint is configured, it selects the
   entries that fit (up to three, or none); its verdict is the answer. Without
   one, JIT falls back to cosine and says so.
4. **Confidence gate** — a cosine match must clear the threshold on both its
   raw score and its lead over the rest of that query's scores (unrelated
   skills share a common embedding direction, so raw cosine alone admits
   almost everything). Default `0.60`. Below the bar, `JIT_FIND` returns
   `{"found": false}` with up to three `near_misses` so the agent can retry
   once with a sharper intent instead of silently guessing.

Changing the embedding provider, model, or dimensions invalidates the stored
vectors — rebuild from Settings.

## Configuration

All settings are optional. The dashboard writes them to `~/.jit/config.json`
with `0600` permissions; environment variables win and are never written back.
JIT does not load `.env` files.

| Variable | Description | Default |
|---|---|---|
| `JIT_HOME` | Index and config directory | `~/.jit` |
| `JIT_HOST` / `JIT_PORT` | Dashboard bind address / port | `127.0.0.1` / `3000` |
| `JIT_API_KEY` | Require a key for `/api/*` | unset |
| `JIT_CONFIDENCE_THRESHOLD` | Minimum confidence to return a match (0–1) | `0.60` |
| `JIT_TOP_K` | Candidates retrieved before rerank | `10` |
| `JIT_EMBEDDING_PROVIDER` | `local` or `openai-compatible` | `local` |
| `JIT_EMBEDDING_API_KEY` / `JIT_EMBEDDING_API_BASE` / `JIT_EMBEDDING_API_MODEL` / `JIT_EMBEDDING_API_DIM` | Remote embeddings config (key not needed for localhost) | unset |
| `JIT_RERANK_API_KEY` / `JIT_RERANK_API_BASE` / `JIT_RERANK_MODEL` | OpenAI-compatible reranker | unset |
| `JIT_MODEL_CACHE` | Local embedding-model cache | `$JIT_HOME/models` |
| `JIT_MAX_REQUEST_BYTES` / `JIT_MAX_SKILL_BYTES` | API body limit / skill file limit | `16777216` / `2097152` |
| `JIT_LOG_LEVEL` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |

With local embeddings the model downloads once (~130 MB) into
`JIT_MODEL_CACHE`; after that, retrieval needs no network. Cloud embeddings
send indexed text and search queries to the configured endpoint — configure
that only when you accept the data handling and possible costs.

## Dashboard

A single-file React SPA served by the Node process at <http://localhost:3000>.

- **Overview** — context per task vs. a catalog, the break-even index size,
  plain files vs. JIT-indexed.
- **Skills** — list, read, enable/disable, transfer, pull from a repo, remove.
- **MCP** — add or import servers, connect/disconnect, inspect tools, run a
  tool manually.
- **Search** — live retrieval against the real index.
- **Settings** — embeddings, reranker, threshold, auth, import/export, clear.

Auth is opt-in: set `JIT_API_KEY` and `/api/*` requires a bearer or
`X-API-Key` header (constant-time compare). The dashboard binds `127.0.0.1`
by default and refuses a non-loopback bind without an API key.

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

The image runs as a non-root user, warms the embedding model at build time,
and keeps the index in the `/data` volume. Health: `GET /api/health`. Behind a
public domain, terminate TLS at a reverse proxy and always set `JIT_API_KEY`.

## Architecture

```
web/ (React + Vite, single-file build)
        |  JSON over HTTP
        v
src/server/dashboard.ts --> src/retrieval/retriever.ts
        |                         |
        |                         v
        |                  embeddings + OpenAI-compatible reranker
        v
src/indexer.ts --> src/storage/store.ts --> ~/.jit
        ^
src/mcp-server.ts (stdio) --> src/mcp/client.ts --> stdio / HTTP / SSE
```

- **Storage** — one plain file, no database. `index.json` holds metadata,
  vectors, and (for MCP tools and path-less imports) stored bodies; skill
  bodies otherwise stay on disk. Writes are atomic; a content hash keeps the
  file self-consistent.
- **Concurrency** — the dashboard is async; the MCP client owns one connection
  per server, deduplicates connects, and times out hung ones.
- **Security** — local by default, size-limited request bodies, resolved and
  checked delete paths, `0600` secret files, constant-time key compares,
  cross-site browser writes rejected.

## NixOS

If the local ONNX runtime cannot find `libstdc++.so.6`:

```bash
export JIT_LD_LIBRARY_PATH=/nix/store/.../usr/lib64
```

The CLI re-execs itself once with that directory on the loader path; elsewhere
it is a no-op.

## Hackathon

Built for the Nebius x NVIDIA Global AI Hackathon. In Settings, select **Use
Nebius Token Factory + NVIDIA Nemotron 3.5 Lightning** and enter a Nebius Token
Factory API key to rerank every lookup through NVIDIA's open-weight
`nvidia/Nemotron-3_5-Lightning`. Source is public under the MIT
[LICENSE](LICENSE).
