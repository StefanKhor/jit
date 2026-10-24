import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { assertRemoteUrl, fetchText, isLoopback, sha256 } from "../src/remote.js";
import { respond, stubFetch } from "./helpers.js";

test("only https, plus http on loopback, may be fetched", () => {
  assert.equal(assertRemoteUrl("https://example.com/x.md").protocol, "https:");
  assert.equal(assertRemoteUrl("http://127.0.0.1:8080/x.md").hostname, "127.0.0.1");
  assert.equal(assertRemoteUrl("http://localhost:1/x.md").hostname, "localhost");
  assert.throws(() => assertRemoteUrl("http://example.com/x.md"), /must use https/);
  assert.throws(() => assertRemoteUrl("file:///etc/passwd"), /must use https/);
  assert.throws(() => assertRemoteUrl("not a url"), /Invalid URL|must use https/);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("example.com"), false);
});

test("a body is returned and hashed as sha256", async () => {
  const stub = stubFetch([[/example\.com/, (url) => respond(url, "hello")]]);
  try {
    assert.equal(await fetchText("https://example.com/skill.md"), "hello");
    assert.equal(sha256("hello"), createHash("sha256").update("hello").digest("hex"));
  } finally {
    stub.restore();
  }
});

test("a mismatched checksum refuses the body", async () => {
  const stub = stubFetch([[/example\.com/, (url) => respond(url, "hello")]]);
  try {
    await assert.rejects(
      () =>
        fetchText("https://example.com/skill.md", {
          expectedSha256: "0".repeat(64),
        }),
      /checksum does not match/,
    );
    // The same body with the right digest is accepted.
    assert.equal(
      await fetchText("https://example.com/skill.md", {
        expectedSha256: sha256("hello"),
      }),
      "hello",
    );
  } finally {
    stub.restore();
  }
});

test("an oversized body is refused, by header and by streamed length", async () => {
  const stub = stubFetch([[/example\.com/, (url) => respond(url, "x".repeat(64))]]);
  try {
    await assert.rejects(
      () => fetchText("https://example.com/skill.md", { maxBytes: 16 }),
      /larger than the size limit/,
    );
  } finally {
    stub.restore();
  }
});

test("a redirect that downgrades to plain http is refused", async () => {
  const stub = stubFetch([
    [/example\.com/, () => respond("http://evil.test/skill.md", "hello")],
  ]);
  try {
    await assert.rejects(
      () => fetchText("https://example.com/skill.md"),
      /must use https/,
    );
  } finally {
    stub.restore();
  }
});
