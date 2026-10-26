# Agent guide

Use this file as the quick project map. Read `README.md` or `CONTRIBUTING.md` when a task needs the full product or contributor context; avoid rereading them for routine changes.

## Project at a glance

JIT is a local Node.js/TypeScript app with an MCP server and a React dashboard. It indexes skills in plain files under `~/.jit`, retrieves items using embeddings, and can optionally rerank candidates through an OpenAI-compatible chat-completions endpoint.

## Start here

- `src/cli.ts` — CLI entry points and command setup.
- `src/mcp-server.ts` — the shipped MCP tool (`JIT_FIND`) and its registration.
- `src/retrieval/retriever.ts` — retrieval, confidence gating, and warnings.
- `src/embedding.ts`, `src/retrieval/rerank.ts` — retrieval components.
- `src/indexer.ts` — indexing orchestration and public index operations.
- `src/storage/store.ts` — file-backed index (schema, persistence, lists, and stats).
- `src/config.ts`, `src/types.ts` — server config and shared domain types.
- `src/server/dashboard.ts` — HTTP API and dashboard hosting.
- `web/src/views/` — dashboard pages; `web/src/state/store.tsx` — shared frontend state.

## Important behavior and constraints

- **Embeddings are required for retrieval.** Do not add a setting, environment override, or implicit fallback that permits keyword-only results. If the query embedding or indexed vectors are unavailable, return no result with an actionable warning.
- Use the active dimension from `getEmbeddingSettings()` when validating vector size or reporting coverage; do not duplicate model dimensions as magic numbers. Keep the dashboard's per-item vector status and coverage stats consistent with retrieval eligibility.
- **Embeddings are required, but provider choice is configurable.** Keep the built-in local model as the default and support OpenAI-compatible embeddings endpoints. Cloud embeddings require deliberate configuration; local endpoints may omit an API key, while remote endpoints require one. Provider/model/dimension changes invalidate existing vectors and require reindexing.
- **Reranking is the decision layer, compulsory when configured.** There is no on/off toggle by design: a configured endpoint always reranks every lookup; an unconfigured install falls back to cosine with an explicit warning, never silently. Keep it generic to OpenAI-compatible endpoints; local endpoints may omit an API key, while remote endpoints require one. Do not reintroduce a rerank toggle or provider-specific compatibility settings unless explicitly requested.
- Skill installation/indexing is unscanned: it indexes what the user points at, nothing more.
- Keep indexed user content local by default. Send it to a remote service only when the user explicitly configures cloud embeddings or enables remote reranking; make this data flow clear in the UI.
- Keep server and web types in sync (`src/types.ts` and `web/src/types.ts`) when changing API payloads.
- The production dashboard is built into `static/dashboard.html`; edit its React/Vite sources under `web/src/`, not the generated bundle.

## Development and checks

Requires Node.js 24+ (runtime) and Bun (package manager). Install with `bun install`; run `bun run dev` for the API and Vite dashboard.

- `bun run typecheck` — server and web TypeScript checks.
- `bun run build` — server and single-file dashboard production builds.
- `bun run check` — typecheck and build; preferred final verification.

## Working style

- Follow nearby code patterns and keep changes scoped to the request.
- Update docs when user-facing behavior or configuration changes.
- Before finishing, run `bun run check`; report anything not run and why.
- Do not commit unless asked. Do not discard or overwrite unrelated work in the working tree.
