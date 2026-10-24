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
npm run build
```

There is no test suite in the repository by design. Verify changes manually
against the dashboard and the MCP server:

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

## Pull requests

1. Fork the repo and create a feature branch.
2. Keep the change focused; avoid new dependencies unless they remove more code
   than they add.
3. Update `README.md` when behavior or configuration changes.
4. Run the checks above and describe how you verified the change.

## Reporting issues

Use GitHub Issues. Include your Node version, OS, the exact command, and the
expected vs. actual behavior. Redact API keys and index contents.
