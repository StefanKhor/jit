# JIT — a search engine for skills

**JIT works like a search engine for an agent's skills: the agent describes the
task, JIT returns the one tested procedure for it — not ten links to read and
assemble. The index is local, and NVIDIA SkillSpector scans every skill before
it can be found.**

Two things make it worth running.

**Security.** Every skill added to JIT is scanned by
[NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) before it is
indexed — from the marketplace, the dashboard, or `JIT_ADD`. A skill SkillSpector
scores `DO_NOT_INSTALL` is refused; a `CAUTION` needs an explicit
acknowledgement. JIT does not implement security checks of its own: SkillSpector
is the authority, and its patterns, LLM pass, and 0–100 risk score are what you
get.

**Context.** At task time the agent calls
`JIT_FIND("create a Linear issue for the login bug")` and gets the single best
skill, or — when nothing clears the confidence threshold — `{"found": false}`
plus a short `near_misses` list instead of a silent empty result. You carry one
body, not a catalog. A multi-part task spans skills: a confident hit also lists
up to two related skill names, and a second call loads the next body — one body
per call, never a catalog. The MCP response carries only the skill name and its
body — scores, ranking notes, and telemetry stay on the dashboard, where a
human reads them. The whole shipped MCP surface is two
tools, measured at about 400 tokens of standing context.

JIT stays quiet until it is called. MCP is pull-based, so JIT is built to be
*invoked*, not to push: a small tool surface, sharp descriptions, and no
background work in the agent's loop.

Local embeddings are the default. If you explicitly choose a cloud embedding
provider or remote reranker, the corresponding text is sent to that configured
endpoint and may incur provider costs.

Recall is the part of a retriever that is easiest to claim and hardest to prove,
so JIT ships a harness for it: `npm run eval` measures recall@1, recall@3, MRR,
and precision over a labeled query set, and sweeps the threshold. The dashboard
logs every retrieval (from both `JIT_FIND` and Search) so misses are visible
instead of silent.

The dashboard is the primary interface. Every index number in it is computed
from the actual index: real body lengths, real entry counts, real cosine
scores. Nothing about your data is hardcoded. The one fixed figure — the
context cost of JIT's own MCP tool schemas — is measured from the live
`tools/list` payload at runtime, not written down by hand.

## Quick start

Requires **Node.js 24** and npm 11.

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
npm ci
npm run build
npm start
```

Open <http://localhost:3000>. The first-run panel lets you install from the
marketplace or import skills you already
use. Nothing is read from your client configs automatically.

For development:

```bash
npm run dev
# dashboard: http://127.0.0.1:5173
# API:       http://127.0.0.1:3000
```

The production build is a single self-contained `static/dashboard.html` served
by the Node process. There is no CDN, telemetry, or runtime frontend build.

## The scanner

JIT's security answer *is* [SkillSpector](https://github.com/NVIDIA/skillspector),
NVIDIA's scanner for agent skills. JIT runs static analysis by default with
`skillspector scan <target> --format json --no-llm`, so no model provider or API
key is needed. The Settings page has a **SkillSpector analysis** toggle for the
semantic LLM pass; enable it only after configuring a provider in the dashboard
process environment. `JIT_SKILLSPECTOR_LLM` can override the saved preference. JIT
maps the scanner recommendation onto the install gate:

| SkillSpector says | JIT does |
|---|---|
| `SAFE` | installs |
| `CAUTION` | refuses unless the caller acknowledges |
| `DO_NOT_INSTALL` | refuses; only an explicit `force` overrides |

There are no findings without SkillSpector. If the scanner cannot run, JIT does
not guess and does not silently pass: it asks for an explicit acknowledgement and
tells you how to install the scanner.

Install it once; JIT finds it:

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

Resolution order, first one that works wins:

1. `JIT_SKILLSPECTOR` — a command line you provide.
2. `skillspector` on `PATH`.
3. `uvx --python 3.12 --from git+https://github.com/NVIDIA/skillspector.git skillspector`,
   if `uvx` is available. Pinning Python 3.12 avoids native dependency build
   failures on newer Python versions; override it with `JIT_SKILLSPECTOR_PYTHON`.

If a dependency has to compile and the build tools are missing, the install
fails — on Windows `yara-python` is the usual culprit. SkillSpector's own README
covers the requirements; JIT will keep asking for an acknowledgement until the
scanner is reachable, and says so rather than guessing.

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

Restart the client. The agent now sees two tools:

| Tool | What it does |
|---|---|
| `JIT_FIND(intent)` | Load the one skill that fits a concrete multi-step task. Returns the skill body, or `{"found": false}` with `near_misses`. |
| `JIT_ADD(source, acknowledge?, force?)` | Add a skill — a path, a SKILL.md URL, inline markdown, or an installed JIT MCP server. Scanned by SkillSpector first. |

That is the whole surface. `JIT_CALL` and `JIT_STATUS` exist in the code but are
**not advertised** while JIT is skill-first: every tool name, description, and
schema sits in the agent's context for the entire session, and the cheapest
token is the one never sent. Restoring them is one line in
`src/mcp-server.ts` (`SHIPPED_TOOLS`), which is also where the trade-off is
documented.

### Triggering JIT

MCP is pull-based: the server cannot push a skill into the model's context.
JIT stays connected for the session, and the agent decides when to call it.
The tool descriptions tell the agent to call `JIT_FIND` for multi-step tasks
and skip it for trivial ones. A short client instruction removes the
remaining ambiguity. Add this to your system prompt or `AGENTS.md`:

```text
At the start of every new task — not just the first of the session — call
JIT_FIND before working. Phrase the intent like a search query: one sentence,
concrete action, platform or domain named, e.g. "automate posting a twitter
thread". Leave out file paths and task details. Skip it for quick actions you
can do directly, or when a skill for this exact kind of work is already in
context. On {"found": false} with near_misses, retry once with different
phrasing, then proceed normally. The index is broader than any summary of it —
checking is the default, skipping is the exception: a lookup is cheap, a
missed skill is expensive.
```

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
  its two shipped tools (measured, ~400 tokens) plus one retrieved body. The
  alternative keeps the whole catalog — every name and description — in context
  plus the one body a task loads. The Overview page shows the **break-even
  count** where the two cross: the point at which the catalog outgrows JIT's
  fixed tool schema. Below a handful of entries, listing your skills is cheaper
  and simpler, and JIT says so on the page rather than pretending otherwise. JIT
  earns its place when you have many skills, many MCP servers, or both.
- **Attention is still the agent's job.** An MCP server cannot push context; the
  agent has to call `JIT_FIND`. The tool descriptions plus a one-line client
  instruction (above) are the lever. If a client ever offers a retrieval hook,
  that is the better integration — JIT is built to be the retrieval engine behind
  one.
- **Cross-client, local, and offline is the durable part.** A single client can
  absorb "tool search" natively, but it will not index *other* clients' skills,
  run in an air-gapped environment, or keep your catalog on your machine. JIT
  indexes skills and MCP tools together, from paths owned by Claude, Cursor,
  OpenCode, and plain files, with no network dependency once the model is cached.
- **JIT is not a transparent passthrough.** `JIT_CALL` (kept in the code, not
  shipped by default) forwards a tool call and validates arguments against the
  stored schema, because the client's own validation does not apply to a
  forwarded call. It is not a pass-through for resources, prompts, or
  notifications — connect those servers directly if you need them. JIT is a
  retrieval index for skills and tools, and does that one thing.

## The dashboard

A single-file React SPA served by the Node process.

- **Overview** — context per task vs. a skill catalog, reduction or overhead,
  the break-even index size, index composition, heaviest entries, categories,
  and the measured retrieval miss rate.
- **Skills** — list, read, enable/disable, index a path, transfer, and remove.
- **Marketplace** — browse the skills.sh directory by search or ranking, and add
  catalogs and repositories of your own; every install is reviewed before it
  happens.
- **MCP** — connect, disconnect, index tools, import a client config, export
  JIT-managed servers, add a server manually.
- **Search** — live retrieval with the effective score, cosine, rerank, lexical
  and the threshold, plus a confidence slider and the retrieval log.
- **Settings** — local/cloud embeddings, the reranker, confidence threshold, dashboard auth,
  import/export, clear.

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

1. **Embeddings** — local `Xenova/bge-small-en-v1.5` through Transformers.js
   (384 dimensions) by default, or a configured OpenAI-compatible embeddings API.
2. **Vector search** — cosine similarity over embeddings stored in SQLite.
3. **Keyword search** — BM25 over names, descriptions, aliases, and bodies.
4. **Fusion** — Reciprocal Rank Fusion merges both rankings.
5. **Rerank (the decision layer)** — any OpenAI-compatible chat-completions
   endpoint re-scores the top vector candidates. When an endpoint is configured,
   every lookup is reranked — the model decides which skill wins; an
   unconfigured install falls back to cosine and says so in the response.
6. **Two-stage threshold** — the decision uses one scale, never a mix. A reranked
    candidate is judged on its rerank score; otherwise on cosine similarity. The
    default threshold is `0.60`.
7. **Two-tier result** — a candidate above the threshold returns one body or
   tool descriptor. Below it, `JIT_FIND` returns `{"found": false}` with up to
   three `near_misses` (names), so the agent can retry once with a sharper
   intent instead of silently giving up.

The pipeline is deliberately single-pass. A miss costs one search and the agent
continues; it never stalls on retrieval. There is no chunking.

Embeddings are mandatory for retrieval. Keyword scores contribute to fusion,
but JIT never returns a keyword-only match. If the model/provider or stored
vectors are unavailable, Search and `JIT_FIND` return no match and explain why.
Changing provider, model, endpoint, or dimensions invalidates the existing
vectors; rebuild them from Settings before retrieving again.

### Measuring retrieval

```bash
npm run eval                                     # fixtures in eval/; local model may download on first run
npm run eval -- --home ~/.jit --queries mine.jsonl  # your index + your labels
```

`eval/queries.jsonl` is a JSONL file of `{"query": "...", "expected": "id"}`.
The harness reports recall@1, recall@3, MRR, precision at the configured
threshold, and a threshold sweep, so you can pick a threshold from data instead
of taste.

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
| `JIT_CONFIDENCE_THRESHOLD` | Minimum confidence to return a match (0–1) | `0.60` |
| `JIT_TOP_K` | Candidates retrieved before fusion | `20` |
| `JIT_DISABLE_EMBEDDINGS` | Disable embedding requests; retrieval returns an unavailable warning | unset |
| `JIT_EMBEDDING_PROVIDER` | `local` or `openai-compatible` | `local` |
| `JIT_EMBEDDING_MODEL` | Local Transformers.js model | `Xenova/bge-small-en-v1.5` |
| `JIT_EMBEDDING_DIM` | Local model vector size | `384` |
| `JIT_EMBEDDING_API_KEY` | API key for remote embeddings (not needed for localhost) | unset |
| `JIT_EMBEDDING_API_BASE` | OpenAI-compatible embeddings API base URL | unset |
| `JIT_EMBEDDING_API_MODEL` | Cloud/local API model identifier | unset |
| `JIT_EMBEDDING_API_DIM` | API model output dimensions | `1536` |
| `JIT_MARKETPLACE_URL` | Catalog URLs, repositories, or skills.sh links, comma-separated | unset |
| `JIT_GITHUB_TOKEN` | Token for private repositories, passed to the skills CLI | unset |
| `JIT_SKILLS_CLI` | Command that resolves repository sources | `npx --yes skills@1.7.4` |
| `JIT_SKILLS_CLI_VERSION` | Version of the skills CLI to run | `1.7.4` |
| `JIT_SKILLS_SH_URL` | Base URL of the skills.sh directory API | `https://www.skills.sh` |
| `JIT_SKILLSPECTOR` | Command line for the SkillSpector scanner | auto-detected |
| `JIT_SKILLSPECTOR_ARGS` | Extra arguments appended to `scan` | unset |
| `JIT_SKILLSPECTOR_LLM` | Override the Settings toggle (`1` enables semantic LLM analysis) | unset |
| `JIT_SKILLSPECTOR_PYTHON` | Python version used by uvx | `3.12` |
| `JIT_SKILLSPECTOR_TIMEOUT` | Per-scan timeout in milliseconds | `300000` |
| `JIT_SKILLSPECTOR_OFF` | Disable SkillSpector entirely (`1`) | unset |
| `JIT_SECURITY_GATE` | `block` (default), `warn` (never hard-block), or `off` | `block` |
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
one.
configuration of its own and leaves that to the environment you run it in.

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
`JIT_CALL` — kept in the code, not shipped by default — forwards execution to the
owning server, with arguments validated against the stored schema first.

## Marketplace

Installing a skill injects its text into an agent's context, and installing an
MCP server runs a process — both are trust decisions, so they are treated as
such. A skill is scanned by SkillSpector before JIT will index it, and the
marketplace shows the verdict in the install dialog rather than burying it.

JIT ships **no catalog of its own**, but it does read the public
[skills.sh](https://skills.sh) directory, so a fresh install opens on a browser
rather than an empty page: search it, or pick from its own ranking (lifetime
installs or trending), and install from there. The directory's API is public —
JIT asks the same two endpoints the website asks and does not maintain a list of
its own. Nothing is downloaded until you choose an entry.

Beyond that, the marketplace is exactly the sources you point it at. There are
three kinds:

1. **A catalog URL** — JSON with an `items` array, served over HTTPS.
2. **A GitHub repository** — `owner/repo`, `owner/repo@ref`, `owner/repo@ref#dir`,
   or a repo link such as `https://github.com/owner/repo/tree/main/skills`.
3. **A skills.sh link** — `https://skills.sh/<owner>/<repo>` for a whole
   repository, or `https://skills.sh/<owner>/<repo>/<skill>` to pin one skill
   from it.

Both repository shapes are resolved with the open
[`skills`](https://github.com/vercel-labs/skills) CLI rather than parsing
repositories itself: JIT runs `npx skills add <source> --skill <name|*>
--copy -y` in a cache directory and imports the result. Skills are therefore
always whatever that CLI installs, and its own source formats and private-repo
handling (including `JIT_GITHUB_TOKEN` or `GITHUB_TOKEN`) apply. Repository
sources need `git` and a registry reachable by `npx`.

Sources are added on the Marketplace page or in Settings, stored in
`marketplace_urls`, and can also come from the environment as a comma-separated
`JIT_MARKETPLACE_URL`. A later source overrides an earlier entry with the same
id. Remote catalog and skill URLs must use HTTPS; plain HTTP is accepted only for
localhost.

Supply-chain guardrails:

- **Checksums are required.** A skill whose body is fetched from a URL must
  carry a `sha256` in the catalog, because an unpinned body can change between
  review and install. Repository skills carry the content hash the `skills` CLI
  reports, which is compared again at install to flag a change under you.
- **Every skill is scanned by SkillSpector before it is indexed.** This applies
  wherever a skill enters JIT — marketplace install, transfer, dashboard add, or
  `JIT_ADD`. A `DO_NOT_INSTALL` verdict blocks the install and only an explicit
  `force` overrides it; a `CAUTION` verdict requires an acknowledgement. The
  server enforces the gate, so an unacknowledged install is rejected, not just
  discouraged, and the dashboard shows the findings behind the verdict.
- **MCP servers are checked for shell tricks.** SkillSpector scans skills, and a
  local server command is not a skill, so JIT inspects the command and arguments
  for download-and-run patterns (`curl … | sh`) and flags them. Starting a
  process still requires the dashboard's explicit confirmation.
- **Provenance is kept.** Skills installed from a catalog are recorded with their
  origin and reported as `trust: "third-party"` by `JIT_FIND`; tools are always
  third-party. Locally indexed files are first-party.
- **Backend validation.** Catalog URLs are validated against the same allowlist
  the fetcher uses, so a catalog cannot be configured that would only fail later.

What an install does:

- Skills are written to `~/.jit/skills/<id>/` — the whole directory the source
  installs, not just `SKILL.md` — and indexed.
- MCP servers are written to `~/.jit/mcp.json`, connected, and their tools are
  indexed. The dashboard requires an explicit “I understand this starts a local
  process” confirmation.
- Uninstalling a marketplace skill removes JIT's copy and index entry. Removing
  an MCP server leaves external configs and processes alone.

The catalog format is deliberately small:

```json
{
  "items": [
    {
      "id": "commit-message",
      "kind": "skill",
      "name": "Write a commit message",
      "description": "Draft a Conventional Commits message.",
      "category": "Engineering",
      "inputs": [],
      "install": { "sha256": "…", "url": "https://example.com/commit-message.md" }
    }
  ]
}
```

Use `"body": "…"` instead of `url`/`sha256` to inline the skill text.

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
        │                  embeddings + BM25 + OpenAI-compatible reranker
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
  paths are resolved and checked before JIT-owned files are deleted, secrets are
  written with `0600` permissions, catalog bodies are pinned by sha256 and
  scanned for injection, and keys are compared in constant time.
- **Telemetry** — every retrieval is logged to a bounded table (date, source,
  intent, score, hit/miss) so recall can be inspected. Nothing is sent anywhere;
  the log is a local SQLite table, cleared from Search.

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
