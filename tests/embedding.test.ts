import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// A fresh index, but the *shared* model cache: the point of these tests is the
// real embedding path, so we want a warm cache if one exists. Set
// JIT_SKIP_EMBEDDING_TESTS=1 on an air-gapped runner to skip the whole file.
process.env.JIT_HOME = mkdtempSync(path.join(tmpdir(), "jit-embedding-"));
delete process.env.JIT_DISABLE_EMBEDDINGS;
process.env.JIT_MODEL_CACHE ||= path.join(homedir(), ".jit", "models");

const { cosineSimilarity, embedQuery, embedTexts } = await import(
  "../src/embedding.js"
);
const db = await import("../src/storage/db.js");
const retriever = await import("../src/retrieval/retriever.js");
const { EMBEDDING_DIM } = await import("../src/config.js");

import type { IndexItem } from "../src/types.js";

const SKIP = /^(1|true|yes|on)$/i.test(
  process.env.JIT_SKIP_EMBEDDING_TESTS || "",
);
let available = false;

before(async () => {
  if (SKIP) return;
  try {
    await embedQuery("warmup");
    available = true;
  } catch (error) {
    // No model in the cache and no way to fetch it: report and skip rather than
    // fail, since the lexical fallback is a supported mode.
    console.error(
      `embedding tests skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
});

function requireModel(t: { skip: (reason?: string) => void }): boolean {
  if (!available) {
    t.skip("embedding model unavailable (offline and no warm cache)");
    return false;
  }
  return true;
}

test("embeddings are unit-length vectors of the configured dimension", async (t) => {
  if (!requireModel(t)) return;
  const vector = await embedQuery("write a git commit message");
  assert.equal(vector.length, EMBEDDING_DIM);
  let norm = 0;
  for (const value of vector) norm += value * value;
  assert.ok(
    Math.abs(Math.sqrt(norm) - 1) < 1e-3,
    `expected a normalized vector, got norm ${Math.sqrt(norm)}`,
  );
});

test("embeddings are deterministic for the same input", async (t) => {
  if (!requireModel(t)) return;
  const [a] = await embedTexts(["summarize an incident"]);
  const [b] = await embedTexts(["summarize an incident"]);
  assert.ok(
    cosineSimilarity(a as Float32Array, b as Float32Array) > 0.999,
    "the same text should embed to the same vector",
  );
});

test("related text is closer than unrelated text", async (t) => {
  if (!requireModel(t)) return;
  const query = await embedQuery("how do I write a good commit message");
  const related = await embedQuery(
    "Conventional Commits: type(scope): summary of the change",
  );
  const unrelated = await embedQuery(
    "kubernetes horizontal pod autoscaler replica count manifest",
  );
  const near = cosineSimilarity(query, related);
  const far = cosineSimilarity(query, unrelated);
  assert.ok(
    near > far,
    `expected ${near.toFixed(3)} > ${far.toFixed(3)}`,
  );
});

test("retrieval uses the vector path and reports cosine confidence", async (t) => {
  if (!requireModel(t)) return;
  const conn = db.initDb();
  const entries: Array<{ id: string; text: string; body: string }> = [
    {
      id: "commit-msg",
      text: "write a clear git commit message conventional commits summary",
      body: "type(scope): summary",
    },
    {
      id: "k8s-scaling",
      text: "scale a kubernetes deployment with a horizontal pod autoscaler",
      body: "kubectl autoscale deployment",
    },
    {
      id: "pg-slow",
      text: "diagnose why a postgres query is slow with explain analyze",
      body: "EXPLAIN (ANALYZE, BUFFERS)",
    },
  ];
  const vectors = await embedTexts(entries.map((entry) => entry.text));
  let index = 0;
  for (const entry of entries) {
    index += 1;
    db.upsertItem(conn, {
      item: {
        id: entry.id,
        name: entry.id,
        description: entry.text,
        when_to_use: entry.text,
        categories: [],
        aliases: [],
        body: entry.body,
        path: "",
        kind: "skill",
      } as IndexItem,
      contentHash: `emb-${index}`,
      embedding: vectors[index - 1] as Float32Array,
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
  }
  retriever.invalidateRetrievalCache();

  // A paraphrase with little lexical overlap: this only works via embeddings.
  const evaluation = await retriever.evaluate(
    "politely describing a code change for teammates",
    5,
  );
  assert.equal(evaluation.keywordOnly, false, "expected the vector path");
  assert.ok(evaluation.result, "expected a hit");
  assert.equal(evaluation.result?.id, "commit-msg");
  assert.ok(
    (evaluation.result?.confidence || 0) > 0.6,
    `expected confidence above the threshold, got ${evaluation.result?.confidence}`,
  );
  const top = evaluation.candidates[0];
  assert.ok(top && top.cosine > 0.6, `expected cosine > 0.6, got ${top?.cosine}`);
  assert.notEqual(top?.passes_threshold, false);

  const miss = await retriever.evaluate("flavour pairing for a cheese board", 5);
  assert.equal(miss.result, null);
});
