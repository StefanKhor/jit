import { test } from "node:test";
import assert from "node:assert/strict";

const { tokenize, BM25Index } = await import("../src/retrieval/bm25.js");

test("tokenize lowercases and drops stopwords", () => {
  assert.deepEqual(tokenize("Create a Linear issue for the login bug"), [
    "create",
    "linear",
    "issue",
    "login",
    "bug",
  ]);
});

test("BM25 ranks the on-topic document first", () => {
  const index = new BM25Index([
    "create a linear issue tracking bug report",
    "send an email to the team about deployment",
    "query the postgres database for slow queries",
  ]);
  const hits = index.search("file a linear bug", 3);
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.index, 0);
});

test("BM25 returns nothing for a query with only stopwords", () => {
  const index = new BM25Index(["create a linear issue"]);
  assert.deepEqual(index.search("the a of", 3), []);
});
