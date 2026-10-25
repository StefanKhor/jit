import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { DEFAULT_CONFIG } from "../src/config.js";
import { rerankCandidates } from "../src/retrieval/rerank.js";
import type { Config, StoredItem } from "../src/types.js";

function candidate(id = "demo-skill"): StoredItem {
  return {
    id,
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
}

function rerankSettings(port: number): Config {
  return {
    ...DEFAULT_CONFIG,
    rerank_api_key: "test-nebius-key",
    rerank_api_base: `http://127.0.0.1:${port}/v1/`,
    rerank_model: "nvidia/Nemotron-3_5-Lightning",
  };
}

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("a configured reranker always runs and scores candidates", async () => {
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

  try {
    const outcome = await rerankCandidates(
      "demonstrate retrieval",
      [candidate()],
      rerankSettings(portOf(server)),
    );
    assert.equal(outcome.error, null);
    assert.equal(outcome.scores.get("demo-skill"), 1);
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.authorization, "Bearer test-nebius-key");
    assert.equal(received.model, "nvidia/Nemotron-3_5-Lightning");
  } finally {
    await close(server);
  }
});

test("an unconfigured reranker reports why it skipped instead of staying silent", async () => {
  const outcome = await rerankCandidates(
    "demonstrate retrieval",
    [candidate()],
    { ...DEFAULT_CONFIG },
  );
  assert.equal(outcome.scores.size, 0);
  assert.match(outcome.error || "", /not configured/);
});

test("a non-JSON rerank response is reported, not silently dropped", async () => {
  const server = createServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "rerank-test",
      object: "chat.completion",
      created: 0,
      model: "nvidia/Nemotron-3_5-Lightning",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "I cannot comply." },
        finish_reason: "stop",
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const outcome = await rerankCandidates(
      "demonstrate retrieval",
      [candidate()],
      rerankSettings(portOf(server)),
    );
    assert.equal(outcome.scores.size, 0);
    assert.match(outcome.error || "", /unparseable/);
  } finally {
    await close(server);
  }
});

test("a score array with the wrong length is reported", async () => {
  const server = createServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "rerank-test",
      object: "chat.completion",
      created: 0,
      model: "nvidia/Nemotron-3_5-Lightning",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "[3, 2]" },
        finish_reason: "stop",
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const outcome = await rerankCandidates(
      "demonstrate retrieval",
      [candidate()],
      rerankSettings(portOf(server)),
    );
    assert.equal(outcome.scores.size, 0);
    assert.match(outcome.error || "", /2 scores for 1 candidates/);
  } finally {
    await close(server);
  }
});
