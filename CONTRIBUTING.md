# Contributing

Thanks for helping improve JIT.

## Development setup

Requires Node.js 24 and npm 11.

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
npm ci
npm run dev
```

`npm run dev` starts the API on `127.0.0.1:3000` and Vite on
`127.0.0.1:5173`. The Vite server proxies `/api` to the API. Use
`JIT_DEV_SERVER=http://127.0.0.1:3001 npm run dev` if you move the API port.

For a production build:

```bash
npm run check
npm start
```

## Checks

```bash
npm run typecheck
npm test
npm run build
```

There is a small suite in `tests/` covering storage/versioning, BM25, retrieval
gating (including the keyword-only fallback), the marketplace end to end (bundled
catalog, catalog merging, checksum enforcement, scanner acknowledgement, catalog
URL validation), `JIT_CALL` argument validation, and the embedding path
(dimension, normalization, determinism, semantic ordering, and paraphrase
retrieval through the vector route). It uses Node's built-in test runner through
`tsx`, so there is no extra dependency.

`tests/embedding.test.ts` loads the real model from `JIT_MODEL_CACHE`. With a
warm cache it runs in about two seconds; offline with no cache it reports and
skips instead of failing, so the suite is green in an air-gapped runner. Set
`JIT_SKIP_EMBEDDING_TESTS=1` to skip it without even attempting the model load.

Retrieval changes should also move the numbers, not just pass the tests:

```bash
npm run eval   # recall@1 / @3, MRR, precision, threshold sweep
```

`npm run eval` seeds a throwaway index from `eval/fixture.jsonl` and runs
`eval/queries.jsonl`, so it needs no setup and no network. Add a query when you
add a behavior. Run it with `JIT_DISABLE_EMBEDDINGS=1` to see the lexical-only
numbers.

To score your own index, pass both a home and a query file (with `--home`, the
fixtures are not seeded, so your entries are the corpus):

```bash
npm run eval -- --home ~/.jit --queries mine.jsonl
```

Verify behavior changes manually against the dashboard and the MCP server:

```bash
npm run dev
# in another terminal
npm run build:server && node dist/cli.js serve
```

Useful smoke checks:

- `GET /api/health` returns `{"status":"healthy", ...}`.
- The dashboard loads with no console errors and shows real index counts.
- `JIT_STATUS` over MCP reports the same counts as the dashboard.
- Adding, toggling, and removing a skill updates both views.
- A marketplace MCP install connects and indexes its tools.
- Import and export leave the external side untouched.
- A query with no match returns `near_misses`, not a silent empty result.
- `GET /api/marketplace` lists the bundled catalog with no network.

## Bundled catalog

`marketplace.json` at the repo root ships with the package and is loaded as the
default catalog. Skills there use inline bodies (no fetch, no checksum needed)
and must pass the scanner. Keep it small and review every entry: it is
first-party content that ships to every user.

## Pull requests

1. Fork the repo and create a feature branch.
2. Keep the change focused; avoid new dependencies unless they remove more code
   than they add.
3. Update `README.md` when behavior or configuration changes.
4. Run the checks above and describe how you verified the change.

## Reporting issues

Use GitHub Issues. Include your Node version, OS, the exact command, and the
expected vs. actual behavior. Redact API keys and index contents.
