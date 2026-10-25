import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the index at a throwaway directory before the config module is loaded
// (it resolves JIT_HOME at import time).
process.env.JIT_HOME = mkdtempSync(path.join(tmpdir(), "jit-test-"));

const db = await import("../src/storage/db.js");
const { EMBEDDING_DIM } = await import("../src/config.js");

import type { IndexItem } from "../src/types.js";

const now = "2025-01-01T00:00:00.000Z";

function item(overrides: Partial<IndexItem> = {}): IndexItem {
  return {
    id: "alpha",
    name: "Alpha",
    description: "first",
    when_to_use: "first",
    categories: [],
    aliases: [],
    body: "alpha body",
    path: "",
    kind: "skill",
    ...overrides,
  };
}

test("initDb returns a stable singleton", () => {
  assert.equal(db.initDb(), db.initDb());
});

test("upsert and get round-trip an item", () => {
  const conn = db.initDb();
  db.upsertItem(conn, {
    item: item(),
    contentHash: "h1",
    embedding: null,
    updatedAt: now,
  });
  const stored = db.getItem(conn, "alpha");
  assert.equal(stored?.name, "Alpha");
  assert.equal(stored?.body, "alpha body");
  assert.equal(stored?.embedding, null);
});

test("dataVersion advances on upsert and delete", () => {
  const conn = db.initDb();
  const before = db.dataVersion(conn);
  db.upsertItem(conn, {
    item: item({ id: "beta", name: "Beta" }),
    contentHash: "h2",
    embedding: null,
    updatedAt: now,
  });
  const afterInsert = db.dataVersion(conn);
  assert.notEqual(afterInsert, before);
  db.deleteItem(conn, "beta");
  assert.notEqual(db.dataVersion(conn), afterInsert);
});

test("swapping enabled flags still invalidates the retrieval cache", () => {
  const conn = db.initDb();
  db.upsertItem(conn, {
    item: item({ id: "s1" }),
    contentHash: "x1",
    embedding: null,
    updatedAt: now,
  });
  db.upsertItem(conn, {
    item: item({ id: "s2" }),
    contentHash: "x2",
    embedding: null,
    updatedAt: now,
  });
  db.setEnabled(conn, "s2", false);
  const before = db.dataVersion(conn);
  // Disable one and enable another: the enabled count is unchanged, but a
  // cache keyed only on that count would go stale.
  db.setEnabled(conn, "s1", false);
  db.setEnabled(conn, "s2", true);
  assert.notEqual(db.dataVersion(conn), before);
});

test("meta values round-trip", () => {
  const conn = db.initDb();
  assert.equal(db.getMeta(conn, "missing"), null);
  db.setMeta(conn, "embedding_signature", "Xenova/bge-small-en-v1.5:384");
  assert.equal(
    db.getMeta(conn, "embedding_signature"),
    "Xenova/bge-small-en-v1.5:384",
  );
});

test("stats and skill rows report whether a valid embedding is indexed", () => {
  const conn = db.initDb();
  db.upsertItem(conn, {
    item: item({ id: "vector-skill", kind: "skill" }),
    contentHash: "vector-skill",
    embedding: new Float32Array(EMBEDDING_DIM),
    updatedAt: now,
  });
  db.upsertItem(conn, {
    item: item({ id: "no-vector-skill", kind: "skill" }),
    contentHash: "no-vector-skill",
    embedding: null,
    updatedAt: now,
  });
  const coverage = db.getStats(conn).embedding_coverage;
  assert.equal(coverage.skills_embedded, 1);
  const listed = db.listItems(conn);
  assert.equal(
    coverage.skills_total,
    listed.filter((entry) => entry.kind === "skill").length,
  );
  assert.equal(listed.find((entry) => entry.id === "vector-skill")?.has_embedding, true);
  assert.equal(listed.find((entry) => entry.id === "no-vector-skill")?.has_embedding, false);
});
