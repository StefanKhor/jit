import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { VERSION } from "./config.js";
import { logger } from "./logger.js";
import { warmupEmbeddingModel } from "./embedding.js";
import { evaluate } from "./retrieval/retriever.js";

// The server cannot push a reminder mid-session, so the one fresh channel it
// controls is the tool's own result. This short cue rides on every result,
// re-asserting the rule exactly where the model is looking — something the
// one-time system-prompt instruction cannot do once the session grows.
const CALL_HINT =
  "Call JIT_FIND again whenever the work moves to a new domain or platform.";

// The rule that gets the agent to call JIT. It is deliberately a recurring
// condition, not a one-time "start of task" cue: a trigger the agent meets once
// decays as the session grows, while one it re-meets on every domain shift keeps
// firing. Keep it short — a long block is diluted the further back it sits.
const INSTRUCTIONS = `JIT is a just-in-time skill index: it loads the one skill you need, when you need it, instead of keeping every skill in context.

Call JIT_FIND at the start of any multi-step task — and again whenever the work shifts to a new kind of task: a new platform, domain, or unfamiliar tool. Not only the first task of a session; the mid-session switch is the one that is easy to miss. Skip it only for a single-step action you can do directly, or a task whose skill is already in context. One cheap lookup beats improvising a procedure that already exists; if you are unsure a skill exists, that is the reason to check.

Phrase the intent as a search query, not a task brief: one sentence, concrete action plus platform or domain — "deploy a node app to azure", "automate posting a twitter thread". Leave out file paths and task details; they dilute the match. Returns the skill body, or {"found": false} with near_misses; retry once with different phrasing, then proceed — a miss is normal, not an error. A hit may list related skills for multi-part work: call again to load the next one.`;

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
    "Load the one skill that fits the work you are about to start. Call " +
    "it before any multi-step task, and again whenever the work shifts " +
    "to a new domain or an unfamiliar tool — not only the first task of " +
    "a session. Phrase the intent as a search query: one sentence, " +
    'concrete action plus platform or domain, e.g. "deploy a node app ' +
    'to azure". Returns the skill body, or {"found": false} plus ' +
    "near_misses; retry once with different phrasing, then proceed. A " +
    "hit may list related skills — call again for the next domain. " +
    "Cheap to call, expensive to skip."
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
            "One-sentence search query: concrete action plus platform or " +
              'domain, e.g. "deploy a node app to azure".',
          ),
      },
      // Read-only, idempotent, local. Clients that gate on these hints can
      // auto-approve the call, so no approval prompt sits between the agent and
      // a lookup — the friction that teaches an agent to stop calling.
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ intent }) => {
      const evaluation = await evaluate(intent, 3);
      if (evaluation.warning) {
        return textResult({
          found: false,
          error: "embeddings_required_but_unavailable",
          note: evaluation.warning,
        });
      }
      if (evaluation.result) {
        // Minimal agent-facing payload: the skill itself, plus related names
        // for multi-part tasks. Ranking notes stay on the dashboard response,
        // where a human reads them.
        const result = evaluation.result;
        return textResult({
          found: true,
          name: result.name,
          content: result.content,
          ...(result.related ? { related: result.related } : {}),
          hint: CALL_HINT,
        });
      }
      if (evaluation.nearMisses.length > 0) {
        return textResult({
          found: false,
          near_misses: evaluation.nearMisses.map((miss) => miss.name),
          hint: CALL_HINT,
        });
      }
      return textResult({ found: false, hint: CALL_HINT });
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
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
