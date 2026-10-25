#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from "./config.js";
import { logger } from "./logger.js";

function ensureLibstdcpp(): void {
  if (
    process.platform !== "linux" ||
    process.env._JIT_LD_REEXEC === "1"
  ) {
    return;
  }
  const candidates: string[] = [];
  if (process.env.JIT_LD_LIBRARY_PATH) {
    candidates.push(process.env.JIT_LD_LIBRARY_PATH);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const entries = candidate.split(":").filter(Boolean);
    if (
      !entries.some((entry) => existsSync(path.join(entry, "libstdc++.so.6")))
    ) {
      continue;
    }
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: `${candidate}:${process.env.LD_LIBRARY_PATH || ""}`,
      _JIT_LD_REEXEC: "1",
    };
    const child = spawnSync(process.execPath, process.argv.slice(1), {
      env,
      stdio: "inherit",
    });
    process.exit(child.status ?? 1);
  }
}

ensureLibstdcpp();

const program = new Command();

program
  .name("jit")
  .description("JIT — Just-In-Time Skill Loader for AI Agents")
  .version(VERSION);

program
  .command("serve")
  .description("Start the JIT MCP server (stdio). Used by AI agents.")
  .action(async () => {
    const { serveMcp } = await import("./mcp-server.js");
    await serveMcp();
  });

program
  .command("dashboard")
  .description("Start the web dashboard (management UI).")
  .option("--host <host>", "Host to bind to", DEFAULT_HOST)
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .action(async (options: { host: string; port: string }) => {
    const { startDashboard } = await import("./server/dashboard.js");
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid port: ${options.port}`);
    }
    startDashboard(options.host, port);
  });

if (process.argv.length <= 2) {
  program.help();
}

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
