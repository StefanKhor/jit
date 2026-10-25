import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the index and force the offline path so strict retrieval can be tested
// without a model download or network access.
process.env.JIT_HOME = mkdtempSync(path.join(tmpdir(), "jit-retrieval-"));
process.env.JIT_DISABLE_EMBEDDINGS = "1";

const db = await import("../src/storage/db.js");
const { evaluate, lexicalConfidence } = await import(
  "../src/retrieval/retriever.js"
);

import type { IndexItem } from "../src/types.js";

const now = "2025-01-01T00:00:00.000Z";

function seed(items: Array<Partial<IndexItem> & { id: string }>): void {
  const conn = db.initDb();
  let index = 0;
  for (const partial of items) {
    index += 1;
    db.upsertItem(conn, {
      item: {
        name: partial.id,
        description: "",
        when_to_use: "",
        categories: [],
        aliases: [],
        body: "",
        path: "",
        kind: "skill",
        ...partial,
      } as IndexItem,
      contentHash: `h${index}`,
      embedding: null,
      updatedAt: now,
    });
  }
}

const CORPUS = [
  {
    id: "postgres-explain",
    description:
      "postgres query explain analyze slow plan buffers sequential scan",
  },
  {
    id: "linear-create",
    description: "create linear issue ticket bug report project",
  },
  { id: "docker-image", description: "docker image multistage build size slim" },
  { id: "k8s-deploy", description: "kubernetes deploy rollout service manifest" },
  { id: "react-render", description: "react component rerender memo performance" },
  { id: "commit-msg", description: "git commit message conventional summary" },
];

test("lexicalConfidence is bounded, monotonic, and zero at zero", () => {
  assert.equal(lexicalConfidence(0), 0);
  assert.equal(lexicalConfidence(-3), 0);
  const low = lexicalConfidence(1);
  const high = lexicalConfidence(8);
  assert.ok(low < high && high < 1);
});

test("an empty intent returns no result", async () => {
  const evaluation = await evaluate("   ");
  assert.equal(evaluation.result, null);
  assert.equal(evaluation.candidates.length, 0);
});

test("embedding failure refuses keyword-only matches", async () => {
  seed(CORPUS);
  const evaluation = await evaluate(
    "postgres query explain analyze slow",
    5,
  );
  assert.equal(evaluation.result, null);
  assert.equal(evaluation.keywordOnly, false);
  assert.equal(evaluation.candidates.length, 0);
  assert.match(evaluation.warning || "", /Embedding retrieval is required/);
});

test("an unrelated intent returns no result", async () => {
  const evaluation = await evaluate("zzzz qqqq wwww vvvv", 5);
  assert.equal(evaluation.result, null);
});

test("keyword-only near misses are not returned when embeddings are unavailable", async () => {
  const evaluation = await evaluate("kubernetes", 5);
  const gibberish = await evaluate("kubernetes zzzz qqqq wwww vvvv yyyy", 5);
  assert.equal(gibberish.result, null);
  assert.equal(evaluation.nearMisses.length, 0);
  assert.match(evaluation.warning || "", /Embedding retrieval is required/);
});

test("a disabled item is never returned", async () => {
  const conn = db.initDb();
  db.setEnabled(conn, "postgres-explain", false);
  const evaluation = await evaluate("postgres query explain analyze slow", 5);
  assert.notEqual(evaluation.result?.id, "postgres-explain");
  db.setEnabled(conn, "postgres-explain", true);
});

test("retrieval telemetry records and summarizes decisions", () => {
  const conn = db.initDb();
  db.clearRetrievals(conn);
  db.logRetrieval(conn, {
    source: "mcp",
    intent: "postgres query slow",
    bestId: "postgres-explain",
    bestName: "postgres-explain",
    score: 0.8,
    cosine: 0,
    rerank: null,
    lexical: 0.8,
    candidates: 3,
    decision: "hit",
    keywordOnly: true,
    elapsedMs: 4,
  });
  db.logRetrieval(conn, {
    source: "dashboard",
    intent: "do the thing",
    bestId: "",
    bestName: "",
    score: 0.1,
    cosine: 0,
    rerank: null,
    lexical: 0.1,
    candidates: 2,
    decision: "miss",
    keywordOnly: true,
    elapsedMs: 2,
  });
  const stats = db.retrievalStats(conn, 10);
  assert.equal(stats.total, 2);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.miss_rate, 50);
  assert.equal(stats.keyword_only, 2);
  assert.equal(stats.misses_recent[0]?.intent, "do the thing");
  assert.equal(stats.top_misses[0]?.count, 1);
  assert.equal(db.clearRetrievals(conn), 2);
});
