import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { DEFAULT_CONFIG } from "../src/config.js";
import { rerankCandidates } from "../src/retrieval/rerank.js";
import type { Config, StoredItem } from "../src/types.js";

test("reranker sends a chat-completions request to the configured NVIDIA Nemotron model", async () => {
  let received: { url?: string; authorization?: string; model?: string } = {};
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { model: string };
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      model: payload.model,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "rerank-test",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "[3]" },
        finish_reason: "stop",
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const settings: Config = {
      ...DEFAULT_CONFIG,
      rerank_enabled: true,
      rerank_api_key: "test-nebius-key",
      rerank_api_base: `http://127.0.0.1:${address.port}/v1/`,
      rerank_model: "nvidia/Nemotron-3_5-Lightning",
    };
    const candidate: StoredItem = {
      id: "demo-skill",
      name: "Demo skill",
      description: "A candidate skill",
      when_to_use: "when demonstrating retrieval",
      categories: [],
      aliases: [],
      body: "skill body",
      path: "",
      kind: "skill",
      enabled: true,
      content_hash: "hash",
      updated_at: "2026-01-01T00:00:00.000Z",
      embedding: null,
    };

    const scores = await rerankCandidates("demonstrate retrieval", [candidate], settings);
    assert.equal(scores.get(candidate.id), 1);
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.authorization, "Bearer test-nebius-key");
    assert.equal(received.model, "nvidia/Nemotron-3_5-Lightning");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
