import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { VERSION } from "./config.js";
import { logger } from "./logger.js";
import { warmupEmbeddingModel } from "./embedding.js";
import { evaluate } from "./retrieval/retriever.js";
import { getAllItems, getItem } from "./storage/store.js";

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

One intent per call. Work that spans several domains is several lookups, not one: call JIT_FIND separately for each intent. Packing multiple intents into a single query blurs the match and returns the wrong skill.

Phrase the intent as a search query, not a task brief: one sentence, concrete action plus platform or domain — "deploy a node app to azure", "automate posting a twitter thread". Leave out file paths and task details; they dilute the match. Returns the skill body, or {"found": false} with near_misses; retry once with different phrasing, then proceed — a miss is normal, not an error. A hit may return several skills when more than one fits the same intent; read them all before starting. A hit can also be an MCP tool: its content names the server that owns it and the arguments it takes — call that tool on its server directly; JIT indexes and routes tools, it does not run them.

When you already know exactly which skill you need — a name from near_misses or related, or one you loaded earlier and lost from context — call JIT_RUN with that exact name to load it directly, without searching.`;

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
  registerRun(server);
  return server;
}

export function findDescription(): string {
  return (
    "Load the one skill that fits the work you are about to start. Call " +
    "it before any multi-step task, and again whenever the work shifts " +
    "to a new domain or an unfamiliar tool — not only the first task of " +
    "a session. One intent per call: work spanning several domains is " +
    "several calls. Phrase the intent as " +
    "a search query: one sentence, " +
    'concrete action plus platform or domain, e.g. "deploy a node app ' +
    'to azure". Returns the skill body — sometimes several when more ' +
    'than one fits — or {"found": false} plus near_misses; retry once ' +
    "with different phrasing, then proceed. " +
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
      if (evaluation.results.length > 0) {
        // Minimal agent-facing payload: the skills themselves — one, or several
        // when the reranker judged that more than one fits the same intent —
        // plus related names for multi-part tasks. Each skill carries its path
        // because half the catalog is a directory tree, not a single file: a
        // body that says "read references/x.md" or "run scripts/y.py" can only
        // be followed if the agent knows where the skill lives. Ranking notes
        // stay on the dashboard response, where a human reads them.
        const primary = evaluation.results[0];
        const skills = evaluation.results.map((result) => ({
          name: result.name,
          path: result.path,
          content: result.content,
        }));
        // A body is read from disk at serving time, so an empty content means
        // the file moved or was deleted since indexing. Say so in-band — an
        // unmarked empty procedure would be indistinguishable from a genuine
        // empty skill, and the path the agent could fall back to is exactly
        // the file that is gone.
        const missing = skills.filter((skill) => !skill.content).length;
        return textResult({
          found: true,
          skills,
          ...(primary?.related ? { related: primary.related } : {}),
          ...(missing > 0
            ? {
                note:
                  `${missing} of ${skills.length} skill bodies are unavailable ` +
                  "(file moved or deleted since indexing). Reindex those skills " +
                  "from the dashboard; do not follow the empty procedures.",
              }
            : {}),
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

export function registerRun(server: McpServer): void {
  server.registerTool(
    "JIT_RUN",
    {
      title: "Load a named skill",
      description:
        "Load a skill by its exact name, without searching. Use it when you " +
        "already know which skill you need — a name from JIT_FIND's " +
        "near_misses or related lists, or one you loaded earlier and lost " +
        "from context. Returns the skill body and its path, or " +
        '{"found": false} with close names to retry against.',
      inputSchema: {
        name: z.string().describe('Exact skill name, e.g. "deploy-node-azure".'),
      },
      // Read-only and idempotent like JIT_FIND: it fetches a skill's text from
      // disk. It runs nothing.
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) => {
      const wanted = name.trim().toLowerCase();
      const index = getAllItems(false);
      const hit = index.find((item) => item.name.trim().toLowerCase() === wanted);
      if (!hit) {
        // Substring matches give a misspelled name somewhere to land.
        const close = index
          .filter((item) => {
            const candidate = item.name.trim().toLowerCase();
            return candidate.includes(wanted) || wanted.includes(candidate);
          })
          .slice(0, 5)
          .map((item) => item.name);
        return textResult({
          found: false,
          name,
          ...(close.length > 0 ? { close_matches: close } : {}),
        });
      }
      // getAllItems(false) skips bodies; re-read just this one from disk. The
      // index never stores bodies — same serving-time read as JIT_FIND.
      const full = getItem(hit.id);
      const content = full?.body ?? "";
      return textResult({
        found: true,
        skills: [
          {
            name: hit.name,
            path: hit.path,
            content,
            ...(content
              ? {}
              : {
                  note:
                    "The body is unavailable — the file moved or was deleted " +
                    "since indexing. Reindex from the dashboard; do not follow " +
                    "an empty procedure.",
                }),
          },
        ],
        hint: CALL_HINT,
      });
    },
  );
}

// The dashboard reports the fixed context cost of JIT's own MCP tool schema.
// Measure the real tools/list payload once over an in-memory transport so the
// number tracks the code instead of being hand-maintained. The fallback is the
// last measured value.
// Last measured tools/list cost for the JIT_FIND + JIT_RUN schema pair
// (measured over the in-memory probe below).
const FALLBACK_SCHEMA_TOKENS = 435;

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
