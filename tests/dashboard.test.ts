import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the index and stay offline: no model download, no network. Clear the
// environment overrides so the auth and config assertions are deterministic.
process.env.JIT_HOME = mkdtempSync(path.join(tmpdir(), "jit-api-"));
process.env.JIT_DISABLE_EMBEDDINGS = "1";
delete process.env.JIT_API_KEY;
delete process.env.NEBIUS_API_KEY;
delete process.env.JIT_MARKETPLACE_URL;
delete process.env.JIT_CONFIDENCE_THRESHOLD;

const { createApp, breakEvenSize } = await import(
  "../src/server/dashboard.js"
);
const { saveConfig } = await import("../src/config.js");

const app = createApp();
const skillRoot = mkdtempSync(path.join(tmpdir(), "jit-api-skill-"));

function post(body: unknown) {
  return app.request("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(route: string, body: unknown) {
  return app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(() => {
  saveConfig({ api_key: "", marketplace_urls: [], confidence_threshold: 0.6 });
  const file = path.join(skillRoot, "SKILL.md");
  writeFileSync(
    file,
    [
      "---",
      "name: api-skill",
      "description: a skill indexed through the HTTP API",
      "---",
      "Do the API thing.",
    ].join("\n"),
  );
});

after(() => {
  saveConfig({ api_key: "", marketplace_urls: [] });
  rmSync(skillRoot, { recursive: true, force: true });
});

test("health and status report from the live index", async () => {
  const health = await app.request("/api/health");
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.status, "healthy");
  assert.equal(healthBody.auth_required, false);
  assert.equal(typeof healthBody.version, "string");

  const status = await app.request("/api/status");
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as Record<string, number>;
  for (const key of ["indexed", "skills", "tools", "enabled"]) {
    assert.equal(typeof statusBody[key], "number", key);
  }
});

// The reference index: schema 636, average catalog entry 79 tokens. The body a
// task loads cancels from both sides, so break-even is where the catalog passes
// the schema — 636 / 79 crosses at the ninth entry.
test("break-even is the first size where JIT beats a skill catalog", () => {
  assert.equal(breakEvenSize(636, 79), 9);
  // A richer catalog crosses sooner.
  assert.equal(breakEvenSize(636, 212), 4);
  // No entries means no crossing point.
  assert.equal(breakEvenSize(636, 0), 0);

  // The invariant, whatever the inputs: at the break-even size the catalog
  // exceeds the schema, and one entry below it does not.
  const cases: Array<[number, number]> = [
    [636, 79],
    [636, 212],
    [617, 30],
    [900, 120],
  ];
  for (const [schema, catalog] of cases) {
    const size = breakEvenSize(schema, catalog);
    assert.ok(size * catalog > schema, `JIT should win at size ${size}`);
    assert.ok(
      (size - 1) * catalog <= schema,
      `the catalog should not lose below size ${size}`,
    );
  }
});

// The route must wire the same model: at rest, JIT's schema against the
// catalog, with the shared on-demand body left out of both.
test("stats compare JIT against a catalog at rest", async () => {
  await call("/api/skills/add", { path: path.join(skillRoot, "SKILL.md") });
  try {
    const res = await app.request("/api/stats");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      catalog_tokens: number;
      tokens: {
        jit: number;
        catalog: number;
        saved: number;
        reduction_pct: number;
      };
    };
    assert.ok(body.tokens.catalog > 0, "the seeded skill should have a catalog");
    assert.equal(body.tokens.catalog, body.catalog_tokens);
    assert.equal(
      body.tokens.reduction_pct,
      Number(((1 - body.tokens.jit / body.tokens.catalog) * 100).toFixed(1)),
    );
    assert.equal(
      body.tokens.saved,
      Math.max(0, body.tokens.catalog - body.tokens.jit),
    );
  } finally {
    await app.request("/api/skills/api-skill", { method: "DELETE" });
  }
});

// A plain catalog is the sum of its entries: each skill's name-and-description
// cost has to add up to the catalog total the Overview reports.
test("per-skill catalog costs add up to the catalog total", async () => {
  await call("/api/skills/add", { path: path.join(skillRoot, "SKILL.md") });
  try {
    const listed = (await (await app.request("/api/skills")).json()) as {
      skills: Array<{ catalog_tokens: number }>;
    };
    const stats = (await (await app.request("/api/stats")).json()) as {
      catalog_tokens: number;
    };
    const [first] = listed.skills;
    assert.ok(first, "the seeded skill should be listed");
    assert.equal(
      listed.skills.reduce((sum, skill) => sum + skill.catalog_tokens, 0),
      stats.catalog_tokens,
    );
    const expected =
      Math.floor(("api-skill".length + 3) / 4) +
      Math.floor(("a skill indexed through the HTTP API".length + 3) / 4) +
      12;
    assert.equal(first.catalog_tokens, expected);
  } finally {
    await app.request("/api/skills/api-skill", { method: "DELETE" });
  }
});

test("every response carries the hardening headers", async () => {
  const response = await app.request("/api/health");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("the dashboard is served with a restrictive CSP", async () => {
  const response = await app.request("/");
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors|base-uri 'none'/);
  assert.equal((await app.request("/index.html")).status, 302);
});

test("the public config is redacted and has no dead settings", async () => {
  saveConfig({ nebius_api_key: "nb-secret-4321" });
  const response = await app.request("/api/config");
  const config = (await response.json()) as Record<string, unknown>;
  assert.equal(config.nebius_api_key, "***4321");
  assert.equal(config.api_key, "");
  assert.equal("nemotron_ultra_model" in config, false);
  assert.ok(Array.isArray(config.marketplace_urls));
  saveConfig({ nebius_api_key: "" });
});

test("config writes are validated", async () => {
  // Out-of-range thresholds clamp; non-numbers are rejected.
  const clamped = await post({ confidence_threshold: 5 });
  assert.equal(clamped.status, 200);
  assert.equal(
    ((await clamped.json()) as { config: { confidence_threshold: number } })
      .config.confidence_threshold,
    1,
  );
  assert.equal((await post({ confidence_threshold: "abc" })).status, 400);
  assert.equal((await post({ marketplace_urls: "nope" })).status, 400);
  assert.equal((await post({ nebius_api_base: "http://evil.test" })).status, 400);

  // A GitHub repository is a valid catalog source.
  for (const entry of [
    "acme/demo",
    "acme/demo@v1.2.3#skills",
    "https://github.com/acme/demo/tree/main/skills",
  ]) {
    const response = await post({ marketplace_urls: [entry] });
    assert.equal(response.status, 200, entry);
  }
  // So is a link to the skills.sh directory.
  for (const entry of [
    "https://skills.sh/acme/demo",
    "https://www.skills.sh/acme/demo/some-skill",
  ]) {
    const response = await post({ marketplace_urls: [entry] });
    assert.equal(response.status, 200, entry);
  }
  assert.equal((await post({ marketplace_urls: ["just-one-segment"] })).status, 400);
  assert.equal(
    (await post({ marketplace_urls: ["https://skills.sh/acme"] })).status,
    400,
  );
  await post({ marketplace_urls: [] });

  const threshold = await post({ confidence_threshold: 0.42 });
  assert.equal(threshold.status, 200);
  const body = (await threshold.json()) as { config: { confidence_threshold: number } };
  assert.equal(body.config.confidence_threshold, 0.42);
  await post({ confidence_threshold: 0.6 });
});

test("the API key gates /api/* but not health", async () => {
  assert.equal((await post({ api_key: "test-key" })).status, 200);
  try {
    assert.equal((await app.request("/api/status")).status, 401);
    assert.equal(
      (
        await app.request("/api/status", {
          headers: { authorization: "Bearer test-key" },
        })
      ).status,
      200,
    );
    assert.equal(
      (await app.request("/api/status", { headers: { "x-api-key": "test-key" } }))
        .status,
      200,
    );
    assert.equal(
      (
        await app.request("/api/status", {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
    assert.equal((await app.request("/api/health")).status, 200);
  } finally {
    // Reset directly: while a key is set, the config API itself needs auth.
    saveConfig({ api_key: "" });
  }
});

test("skills can be indexed, listed, read, toggled, and deleted", async () => {
  const added = await call("/api/skills/add", {
    path: path.join(skillRoot, "SKILL.md"),
  });
  assert.equal(added.status, 200);
  const addedBody = (await added.json()) as { added: number };
  assert.ok(addedBody.added >= 1);

  const listed = await app.request("/api/skills");
  const listBody = (await listed.json()) as { skills: Array<Record<string, unknown>> };
  const entry = listBody.skills.find((item) => item.id === "api-skill");
  assert.ok(entry, "the skill should be listed");
  assert.equal(entry.managed, false);

  const detail = await app.request("/api/skills/api-skill");
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as Record<string, unknown>;
  assert.equal(detailBody.id, "api-skill");
  assert.equal(detailBody.embedding, undefined);
  assert.equal(typeof detailBody.tokens, "number");

  assert.equal((await app.request("/api/skills/nope")).status, 404);

  const toggled = await call("/api/skills/toggle", {
    id: "api-skill",
    enabled: false,
  });
  assert.equal(toggled.status, 200);
  assert.equal(((await toggled.json()) as { enabled: boolean }).enabled, false);
  await call("/api/skills/toggle", { id: "api-skill", enabled: true });

  const sources = await app.request("/api/skills/sources");
  assert.equal(sources.status, 200);

  const removed = await app.request("/api/skills/api-skill", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await app.request("/api/skills/api-skill")).status, 404);
});

test("skills can be toggled and removed in bulk", async () => {
  const second = path.join(skillRoot, "second");
  mkdirSync(second, { recursive: true });
  writeFileSync(
    path.join(second, "SKILL.md"),
    [
      "---",
      "name: bulk-skill",
      "description: a second skill for the batch endpoints",
      "---",
      "Do the second thing.",
    ].join("\n"),
  );
  await call("/api/skills/add", { path: path.join(skillRoot, "SKILL.md") });
  await call("/api/skills/add", { path: path.join(second, "SKILL.md") });

  assert.equal(
    (await call("/api/skills/bulk", { ids: [], action: "enable" })).status,
    400,
  );
  assert.equal(
    (await call("/api/skills/bulk", { ids: ["api-skill"], action: "explode" }))
      .status,
    400,
  );

  const disabled = await call("/api/skills/bulk", {
    ids: ["api-skill", "bulk-skill", "missing-skill"],
    action: "disable",
  });
  assert.equal(disabled.status, 200);
  const disabledBody = (await disabled.json()) as {
    ok: string[];
    failed: Array<{ id: string; error: string }>;
  };
  assert.deepEqual(disabledBody.ok.sort(), ["api-skill", "bulk-skill"]);
  assert.equal(disabledBody.failed.length, 1);
  assert.equal(disabledBody.failed[0]?.id, "missing-skill");

  const listed = await app.request("/api/skills");
  const listBody = (await listed.json()) as {
    skills: Array<{ id: string; enabled: boolean }>;
  };
  assert.equal(
    listBody.skills.find((item) => item.id === "api-skill")?.enabled,
    false,
  );

  const removed = await call("/api/skills/bulk", {
    ids: ["api-skill", "bulk-skill"],
    action: "remove",
  });
  assert.equal(removed.status, 200);
  const removedBody = (await removed.json()) as {
    ok: string[];
    files_removed: number;
  };
  assert.deepEqual(removedBody.ok.sort(), ["api-skill", "bulk-skill"]);
  // Both live outside the JIT skills dir, so no files are deleted.
  assert.equal(removedBody.files_removed, 0);
  assert.equal((await app.request("/api/skills/api-skill")).status, 404);
});

test("mcp bulk rejects an empty or unknown request", async () => {
  assert.equal(
    (await call("/api/mcp/bulk", { servers: [], action: "connect" })).status,
    400,
  );
  assert.equal(
    (await call("/api/mcp/bulk", { servers: ["x"], action: "sing" })).status,
    400,
  );
});

test("search reports the threshold and never silently invents a match", async () => {
  assert.equal((await call("/api/search", {})).status, 400);

  await call("/api/skills/add", { path: path.join(skillRoot, "SKILL.md") });
  const response = await call("/api/search", { intent: "api thing" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body.threshold, "number");
  assert.ok(Array.isArray(body.candidates));
  assert.ok(Array.isArray(body.near_misses));
  assert.equal(typeof body.keyword_only, "boolean");
  await app.request("/api/skills/api-skill", { method: "DELETE" });
});

test("retrieval history is exposed and can be cleared", async () => {
  const response = await app.request("/api/retrieval");
  assert.equal(response.status, 200);
  const cleared = await call("/api/retrieval/clear", {});
  assert.equal(cleared.status, 200);
});

test("mcp servers are listed without connecting", async () => {
  const response = await app.request("/api/mcp");
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(body.servers));
});

test("the marketplace is empty until a source is configured", async () => {
  const response = await app.request("/api/marketplace");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    items: unknown[];
    source: string;
    warning: string;
  };
  assert.deepEqual(body.items, []);
  assert.equal(body.source, "none");
  assert.match(body.warning, /No marketplace catalogs configured/);

  assert.equal((await call("/api/marketplace/inspect", {})).status, 400);
  assert.equal((await call("/api/marketplace/inspect", { id: "nope" })).status, 400);
  assert.equal((await call("/api/marketplace/install", {})).status, 400);
  assert.equal((await call("/api/marketplace/uninstall", {})).status, 400);

  // The directory search needs a real query before it reaches the network, so a
  // short one is rejected without any call.
  assert.equal((await app.request("/api/marketplace/search")).status, 400);
  assert.equal((await app.request("/api/marketplace/search?q=a")).status, 400);
});

test("unknown routes answer in the right shape", async () => {
  const api = await app.request("/api/nope");
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: "not found" });

  const page = await app.request("/nope");
  assert.equal(page.status, 404);
  assert.equal(await page.text(), "Not found");
});
