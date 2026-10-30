# Contributing

Thanks for helping improve JIT.

## Development setup

Requires Node.js 24 (runtime). npm is the package manager.

```bash
git clone https://github.com/StefanKhor/jit.git
cd jit
npm install
npm run dev
```

`npm run dev` starts the API on `127.0.0.1:3000` and Vite on
`127.0.0.1:5173`. The Vite server proxies `/api` to the API. Use
`JIT_DEV_SERVER=http://127.0.0.1:3001 npm run dev` if you move the API port.

For a production build:

```bash
npm run check
npm run start
```

## Checks

```bash
npm run typecheck
npm run build
node scripts/check-mcp.mjs
node scripts/check-transfer.mjs
```

Transfer checks use temporary folders and a local stub embeddings endpoint; no
model download or cloud credentials are needed.

Verify behavior changes manually against the dashboard and the MCP server:

```bash
npm run dev
# in another terminal
npm run build:server && node dist/cli.js serve
```

Useful smoke checks:

- `GET /api/health` returns `{"status":"healthy", ...}`.
- The dashboard loads with no console errors and shows real index counts.
- Adding, toggling, and removing a skill updates both views.
- Import and export leave the external side untouched.
- A query with no match returns `near_misses`, not a silent empty result.

## Pull requests

1. Fork the repo and create a feature branch.
2. Keep the change focused; avoid new dependencies unless they remove more code
   than they add.
3. Update `README.md` when behavior or configuration changes.
4. Run the checks above and describe how you verified the change.

## Releases

Publishing to npm is automated in CI. Cut a release like this:

1. Bump `version` in `package.json` and commit it on `main`.
2. Tag the release commit and push the tag:

   ```
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. CI runs the full gate (typecheck + build on Linux and Windows, docker image
   smoke test), verifies the tag matches `package.json`, and runs
   `npm publish --provenance`.

One-time setup: add an npm *automation* token as the `NPM_TOKEN` repository
secret. Provenance requires the public registry and GitHub-hosted runners.
A tag that does not match `package.json` fails the release instead of
publishing a surprise version.

## Reporting issues

Use GitHub Issues. Include your Node version, OS, the exact command,
and the expected vs. actual behavior. Redact API keys and index contents.
