import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "jit-mcp-check-"));
const client = new Client({ name: "jit-mcp-check", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "cli.js"), "serve"],
  cwd: root,
  env: {
    ...process.env,
    JIT_HOME: home,
    // Avoid downloading a model or contacting a remote embedding provider.
    JIT_EMBEDDING_PROVIDER: "openai-compatible",
    JIT_EMBEDDING_API_BASE: "http://127.0.0.1:1/v1",
    JIT_EMBEDDING_API_MODEL: "smoke-test",
    JIT_EMBEDDING_API_DIM: "3",
    JIT_EMBEDDING_API_KEY: "",
  },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["JIT_FIND"]);
  assert.doesNotMatch(client.getInstructions() ?? "", /JIT_RUN/);
  assert.doesNotMatch(tools[0].description, /JIT_RUN/);
  assert.equal(tools[0].annotations.readOnlyHint, true);

  const result = await client.callTool({
    name: "JIT_FIND",
    arguments: { intent: "check a sample procedure" },
  });
  assert.equal(JSON.parse(result.content[0].text).found, false);

  const removed = await client.callTool({
    name: "JIT_RUN",
    arguments: { name: "sample" },
  });
  assert.equal(removed.isError, true);
  assert.match(JSON.stringify(removed.content), /not found/i);
  console.log("MCP smoke check passed: only JIT_FIND is exposed; JIT_RUN is rejected.");
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}
