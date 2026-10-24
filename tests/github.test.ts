import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  discoverGithubRepo,
  isGithubRef,
  parseGithubRef,
  toRawGithubUrl,
} from "../src/github.js";
import { respond, stubFetch } from "./helpers.js";

const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const RAW = `https://raw.githubusercontent.com/acme/demo/${SHA}`;

const SKILL = [
  "---",
  "name: hello",
  "description: says hello",
  "---",
  "Say hello.",
].join("\n");
const MCP = JSON.stringify({
  mcpServers: { "demo-tools": { command: "npx", args: ["-y", "demo-mcp"] } },
});

test("parseGithubRef understands the supported spellings", () => {
  assert.deepEqual(parseGithubRef("anthropics/skills"), {
    owner: "anthropics",
    repo: "skills",
    ref: "",
    subpath: "",
  });
  assert.deepEqual(parseGithubRef("owner/repo@v1.2.3#skills/web"), {
    owner: "owner",
    repo: "repo",
    ref: "v1.2.3",
    subpath: "skills/web",
  });
  assert.deepEqual(parseGithubRef("https://github.com/owner/repo"), {
    owner: "owner",
    repo: "repo",
    ref: "",
    subpath: "",
  });
  assert.deepEqual(
    parseGithubRef("https://github.com/owner/repo/tree/main/skills/web"),
    { owner: "owner", repo: "repo", ref: "main", subpath: "skills/web" },
  );
  // A `.git` suffix and a trailing slash are common in copied links.
  assert.deepEqual(parseGithubRef("https://github.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    ref: "",
    subpath: "",
  });
});

test("parseGithubRef rejects anything that is not a repository", () => {
  // A catalog URL is handled by the plain-URL path, not the GitHub one.
  assert.equal(
    parseGithubRef("https://raw.githubusercontent.com/o/r/main/marketplace.json"),
    null,
  );
  assert.equal(parseGithubRef("https://example.com/catalog.json"), null);
  assert.equal(parseGithubRef("marketplace.json"), null);
  assert.equal(parseGithubRef(""), null);
  assert.equal(isGithubRef("acme/demo"), true);
  assert.equal(isGithubRef("acme"), false);
});

test("toRawGithubUrl rewrites blob links and leaves other URLs alone", () => {
  assert.equal(
    toRawGithubUrl("https://github.com/acme/demo/blob/main/marketplace.json"),
    "https://raw.githubusercontent.com/acme/demo/main/marketplace.json",
  );
  assert.equal(
    toRawGithubUrl("https://example.com/catalog.json"),
    "https://example.com/catalog.json",
  );
  assert.equal(toRawGithubUrl("acme/demo"), "acme/demo");
});

test("a repository without a catalog is crawled for skills and MCP configs", async () => {
  const stub = stubFetch([
    [/\/repos\/acme\/demo\/commits\/HEAD$/, (url) => respond(url, JSON.stringify({ sha: SHA }))],
    [
      /\/git\/trees\//,
      (url) =>
        respond(
          url,
          JSON.stringify({
            tree: [
              { type: "blob", path: "README.md" },
              { type: "blob", path: "skills/hello/SKILL.md" },
              { type: "blob", path: ".mcp.json" },
            ],
          }),
        ),
    ],
    [/\/skills\/hello\/SKILL\.md$/, (url) => respond(url, SKILL)],
    [/\/\.mcp\.json$/, (url) => respond(url, MCP)],
  ]);
  try {
    const found = await discoverGithubRepo("acme/demo");
    assert.equal(found.origin, `github:acme/demo@${SHA.slice(0, 7)}`);
    assert.equal(found.warning, "");
    assert.equal(found.items.length, 2);

    const skill = found.items.find(
      (item) => (item as { kind: string }).kind === "skill",
    ) as Record<string, unknown>;
    assert.equal(skill.id, "hello");
    assert.equal(skill.description, "says hello");
    assert.deepEqual(skill.install, {
      url: `${RAW}/skills/hello/SKILL.md`,
      sha256: createHash("sha256").update(SKILL).digest("hex"),
    });

    const mcp = found.items.find(
      (item) => (item as { kind: string }).kind === "mcp",
    ) as Record<string, unknown>;
    assert.equal(mcp.id, "demo-tools");
    assert.deepEqual(mcp.install, { command: "npx", args: ["-y", "demo-mcp"] });
  } finally {
    stub.restore();
  }
});

test("a pinned commit is reused for every body, so nothing can change under review", async () => {
  const stub = stubFetch([
    [/\/commits\/main$/, (url) => respond(url, JSON.stringify({ sha: SHA }))],
    [
      /\/git\/trees\//,
      (url) =>
        respond(url, JSON.stringify({ tree: [{ type: "blob", path: "skills/hello/SKILL.md" }] })),
    ],
    [/\/skills\/hello\/SKILL\.md$/, (url) => respond(url, SKILL)],
  ]);
  try {
    await discoverGithubRepo("acme/demo@main");
    // Every raw body must be requested at the resolved commit, never at the branch.
    const bodies = stub.seen.filter((url) => url.includes("raw.githubusercontent.com"));
    assert.ok(bodies.length > 0);
    for (const url of bodies) assert.ok(url.includes(`/${SHA}/`), url);
    assert.ok(!bodies.some((url) => url.includes("/main/")));
  } finally {
    stub.restore();
  }
});

test("a repository catalog is resolved against the pinned commit", async () => {
  const catalog = JSON.stringify({
    items: [
      {
        id: "one",
        kind: "skill",
        name: "One",
        description: "a relative body",
        install: { url: "skills/one/SKILL.md" },
      },
      {
        id: "two",
        kind: "skill",
        name: "Two",
        description: "a body that is not in the repository",
        install: { url: "skills/two/SKILL.md" },
      },
      {
        id: "three",
        kind: "mcp",
        name: "Three",
        install: { command: "npx", args: ["-y", "three"] },
      },
    ],
  });
  const body = ["---", "name: one", "---", "One."].join("\n");
  const stub = stubFetch([
    [/\/commits\/HEAD$/, (url) => respond(url, JSON.stringify({ sha: SHA }))],
    [
      /\/git\/trees\//,
      (url) =>
        respond(
          url,
          JSON.stringify({
            tree: [
              { type: "blob", path: "marketplace.json" },
              { type: "blob", path: "skills/one/SKILL.md" },
            ],
          }),
        ),
    ],
    [/\/marketplace\.json$/, (url) => respond(url, catalog)],
    [/\/skills\/one\/SKILL\.md$/, (url) => respond(url, body)],
  ]);
  try {
    const found = await discoverGithubRepo("acme/demo");
    assert.deepEqual(
      found.items.map((item) => (item as { id: string }).id),
      ["one", "three"],
    );
    const one = found.items[0] as Record<string, unknown>;
    assert.deepEqual(one.install, {
      url: `${RAW}/skills/one/SKILL.md`,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    assert.match(found.warning, /two.*is not in the repository/);
  } finally {
    stub.restore();
  }
});

test("an absolute catalog URL is never re-fetched and its checksum is kept", async () => {
  const catalog = JSON.stringify({
    items: [
      {
        id: "abs",
        kind: "skill",
        name: "Abs",
        install: { url: "https://example.com/abs.md", sha256: "a".repeat(64) },
      },
    ],
  });
  const stub = stubFetch([
    [/\/commits\/HEAD$/, (url) => respond(url, JSON.stringify({ sha: SHA }))],
    [
      /\/git\/trees\//,
      (url) => respond(url, JSON.stringify({ tree: [{ type: "blob", path: "marketplace.json" }] })),
    ],
    [/\/marketplace\.json$/, (url) => respond(url, catalog)],
  ]);
  try {
    const found = await discoverGithubRepo("acme/demo");
    assert.equal(found.items.length, 1);
    assert.deepEqual((found.items[0] as Record<string, unknown>).install, {
      url: "https://example.com/abs.md",
      sha256: "a".repeat(64),
    });
    assert.equal(
      stub.seen.filter((url) => url.includes("example.com")).length,
      0,
    );
  } finally {
    stub.restore();
  }
});

test("an unreadable repository fails with the repository in the message", async () => {
  const stub = stubFetch([]);
  try {
    await assert.rejects(
      () => discoverGithubRepo("acme/missing"),
      /could not read acme\/missing: HTTP 404/,
    );
  } finally {
    stub.restore();
  }
});

test("a tree too large to read fully is reported instead of silently truncated", async () => {
  const stub = stubFetch([
    [/\/commits\/HEAD$/, (url) => respond(url, JSON.stringify({ sha: SHA }))],
    [
      /\/git\/trees\//,
      (url) => respond(url, JSON.stringify({ tree: [], truncated: true })),
    ],
  ]);
  try {
    const found = await discoverGithubRepo("acme/demo");
    assert.match(found.warning, /too large to read fully/);
    assert.equal(found.items.length, 0);
  } finally {
    stub.restore();
  }
});
