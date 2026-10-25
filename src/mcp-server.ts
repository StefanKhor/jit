import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { VERSION } from "./config.js";
import { logger } from "./logger.js";
import { closeDb } from "./storage/db.js";
import { warmupEmbeddingModel } from "./embedding.js";
import { evaluate, recordRetrieval } from "./retrieval/retriever.js";

const INSTRUCTIONS = `JIT is a just-in-time skill index: it loads the one skill you need, when you need it, instead of keeping every skill in context.

At the start of every new task — not just the first of the session — call JIT_FIND before working. A hit hands you a tested procedure for that exact kind of work; improvising a multi-step workflow is slower and more error-prone. Skip it only for quick actions you can do directly — a single edit, a lookup, a short answer — or when a skill for this exact kind of work is already in context. The index is broader than any summary of it: a domain you do not see named may still have a skill. Checking is the default; skipping is the exception. A lookup costs seconds, while improvising a procedure that already exists is the expensive mistake — if you are unsure whether a skill exists, that uncertainty is a reason to check, not a reason to skip.

Phrase the intent like a search query, not a task brief: one sentence, concrete action, platform or domain named — e.g. "automate posting a twitter thread", "deploy a node app to azure". Leave out file paths, quotes, and task details; they dilute the match. On {"found": false} with near_misses, retry once with different phrasing — sharper if the intent was vague, broader if it was over-specified — then proceed without a skill. A miss is a normal outcome, not an error. A multi-part task spans skills: a hit lists related candidates, so call again to load the next domain.`;

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "JIT", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerFind(server);
  return server;
}

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

// The dashboard reports the fixed context cost of JIT's own MCP tool schema.
// Measure the real tools/list payload once over an in-memory transport so the
// number tracks the code instead of being hand-maintained. The fallback is the
// last measured value.
const FALLBACK_SCHEMA_TOKENS = 246;

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
  const server = createServer();
  const transport = new StdioServerTransport();
  // Warm the embedding model in the background so the first JIT_FIND does not
  // pay the model-load cost mid-conversation. A failed warm-up is already
  // logged by the loader; retrieval still fails closed on the query path.
  void warmupEmbeddingModel().catch(() => {});
  await server.connect(transport);

  const stop = (signal: string): void => {
    logger.info("received %s, shutting down", signal);
    closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
