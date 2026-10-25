import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import {
  getEmbeddingSettings,
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
import { warmupEmbeddingModel } from "./embedding.js";
import { evaluate, recordRetrieval } from "./retrieval/retriever.js";
import type { IndexItem } from "./types.js";

const INSTRUCTIONS = `JIT is a just-in-time skill index: it loads the one skill you need, when you need it, instead of keeping every skill in context.

At the start of every new task — not just the first of the session — call JIT_FIND before working. A hit hands you a tested procedure for that exact kind of work; improvising a multi-step workflow is slower and more error-prone. Skip it only for quick actions you can do directly — a single edit, a lookup, a short answer — or when a skill for this exact kind of work is already in context. The index is broader than any summary of it: a domain you do not see named may still have a skill. Checking is the default; skipping is the exception. A lookup costs seconds, while improvising a procedure that already exists is the expensive mistake — if you are unsure whether a skill exists, that uncertainty is a reason to check, not a reason to skip.

Phrase the intent like a search query, not a task brief: one sentence, concrete action, platform or domain named — e.g. "automate posting a twitter thread", "deploy a node app to azure". Leave out file paths, quotes, and task details; they dilute the match. On {"found": false} with near_misses, retry once with different phrasing — sharper if the intent was vague, broader if it was over-specified — then proceed without a skill. A miss is a normal outcome, not an error. A multi-part task spans skills: a hit lists related candidates, so call again to load the next domain.

JIT_ADD installs a new skill into the index.`;

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

export function findDescription(): string {
  return (
    "Load the one skill that fits the task you are starting, so you " +
    "carry only that body instead of improvising. Call it at the start " +
    "of every new task — not just the first of the session. Phrase the " +
    "intent like a search query: concrete action plus platform or " +
    'domain, e.g. "automate posting a twitter thread". Returns the skill ' +
    'body, or {"found": false} plus near_misses; retry once with a ' +
    "different phrasing, then proceed without a skill. A hit may list " +
    "related skills — for a multi-part task, call again to load the " +
    "next domain. When unsure " +
    "whether a skill exists, check anyway: a miss costs seconds, while " +
    "a missed skill is the expensive mistake."
  );
}

export function registerFind(server: McpServer): void {
  server.registerTool(
    "JIT_FIND",
    {
      title: "Find a skill",
      description: findDescription(),
      inputSchema: {
        intent: z
          .string()
          .describe(
            "One-sentence search query: concrete action plus platform or domain.",
          ),
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
        // Minimal agent-facing payload: the skill itself, plus related names
        // for multi-part tasks. Telemetry and ranking notes stay on the
        // dashboard response, where a human reads them.
        const result = evaluation.result;
        return textResult({
          found: true,
          name: result.name,
          content: result.content,
          ...(result.kind === "tool"
            ? { kind: result.kind, server: result.server, tool_id: result.tool_id }
            : {}),
          ...(result.related ? { related: result.related } : {}),
        });
      }
      if (evaluation.nearMisses.length > 0) {
        return textResult({
          found: false,
          near_misses: evaluation.nearMisses.map((miss) => miss.name),
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
        "to a SKILL.md, inline markdown, or an installed MCP server name.",
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
      },
    },
    async ({ source, format: requestedFormat, kind }) => {
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
          embedding_provider: getEmbeddingSettings().provider,
          embedding_model: getEmbeddingSettings().model,
          embedding_dim: getEmbeddingSettings().dimensions,
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
  // Warm the embedding model in the background so the first JIT_FIND does not
  // pay the model-load cost mid-conversation. A failed warm-up is already
  // logged by the loader; retrieval still fails closed on the query path.
  void warmupEmbeddingModel().catch(() => {});
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
