import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the index and force the offline path: discovery annotates entries with
// what is already installed.
process.env.JIT_HOME = mkdtempSync(path.join(tmpdir(), "jit-skillssh-"));
process.env.JIT_DISABLE_EMBEDDINGS = "1";

// A stand-in for the skills.sh API. The module reads its base URL once, at
// import time, so the server has to be listening before that import runs.
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const HITS = [
  {
    id: "acme/demo/slow-skill",
    source: "acme/demo",
    skillId: "slow-skill",
    name: "slow-skill",
    installs: 10,
  },
  {
    id: "acme/demo/fast-skill",
    source: "acme/demo",
    skillId: "fast-skill",
    name: "fast-skill",
    installs: 900,
  },
];

const server: Server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("q") || "";
    if (query === "boom") {
      res.writeHead(500);
      res.end("upstream is unhappy");
      return;
    }
    if (query === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json</html>");
      return;
    }
    json(res, {
      query,
      skills: [
        ...HITS,
        // Entries the directory cannot install are dropped, not surfaced.
        { id: "", source: "", skillId: "" },
        { source: "acme/demo", skillId: "not a name" },
        { source: "acme", skillId: "orphan" },
      ],
    });
    return;
  }

  if (url.pathname.startsWith("/api/skills/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const view = parts[2] || "";
    const page = Number(parts[3] || 1);
    if (view === "all-time") {
      json(res, { skills: [HITS[1]], total: 500, hasMore: true, page });
      return;
    }
    if (view === "trending") {
      json(res, { skills: [HITS[0]], total: 1, hasMore: false, page });
      return;
    }
    json(res, { error: "Invalid view" }, 400);
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
process.env.JIT_SKILLS_SH_URL = `http://127.0.0.1:${port}`;

const { parseSkillsShRef, isSkillsShRef, isSkillsShUrl, searchSkillsSh, topSkills } =
  await import("../src/skillsSh.js");
const { searchMarketplace, topMarketplace } = await import("../src/marketplace.js");

after(() => {
  server.close();
});

test("a skills.sh link is parsed into a source and an optional skill", () => {
  assert.deepEqual(parseSkillsShRef("https://skills.sh/acme/demo"), {
    source: "acme/demo",
    skill: "",
  });
  assert.deepEqual(
    parseSkillsShRef("https://www.skills.sh/acme/demo/fast-skill?tab=readme"),
    { source: "acme/demo", skill: "fast-skill" },
  );
  assert.deepEqual(parseSkillsShRef("http://skills.sh/acme/demo.git/"), {
    source: "acme/demo",
    skill: "",
  });
});

test("a skills.sh link is told apart from every other source", () => {
  assert.equal(isSkillsShRef("https://skills.sh/acme/demo"), true);
  assert.equal(isSkillsShRef("https://github.com/acme/demo"), false);
  assert.equal(isSkillsShRef("https://example.com/catalog.json"), false);
  // A repository needs both halves, and a skill cannot be a path.
  assert.equal(isSkillsShRef("https://skills.sh/acme"), false);
  assert.equal(isSkillsShRef("https://skills.sh/acme/demo/sub/skill"), false);
  assert.equal(isSkillsShRef("acme/demo"), false);
  assert.equal(isSkillsShRef(""), false);
});

test("a malformed link on the directory is still recognised as one", () => {
  // The host is the directory, but the path is not something it addresses.
  assert.equal(isSkillsShUrl("https://skills.sh/acme"), true);
  assert.equal(isSkillsShRef("https://skills.sh/acme"), false);
  assert.equal(isSkillsShUrl("https://example.com/acme"), false);
  assert.equal(isSkillsShUrl("not a url"), false);
});

test("search returns the installable entries, best-installed first", async () => {
  const hits = await searchSkillsSh("react");
  assert.deepEqual(
    hits.map((hit) => hit.skill),
    ["fast-skill", "slow-skill"],
  );
  for (const hit of hits) {
    assert.equal(hit.source, "acme/demo");
    assert.equal(hit.name, hit.skill);
    assert.deepEqual(hit.weekly, []);
    assert.equal(hit.official, false);
  }
});

test("search asks for something before hitting the network", async () => {
  await assert.rejects(() => searchSkillsSh("a"), /two characters/);
  await assert.rejects(() => searchSkillsSh("  "), /two characters/);
});

test("an upstream failure and a non-JSON body both read as errors", async () => {
  await assert.rejects(() => searchSkillsSh("boom"), /HTTP 500/);
  await assert.rejects(() => searchSkillsSh("garbage"), /not JSON/);
});

test("the leaderboard reports a view, a page, and whether more follow", async () => {
  const ranked = await topSkills("all-time");
  assert.equal(ranked.view, "all-time");
  assert.equal(ranked.page, 1);
  assert.equal(ranked.total, 500);
  assert.equal(ranked.hasMore, true);
  assert.deepEqual(ranked.hits.map((hit) => hit.skill), ["fast-skill"]);

  // An unknown view falls back to the lifetime ranking, and the page is capped.
  const clamped = await topSkills("nonsense" as "all-time", 999);
  assert.equal(clamped.view, "all-time");
  assert.equal(clamped.page, 50);
});

test("a discovery entry carries the source the install step needs", async () => {
  const found = await searchMarketplace("react");
  assert.equal(found.warning, "");
  const fast = found.items.find((item) => item.id === "fast-skill");
  assert.ok(fast, "expected the fast skill");
  assert.equal(fast.kind, "skill");
  assert.equal(fast.origin, "skills.sh:acme/demo/fast-skill");
  assert.equal(fast.install.skills_source, "acme/demo");
  assert.equal(fast.install.skills_name, "fast-skill");
  assert.equal(fast.installs, 900);
  assert.equal(fast.installed, false);
});

test("the ranked view is exposed as marketplace entries", async () => {
  const ranked = await topMarketplace("trending", 1);
  assert.equal(ranked.view, "trending");
  assert.equal(ranked.page, 1);
  assert.equal(ranked.total, 1);
  assert.equal(ranked.has_more, false);
  assert.deepEqual(ranked.items.map((item) => item.id), ["slow-skill"]);
});
