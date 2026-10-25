# Agent guide

Use this file as the quick project map. Read `README.md` or `CONTRIBUTING.md` when a task needs the full product or contributor context; avoid rereading them for routine changes.

## Project at a glance

JIT is a local Node.js/TypeScript app with an MCP server and a React dashboard. It indexes skills and MCP tools in SQLite, retrieves items using embeddings plus BM25, and can optionally rerank candidates through an OpenAI-compatible chat-completions endpoint.

## Start here

- `src/cli.ts` — CLI entry points and command setup.
- `src/mcp-server.ts` — MCP tool definitions and request handling.
- `src/retrieval/retriever.ts` — retrieval, confidence gating, and warnings.
- `src/retrieval/bm25.ts`, `src/embedding.ts`, `src/retrieval/rerank.ts` — retrieval components.
- `src/indexer.ts` — indexing orchestration and public index operations.
- `src/storage/db.ts` — SQLite schema, persistence, lists, and stats.
- `src/config.ts`, `src/types.ts` — server config and shared domain types.
- `src/server/dashboard.ts` — HTTP API and dashboard hosting.
- `web/src/views/` — dashboard pages; `web/src/state/store.tsx` — shared frontend state.
- `tests/` — Node test-runner tests; `eval/` and `scripts/eval.ts` — retrieval evaluation fixtures and harness.

## Important behavior and constraints

- **Embeddings are required for retrieval.** Do not add a setting, environment override, or implicit fallback that permits keyword-only results. BM25 is a complementary ranking signal for vector candidates, not a substitute. If the query embedding or indexed vectors are unavailable, return no result with an actionable warning.
- Use the configured `EMBEDDING_DIM` when validating vector size or reporting coverage; do not duplicate the model dimension as a magic number. Keep the dashboard's per-item vector status and coverage stats consistent with retrieval eligibility.
- **Reranking is optional.** Keep it generic to OpenAI-compatible endpoints; local endpoints may omit an API key, while remote endpoints require one. Do not reintroduce provider-specific compatibility settings unless explicitly requested.
- Skill installation/indexing must continue to respect the SkillSpector scan and acknowledgement gate. Do not silently treat scanner failures as safe.
- Keep indexed user content local by default. Only send candidate content to a remote service when the user has configured and enabled reranking.
- Keep server and web types in sync (`src/types.ts` and `web/src/types.ts`) when changing API payloads.
- The production dashboard is built into `static/dashboard.html`; edit its React/Vite sources under `web/src/`, not the generated bundle.

## Development and checks

Requires Node.js 24+ and npm 11. Install with `npm ci`; run `npm run dev` for the API and Vite dashboard.

- `npm run typecheck` — server, web, and test TypeScript checks.
- `npm test` — unit/integration suite; embedding tests use the real model cache when available and skip when unavailable.
- `npm run build` — server and single-file dashboard production builds.
- `npm run check` — typecheck, tests, and build; preferred final verification.
- `npm run eval` — retrieval quality metrics; run for retrieval/ranking changes and update labeled cases in `eval/queries.jsonl` when behavior warrants it.

Tests should isolate persistent state with a temporary `JIT_HOME`. Tests that must not load/download the embedding model can set `JIT_DISABLE_EMBEDDINGS=1`; assert that retrieval fails closed rather than returning lexical-only results. `JIT_SKIP_EMBEDDING_TESTS=1` skips the real-model test explicitly.

## Working style

- Follow nearby code patterns and keep changes scoped to the request.
- Add or update tests for behavior/API changes; update docs when user-facing behavior or configuration changes.
- Before finishing, run relevant tests and preferably `npm run check`; report anything not run and why.
- Do not commit unless asked. Do not discard or overwrite unrelated work in the working tree.
