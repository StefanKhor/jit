import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A real stdio handshake against `jit serve`, the way an agent sees it. The
// index lives in a throwaway home and embeddings are off, so nothing here
// touches the developer's machine or the network.
const root = path.resolve(import.meta.dirname, "..");
const home = mkdtempSync(path.join(tmpdir(), "jit-stdio-"));

// A zero threshold makes the positive retrieval path deterministic; the index
// starts empty so the first find must miss.
writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ confidence_threshold: 0, first_run: false }),
);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.JIT_HOME = home;
env.JIT_DISABLE_EMBEDDINGS = "1";
delete env.JIT_API_KEY;

const INLINE = [
  "---",
  "name: stdio-skill",
  "description: a skill added over the stdio transport",
  "---",
  "Do the stdio thing.",
].join("\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", path.join(root, "src", "cli.ts"), "serve"],
  cwd: root,
  env,
  stderr: "inherit",
});

const client = new Client(
  { name: "jit-stdio-test", version: "1.0.0" },
  { capabilities: {} },
);

before(async () => {
  await client.connect(transport);
});

after(async () => {
  try {
    await client.close();
  } catch {
    // Best effort: the child is killed by the transport.
  }
  rmSync(home, { recursive: true, force: true });
});

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as ToolResult).content || [];
  const text = content.find((part) => part.type === "text")?.text || "";
  return JSON.parse(text) as Record<string, unknown>;
}

test("the stdio server advertises the four JIT tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const expected of ["JIT_FIND", "JIT_ADD", "JIT_CALL", "JIT_STATUS"]) {
    assert.ok(names.includes(expected), expected);
  }
  const find = tools.find((tool) => tool.name === "JIT_FIND");
  assert.match(String(find?.description), /near_misses/);
});

test("JIT_STATUS reports the index, servers, and the live threshold", async () => {
  const status = payload(
    await client.callTool({ name: "JIT_STATUS", arguments: {} }),
  );
  assert.equal(typeof status.indexed, "object");
  assert.equal(typeof status.servers, "object");
  const settings = status.settings as Record<string, unknown>;
  assert.equal(settings.confidence_threshold, 0);
  assert.equal(typeof settings.embedding_model, "string");
});

test("a skill added over stdio is found and returned in full", async () => {
  const added = payload(
    await client.callTool({
      name: "JIT_ADD",
      arguments: { source: INLINE, format: "inline" },
    }),
  );
  assert.ok(Number(added.added) >= 1, JSON.stringify(added));

  const found = payload(
    await client.callTool({
      name: "JIT_FIND",
      arguments: { intent: "do the stdio thing" },
    }),
  );
  assert.equal(found.found, true);
  assert.equal(found.id, "stdio-skill");
  assert.equal(found.kind, "skill");
  assert.match(String(found.content), /Do the stdio thing\./);
  assert.equal(typeof found.confidence, "number");
  assert.equal(found.keyword_only, true);
});

test("JIT_FIND refuses to invent a match for unrelated work", async () => {
  const found = payload(
    await client.callTool({
      name: "JIT_FIND",
      arguments: { intent: "zzzqqq unrelated nonexistent capability" },
    }),
  );
  assert.equal(found.found, false);
  // near_misses is present only when something was close; it is never a match.
  if (found.near_misses !== undefined) {
    assert.ok(Array.isArray(found.near_misses));
    assert.ok((found.near_misses as unknown[]).length > 0);
  }
});

test("JIT_CALL rejects a malformed tool id", async () => {
  const result = (await client.callTool({
    name: "JIT_CALL",
    arguments: { tool_id: "nope" },
  })) as ToolResult;
  assert.equal(result.isError, true);
  assert.match(String(payload(result).error), /invalid tool_id/);
});

test("JIT_CALL reports a missing server instead of pretending to run it", async () => {
  const result = (await client.callTool({
    name: "JIT_CALL",
    arguments: { tool_id: "ghost__missing" },
  })) as ToolResult;
  assert.equal(result.isError, true);
  assert.match(String(payload(result).error), /connection failed/);
});
