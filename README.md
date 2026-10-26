# JIT — a search engine for skills

**JIT works like a search engine for an agent's skills: the agent describes the
task, JIT routes it to the tested procedure for it — not ten links to read and
assemble. Everything stays local.**

What makes it worth running:

**Routing, with abstention.** At task time the agent calls
`JIT_FIND("create a Linear issue for the login bug")` and gets the
best-matching skill — or, when nothing clears the bar, `{"found": false}` plus
a short `near_misses` list instead of a silent wrong answer. You carry one
body, not a catalog. A multi-part task spans skills: a confident hit also lists
up to two related skill names, and a second call loads the next body — a couple
of bodies at most, never a catalog. The MCP response carries only skill names,
paths, and bodies — scores and ranking notes stay on the dashboard, where a
human reads them. The whole shipped MCP surface is one tool: `JIT_FIND`.

JIT stays quiet until it is called. MCP is pull-based, so JIT is built to be
*invoked*, not to push: a small tool surface, sharp descriptions, and no
background work in the agent's loop.

Local embeddings are the default. If you explicitly choose a cloud embedding
provider or remote reranker, the corresponding text is sent to that configured
endpoint and may incur provider costs.

The dashboard is the primary interface. Every index number in it is computed
from the actual index: real body lengths, real entry counts, real cosine
scores. Nothing about your data is hardcoded. The one fixed figure — the
context cost of JIT's own MCP tool schema — is measured from the live
`tools/list` payload at runtime, not written down by hand.

## Quick start

Requires **Node.js 24** (runtime) and **Bun** (package manager).

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
bun install
bun run build
bun run start
```

Open <http://localhost:3000>. The first-run panel lets you import skills you
already use. Nothing is read from your client configs automatically.

For development:

```bash
bun run dev
# dashboard: http://127.0.0.1:5173
# API:       http://127.0.0.1:3000
```

The production build is a single self-contained `static/dashboard.html` served
by the Node process. There is no CDN or runtime frontend build.

## Upgrading

Pull a new version, run `bun run build`, and restart any running `jit serve`:
MCP servers are spawned long-lived by the client, so new code takes effect only
when the client restarts the server. The index stores metadata and vectors,
not bodies — an older build reading that index can answer `found: true` with
empty content and no warning. On the new build a plain restart fixes it; no
reindex is needed unless the embedding provider, model, or dimensions changed.

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

If you ran `bun link` in the repo, `"command": "jit"` and
`"args": ["serve"]` also work.

Restart the client. The agent now sees one tool:

| Tool | What it does |
|---|---|
| `JIT_FIND(intent)` | Load the skill(s) that fit a concrete multi-step task. Returns the skill body — several when the reranker judges more than one fits — or `{"found": false}` with `near_misses`. |

That is the whole surface. JIT is skills-only: every tool name, description, and
schema sits in the agent's context for the entire session, so nothing else
ships. Indexing happens on the dashboard, not through the agent.

### Triggering JIT

MCP is pull-based: the server cannot push a skill into the model's context.
JIT stays connected for the session, and the agent decides when to call it.
The tool descriptions tell the agent to call `JIT_FIND` for multi-step tasks
and skip it for trivial ones. A short client instruction removes the
remaining ambiguity. Add this to your system prompt or `AGENTS.md`:

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

The rule is written as a **recurring condition**, not a one-time "start of task"
cue: a trigger an agent meets once decays as the session grows, while one it
re-meets on every domain shift keeps firing. `JIT_FIND` is also declared
`readOnlyHint` and `idempotentHint`, so clients that gate tool calls on those
hints can auto-approve it — no approval prompt between the agent and a lookup.

Do not call JIT on every message. A needless retrieval adds latency and can
inject an irrelevant skill; the agent's own judgment is the filter. If the
first intent misses, the agent may retry once with a different phrasing, then
continue. There is no server-side retry loop.

A truly passive mode (retrieve on every user message and prepend the result)
requires a client-side hook or plugin, not an MCP server. The pull model is
cheaper and more predictable.

## Where JIT fits — and where it does not

Being honest about the boundary is part of being production-ready.

- **Small indexes are a net cost.** JIT adds a fixed per-task cost: the schema of
  its one shipped tool plus one retrieved body. The
  alternative keeps the whole catalog — every name and description — in context
  plus the one body a task loads. The Overview page shows the **break-even
  count** where the two cross: the point at which the catalog outgrows JIT's
  fixed tool schema. Below a handful of entries, listing your skills is cheaper
  and simpler, and JIT says so on the page rather than pretending otherwise. JIT
  earns its place when you have many skills.
- **Attention is still the agent's job.** An MCP server cannot push context; the
  agent has to call `JIT_FIND`. The tool descriptions plus a one-line client
  instruction (above) are the lever. If a client ever offers a retrieval hook,
  that is the better integration — JIT is built to be the retrieval engine behind
  one.
- **Cross-client, local, and offline is the durable part.** A single client can
  absorb "tool search" natively, but it will not index *other* clients' skills,
  run in an air-gapped environment, or keep your catalog on your machine. JIT
  indexes skills from paths owned by Claude, Cursor,
  OpenCode, and plain files, with no network dependency once the model is cached.
- **JIT is not a passthrough.** JIT is a retrieval index for skills — it returns
  a skill body and nothing else. It does not forward tool calls, resources,
  prompts, or notifications; connect those servers to your client directly if
  you need them.

## The dashboard

A single-file React SPA served by the Node process.

- **Overview** — context per task vs. a skill catalog, reduction or overhead,
  the break-even index size, index composition, and heaviest entries.
- **Skills** — list, read, enable/disable, index a path, transfer, and remove.
- **MCP** — connect, disconnect, import a client config, add a server manually.
- **Search** — live retrieval: the reranker's picks, or cosine scores against
  the confidence slider on the cosine-only fallback.
- **Settings** — local/cloud embeddings, the reranker, confidence threshold, dashboard auth,
  import/export, clear.

The first-run panel is skippable. The dashboard listens on `127.0.0.1` by
default. Use `--host 0.0.0.0` only behind a trusted proxy.

### Removal semantics

- **Unindex** (a skill imported from a local path) removes the index entry only.
  The source file is untouched.
- **Uninstall** (a JIT-owned copy) deletes the
  copy at `~/.jit/skills/<id>/SKILL.md` and its index entry. Any original local
  file is untouched.
- **Remove** (an MCP server) deletes JIT's own server definition. The external
  server and any client config are untouched.

### Transfer semantics

- **Into JIT** copies a skill into `~/.jit/skills/<id>/SKILL.md`, or indexes a
  path in place without copying.
- **Out of JIT** exports indexed skills to
  `<destination>/<id>/SKILL.md`. The dashboard defaults to `~/jit-skills`;
  change it to target a client's skill folder.

Nothing is imported from `~/.claude`, Cursor, or OpenCode automatically.
Imports are explicit, read-only on the source side, and shown before they run.

## How retrieval works

1. **Embeddings** — local `Xenova/bge-small-en-v1.5` through Transformers.js
   (384 dimensions) by default, or a configured OpenAI-compatible embeddings API.
2. **Vector search** — cosine similarity over embeddings stored in `index.json`,
   top candidates kept. Each skill is embedded from its name, its description, and
   the opening prose of its body (up to 500 characters, with headings, banners,
   tables, lists, and code skipped), so wording that only appears in the body is
   still findable. The index stores metadata and vectors only — bodies are read
   from the skill files just for the entries actually returned, so keep indexed
   skills where they were indexed.
3. **Rerank (the decision layer)** — any OpenAI-compatible chat-completions
   endpoint reads the top vector candidates and *selects* the ones that fit the
   intent — up to three, or none. When an endpoint is configured, every lookup
   is reranked and its verdict is the answer, including "none of these fit"; an
   unconfigured install falls back to cosine and says so in the response.
4. **Confidence, and the threshold** — a vector match is not judged on its raw
   cosine alone. Two unrelated skills already score around `0.56`, because every
   embedding shares a common direction, so an absolute cutoff mostly measures
   "is this English": on a 90-skill index the stock `0.60` admitted 99% of
   lookups and 40% of what it returned was the wrong skill. The decision instead
   takes the weaker of two readings — the raw cosine, and how far the winner
   stands above the rest of *that query's* scores — so a match has to clear the
   threshold on both. The number shown as confidence is that same pair reduced
   to one value, which is why a high cosine that does not stand out still reads
   as a low confidence. Reranked results carry no confidence — the reranker's
   choice is categorical, so the threshold gates only the cosine fallback. A
   small index, too small to have a meaningful spread, falls back to the raw
   cosine. The default threshold is `0.60`.
5. **Two-tier result** — a candidate above the threshold returns one skill body.
   Below it, `JIT_FIND` returns `{"found": false}` with up to
   three `near_misses` (names), so the agent can retry once with a sharper
   intent instead of silently giving up.

The pipeline is deliberately single-pass. A miss costs one search and the agent
continues; it never stalls on retrieval. There is no chunking.

Embeddings are mandatory for retrieval. If the model/provider or stored
vectors are unavailable, Search and `JIT_FIND` return no match and explain why.
Changing provider, model, endpoint, or dimensions invalidates the existing
vectors; rebuild them from Settings before retrieving again.

## Configuration

All settings are optional. The dashboard writes them to
`~/.jit/config.json` with `0600` permissions. Environment variables win over
the file and are never written back.

| Variable | Description | Default |
|---|---|---|
| `JIT_RERANK_API_KEY` | API key for an OpenAI-compatible reranker | unset |
| `JIT_RERANK_API_BASE` | OpenAI-compatible chat-completions base URL | unset |
| `JIT_RERANK_MODEL` | Reranker model identifier | unset |
| `JIT_API_KEY` | Requires a key for `/api/*` | unset |
| `JIT_HOME` | Index and config directory | `~/.jit` |
| `JIT_MODEL_CACHE` | Local embedding-model cache | `$JIT_HOME/models` |
| `JIT_HOST` | Dashboard bind address | `127.0.0.1` |
| `JIT_PORT` | Dashboard port | `3000` |
| `JIT_CONFIDENCE_THRESHOLD` | Minimum confidence to return a match; a vector match clears it on both its raw score and its standing above the query's other scores (0–1) | `0.60` |
| `JIT_TOP_K` | Candidates retrieved before rerank | `10` |
| `JIT_DISABLE_EMBEDDINGS` | Disable embedding requests; retrieval returns an unavailable warning | unset |
| `JIT_EMBEDDING_PROVIDER` | `local` or `openai-compatible` | `local` |
| `JIT_EMBEDDING_MODEL` | Local Transformers.js model | `Xenova/bge-small-en-v1.5` |
| `JIT_EMBEDDING_DIM` | Local model vector size | `384` |
| `JIT_EMBEDDING_API_KEY` | API key for remote embeddings (not needed for localhost) | unset |
| `JIT_EMBEDDING_API_BASE` | OpenAI-compatible embeddings API base URL | unset |
| `JIT_EMBEDDING_API_MODEL` | Cloud/local API model identifier | unset |
| `JIT_EMBEDDING_API_DIM` | API model output dimensions | `1536` |
| `JIT_MAX_REQUEST_BYTES` | Dashboard API body limit | `16777216` |
| `JIT_MAX_SKILL_BYTES` | Skill file limit | `2097152` |
| `JIT_LOG_LEVEL` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |

JIT does not load `.env` files automatically. Export variables in your shell
or pass them to Docker; the dashboard writes persistent settings to
`config.json`.

### Offline and air-gapped

With local embeddings, JIT downloads the model once into `JIT_MODEL_CACHE`
(about 130 MB); after that, retrieval is local and needs no network. To run
air-gapped, copy a populated model cache and use the local provider. Cloud
embeddings send indexed text and search queries to the configured endpoint;
configure that only when you accept the data handling and possible costs. If
embeddings are unavailable, JIT returns no match rather than changing retrieval
semantics. JIT does not choose or contact a cloud provider unless you configure
one, and keeps no configuration of its own beyond what you set in Settings.

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
---
# Linear: Create Issue

...
```

The skill id comes from `name` (or the folder/file name if omitted). Default
scan paths, used only when you explicitly ask JIT to scan:

`~/.skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`,
`~/.config/opencode/skills`, `./.opencode/skills`, `./skills`, and JIT's own
`~/.jit/skills`.

## MCP servers

JIT manages its own server definitions in `~/.jit/mcp.json`. It does not load
servers from client configs at startup. On the MCP page you can:

- **Import configs** from `~/.cursor/mcp.json`, `~/.claude.json`,
  `~/.config/opencode/opencode.json`, `./.mcp.json`, and `./mcp.json`.
- **Add** a stdio or streamable HTTP/SSE server manually.
- **Connect / disconnect** to verify a server and list the tools it exposes.

JIT's index is skills-only: it does not index or forward MCP tool calls, so
nothing is stored that JIT cannot return. Use the MCP page to keep server
definitions in one place; connect the servers your client needs directly.

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
        │                  embeddings + OpenAI-compatible reranker
        ▼
src/indexer.ts ──► src/storage/store.ts ──► ~/.jit
        ▲
src/mcp-server.ts (stdio) ──► src/mcp/client.ts ──► stdio / HTTP / SSE
```

- **Storage** — one plain file, no database. `index.json` is the source of
  truth: every skill's metadata and its base64 embedding, replaced atomically
  on each write. Bodies are not stored — they are read from the skill files at
  lookup time (only rows imported without a path keep their body in the file).
  A content hash keeps the index self-consistent.
- **Retrieval cache** — the corpus is keyed on the index file's mtime/size, so
  a dashboard edit is visible to a separately running `jit serve` immediately.
- **Concurrency** — the dashboard is async; the MCP client owns one connection
  per server, deduplicates concurrent connects, and times out hung connections.
- **Security** — the API is local by default, request bodies are size-limited,
  paths are resolved and checked before JIT-owned files are deleted, secrets are
  written with `0600` permissions, and keys are compared in constant time.

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

- **Nebius runtime integration** — in Settings, select **Use Nebius Token Factory + NVIDIA Nemotron 3.5 Lightning**, enter a Nebius Token Factory API key, and save. Every lookup is then reranked through Nebius Token Factory's OpenAI-compatible chat-completions API using NVIDIA's open-weight `nvidia/Nemotron-3_5-Lightning` model. Successful calls are recorded in the server log. The key can also be provided as `JIT_RERANK_API_KEY`.
- **Flexible embeddings and reranking** — built-in local embeddings remain the default; embeddings and reranking can also use configured OpenAI-compatible endpoints.
- **Public source** — [github.com/StefanKhor/jit](https://github.com/StefanKhor/jit) is public and includes the top-level MIT `LICENSE`.
- **Dashboard** — real measurements from the local index, not marketing copy.

## License

MIT. See [LICENSE](LICENSE).
