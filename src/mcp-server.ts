import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import {
  EMBEDDING_MODEL,
  MAX_SKILL_BYTES,
  VERSION,
  loadConfig,
} from "./config.js";
import {
  countItems,
  deleteToolsForServer,
  discoverSkills,
  expandHome,
  indexItems,
  parseSkillFile,
  parseSkillText,
  totalIndexed,
} from "./indexer.js";
import { logger } from "./logger.js";
import { fetchText } from "./remote.js";
import { closeDb, getItem, initDb } from "./storage/db.js";
import { defaultManager } from "./mcp/client.js";
import { validateToolArguments } from "./mcp/validate.js";
import { evaluate, recordRetrieval } from "./retrieval/retriever.js";
import { enforceGate } from "./skillScan.js";
import { scanSkillPayload } from "./skillspector.js";
import type { IndexItem, ScanReport } from "./types.js";

const INSTRUCTIONS =
  "JIT is a just-in-time index of agent skills. Call JIT_FIND before a " +
  "multi-step task that may have a specialized workflow, with a concrete " +
  "intent; skip it for trivial tasks. It returns one skill body at a time, so " +
  "you carry only what the task needs. JIT_ADD installs a skill and scans it " +
  "with NVIDIA SkillSpector first: a skill that fails the scan is refused.";

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function fetchSkill(url: string): Promise<string> {
  return fetchText(url, { label: "remote skill", timeoutMs: 30_000 });
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "JIT", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const register of SHIPPED_TOOLS) register(server);
  return server;
}

/**
 * The tools JIT advertises to agents, kept deliberately minimal: every tool
 * name, description, and schema sits in the agent's context for the whole
 * session. JIT_CALL and JIT_STATUS stay implemented below — restoring them is
 * one line here — but only what a skill-first workflow needs ships.
 */
const SHIPPED_TOOLS: Array<(server: McpServer) => void> = [
  registerFind,
  registerAdd,
];

export function registerFind(server: McpServer): void {
  server.registerTool(
    "JIT_FIND",
    {
      title: "Find a skill",
      description:
        "Load the one skill that fits a concrete multi-step task, so you " +
        "carry only that body instead of every skill. Give a specific intent: " +
        "action, object, outcome. Skip it for trivial tasks. Returns the skill " +
        'body (or a tool descriptor), or {"found": false} plus near_misses ' +
        "when nothing clears the threshold; retry once with a sharper intent " +
        "if one fits.",
      inputSchema: {
        intent: z
          .string()
          .describe("A concrete task intent: action, object, and outcome."),
      },
    },
    async ({ intent }) => {
      const started = performance.now();
      const evaluation = await evaluate(intent, 3);
      recordRetrieval(evaluation, intent, "mcp", performance.now() - started);
      if (evaluation.warning) {
        return textResult({
          found: false,
          error: "embeddings_required_but_unavailable",
          note: evaluation.warning,
        });
      }
      if (evaluation.result) {
        return textResult({ found: true, ...evaluation.result });
      }
      if (evaluation.nearMisses.length > 0) {
        return textResult({
          found: false,
          near_misses: evaluation.nearMisses.map((miss) => ({
            id: miss.id,
            name: miss.name,
            description: miss.description,
            kind: miss.kind,
          })),
          note:
            "Nothing cleared the confidence threshold. These are the " +
            "closest entries; retry with a more specific intent if one " +
            "applies, otherwise use your own tools.",
        });
      }
      return textResult({ found: false });
    },
  );
}

export function registerAdd(server: McpServer): void {
  server.registerTool(
    "JIT_ADD",
    {
      title: "Add a skill",
      description:
        "Add a skill to the index. Source: a filesystem path, an http(s) URL " +
        "to a SKILL.md, inline markdown, or an installed MCP server name. " +
        "NVIDIA SkillSpector scans it first — DO_NOT_INSTALL is refused, and " +
        "CAUTION is refused unless acknowledged.",
      inputSchema: {
        source: z.string().describe("Path, URL, inline markdown, or MCP server name."),
        format: z
          .enum(["auto", "dir", "url", "inline", "mcp"])
          .optional()
          .describe("Input format; auto by default."),
        kind: z
          .enum(["skill", "tool"])
          .optional()
          .describe("Entry kind; skill by default."),
        acknowledge: z.boolean().optional().describe("Accept a CAUTION verdict."),
        force: z
          .boolean()
          .optional()
          .describe("Install despite DO_NOT_INSTALL."),
      },
    },
    async ({ source, format: requestedFormat, kind, acknowledge, force }) => {
      const gate = { acknowledge: Boolean(acknowledge), force: Boolean(force) };
      // Run SkillSpector before anything reaches the index. A refused skill
      // comes back as an error result carrying the report, so the caller sees
      // exactly why and can retry with acknowledge or force.
      const check = async (report: ScanReport) => {
        try {
          enforceGate(report, gate);
          return null;
        } catch (error) {
          return textResult(
            {
              added: 0,
              updated: 0,
              skipped: 0,
              errors: [error instanceof Error ? error.message : String(error)],
              security: report,
              total_indexed: totalIndexed(),
            },
            true,
          );
        }
      };
      let format = requestedFormat || "auto";
      if (format === "auto") {
        if (/^https?:\/\//.test(source)) format = "url";
        else if (source.includes("\n---\n") || source.trimStart().startsWith("---")) {
          format = "inline";
        } else if (kind === "tool") {
          format = "mcp";
        } else {
          format = "dir";
        }
      }

      let added = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      if (format === "inline") {
        if (Buffer.byteLength(source, "utf8") > MAX_SKILL_BYTES) {
          errors.push("inline skill exceeds the size limit");
        } else {
          const refused = await check(await scanSkillPayload({ body: source }));
          if (refused) return refused;
          try {
            const item = parseSkillText(source, "", "inline-skill");
            const result = await indexItems([item], "skill");
            added = result.added;
            updated = result.updated;
            skipped = result.skipped;
            errors.push(...result.errors);
          } catch (error) {
            errors.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } else if (format === "dir") {
        const target = path.resolve(expandHome(source));
        if (!existsSync(target)) {
          return textResult({
            added: 0,
            updated: 0,
            skipped: 0,
            errors: [`Path not found: ${source}`],
            total_indexed: totalIndexed(),
          });
        }
        const refused = await check(await scanSkillPayload({ path: target }));
        if (refused) return refused;
        const files = statSync(target).isFile()
          ? [target]
          : discoverSkills([target]);
        const items: IndexItem[] = [];
        for (const file of files) {
          try {
            items.push(parseSkillFile(file));
          } catch (error) {
            errors.push(
              `${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const result = await indexItems(items, "skill");
        added = result.added;
        updated = result.updated;
        skipped = result.skipped;
        errors.push(...result.errors);
      } else if (format === "url") {
        try {
          const text = await fetchSkill(source);
          if (!/^\s*---\s*\r?\n/.test(text)) {
            errors.push("URL did not return a skill file with frontmatter");
          } else {
            const refused = await check(await scanSkillPayload({ body: text }));
            if (refused) return refused;
            const item = parseSkillText(text, "", "remote-skill");
            const result = await indexItems([item], "skill");
            added = result.added;
            updated = result.updated;
            skipped = result.skipped;
            errors.push(...result.errors);
          }
        } catch (error) {
          errors.push(
            `failed to fetch URL: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else if (format === "mcp") {
        const serverName = source.trim();
        const manager = defaultManager();
        await manager.loadConfigs();
        if (!(await manager.connect(serverName))) {
          return textResult({
            added: 0,
            updated: 0,
            skipped: 0,
            errors: [
              `could not connect to ${serverName}: ${
                manager.getStatus()[serverName]?.error || "unknown error"
              }`,
            ],
            total_indexed: totalIndexed(),
          });
        }
        const manifests = manager.indexTools(serverName);
        deleteToolsForServer(serverName);
        const result = await indexItems(manifests, "tool");
        added = result.added;
        updated = result.updated;
        skipped = result.skipped;
        errors.push(...result.errors);
      } else {
        errors.push(`unsupported format: ${format}`);
      }

      return textResult({
        added,
        updated,
        skipped,
        errors,
        total_indexed: totalIndexed(),
      });
    },
  );
}

// Implemented but not shipped while JIT is skill-first (see SHIPPED_TOOLS).
export function registerCall(server: McpServer): void {
  server.registerTool(
    "JIT_CALL",
    {
      title: "Call an MCP tool",
      description:
        "Execute an MCP tool discovered through JIT_FIND. tool_id is the " +
        '"server__tool_name" value returned by JIT_FIND. arguments must ' +
        "match the tool's JSON schema.",
      inputSchema: {
        tool_id: z
          .string()
          .describe('The tool_id returned by JIT_FIND ("server__tool_name").'),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments matching the tool's JSON schema."),
      },
    },
    async ({ tool_id, arguments: args }) => {
      const separator = tool_id.indexOf("__");
      const serverName =
        separator > 0 ? tool_id.slice(0, separator) : "";
      const toolName =
        separator > 0 ? tool_id.slice(separator + 2) : "";
      if (!serverName || !toolName) {
        return textResult(
          {
            error: `invalid tool_id '${tool_id}', expected 'server__tool_name'`,
            is_error: true,
          },
          true,
        );
      }
      const stored = getItem(initDb(), tool_id);
      const argErrors = validateToolArguments(stored?.schema, args || {});
      if (argErrors.length > 0) {
        return textResult(
          {
            error: "arguments do not match the tool schema",
            details: argErrors,
            is_error: true,
          },
          true,
        );
      }
      const manager = defaultManager();
      await manager.loadConfigs();
      const payload = await manager.callTool(serverName, toolName, args || {});
      return textResult(payload, Boolean(payload.is_error));
    },
  );
}

// Implemented but not shipped while JIT is skill-first (see SHIPPED_TOOLS).
export function registerStatus(server: McpServer): void {
  server.registerTool(
    "JIT_STATUS",
    {
      title: "Index status",
      description:
        "Report index size, connected MCP servers, and retrieval settings.",
    },
    async () => {
      const counts = countItems(initDb());
      const manager = defaultManager();
      await manager.loadConfigs();
      return textResult({
        indexed: counts,
        servers: manager.getStatus(),
        settings: {
          confidence_threshold: loadConfig().confidence_threshold,
          embedding_model: EMBEDDING_MODEL,
        },
      });
    },
  );
}

// The dashboard reports the fixed context cost of JIT's own MCP tool schemas.
// Measure the real tools/list payload once over an in-memory transport so the
// number tracks the code instead of being hand-maintained. The fallback is the
// last measured value.
const FALLBACK_SCHEMA_TOKENS = 396;

let schemaTokensPromise: Promise<number> | null = null;

export function jitSchemaTokens(): Promise<number> {
  if (!schemaTokensPromise) {
    schemaTokensPromise = measureSchemaTokens().catch((error: unknown) => {
      logger.warn(
        "could not measure MCP schema tokens: %s",
        error instanceof Error ? error.message : String(error),
      );
      schemaTokensPromise = null;
      return FALLBACK_SCHEMA_TOKENS;
    });
  }
  return schemaTokensPromise;
}

async function measureSchemaTokens(): Promise<number> {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "jit-schema-probe", version: VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return Math.max(1, Math.ceil(JSON.stringify(tools).length / 4));
  } finally {
    try {
      await client.close();
    } catch {
      // Best effort.
    }
    try {
      await server.close();
    } catch {
      // Best effort.
    }
  }
}

export async function serveMcp(): Promise<void> {
  const manager = defaultManager();
  try {
    await manager.loadConfigs();
  } catch (error) {
    logger.warn(
      "could not load MCP configs: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const stop = (signal: string): void => {
    logger.info("received %s, shutting down", signal);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000).unref();
    });
    void Promise.race([manager.disconnectAll(), timeout]).finally(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
