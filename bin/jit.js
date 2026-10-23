#!/usr/bin/env node
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);

// Try runners in order of preference.
const runners = [
  { cmd: "uvx", args: ["jit-mcp", ...args] },
  { cmd: "pipx", args: ["run", "jit-mcp", ...args] },
  { cmd: "python3", args: ["-m", "jit", ...args] },
  { cmd: "python", args: ["-m", "jit", ...args] },
];

for (const r of runners) {
  const res = spawnSync(r.cmd, r.args, { stdio: "inherit" });
  if (res.error) continue; // runner not found, try next
  process.exit(res.status ?? 0);
}

console.error(
  "jit-mcp requires Python 3.11+.\n" +
  "Install with one of:\n" +
  "  pip install jit-mcp\n" +
  "  uv tool install jit-mcp\n" +
  "  pipx install jit-mcp\n" +
  "Then run: jit serve"
);
process.exit(1);