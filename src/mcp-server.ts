import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CONFIDENCE_THRESHOLD,
  EMBEDDING_MODEL,
  MAX_SKILL_BYTES,
  VERSION,
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
import { initDb } from "./storage/db.js";
import { defaultManager } from "./mcp/client.js";
import { retrieve } from "./retrieval/retriever.js";
import type { IndexItem } from "./types.js";

const INSTRUCTIONS =
  "JIT is a just-in-time index of skills and MCP tools. Call JIT_FIND " +
  "before a multi-step task that might have a specialized workflow, with " +
  "a concrete intent. Skip it for trivial tasks. If it returns " +
  '{"found": false}, continue with your built-in tools. If it returns a ' +
  "skill, follow the returned content. If it returns a tool, execute it " +
  "with JIT_CALL.";

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function fetchSkill(url: string): Promise<string> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "http:") {
    if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
      throw new Error("skill URLs must use https://");
    }
  } else if (parsedUrl.protocol !== "https:") {
    throw new Error("skill URLs must use https://");
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" &&
    !(
      finalUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(finalUrl.hostname)
    )
  ) {
    throw new Error("skill redirect must use https://");
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_SKILL_BYTES) {
    throw new Error("remote skill exceeds the size limit");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILL_BYTES) {
        throw new Error("remote skill exceeds the size limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "JIT", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "JIT_FIND",
    {
      title: "Find a skill or MCP tool",
      description:
        "Find one skill or MCP tool for a concrete task. Call this before " +
        "a multi-step task that may have a specialized workflow. Write a " +
        "specific intent: the action, the object, and the outcome (for " +
        'example "create a Linear issue for the login bug"). Skip it for ' +
        "trivial or self-contained tasks. Returns the full skill body or a " +
        "tool descriptor with its tool_id and JSON schema. Returns " +
        '{"found": false} when nothing clears the confidence threshold; in ' +
        "that case proceed with your own tools.",
      inputSchema: {
        intent: z
          .string()
          .describe("A concrete task intent: action, object, and outcome."),
      },
    },
    async ({ intent }) => {
      const result = await retrieve(intent);
      return textResult(result ? { found: true, ...result } : { found: false });
    },
  );

  server.registerTool(
    "JIT_ADD",
    {
      title: "Add skills or MCP tools",
      description:
        "Add skills or MCP tools to the index. Source can be a filesystem " +
        "path, an http(s) URL to a markdown skill, inline markdown, or the " +
        "name of an MCP server already installed in JIT. Format is one of " +
        'auto, dir, url, inline, mcp. Kind is "skill" or "tool".',
      inputSchema: {
        source: z.string().describe("Path, URL, inline markdown, or MCP server name."),
        format: z
          .enum(["auto", "dir", "url", "inline", "mcp"])
          .optional()
          .describe("Input format; auto-detected by default."),
        kind: z
          .enum(["skill", "tool"])
          .optional()
          .describe("Item kind; defaults to skill."),
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
          if (!text.slice(0, 400).includes("---")) {
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
      const manager = defaultManager();
      await manager.loadConfigs();
      const payload = await manager.callTool(serverName, toolName, args || {});
      return textResult(payload, Boolean(payload.is_error));
    },
  );

  server.registerTool(
    "JIT_STATUS",
    {
      title: "Index status",
      description:
        "Report index size, connected MCP servers, and retrieval settings.",
    },
    async () => {
      const db = initDb();
      let counts;
      try {
        counts = countItems(db);
      } finally {
        db.close();
      }
      const manager = defaultManager();
      await manager.loadConfigs();
      return textResult({
        indexed: counts,
        servers: manager.getStatus(),
        settings: {
          confidence_threshold: CONFIDENCE_THRESHOLD,
          embedding_model: EMBEDDING_MODEL,
        },
      });
    },
  );

  return server;
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
    void Promise.race([manager.disconnectAll(), timeout]).finally(() =>
      process.exit(0),
    );
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
