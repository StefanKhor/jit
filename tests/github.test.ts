import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the index: materialized sources and installed skills both live under
// JIT_HOME, and installs index their entries.
const HOME = mkdtempSync(path.join(tmpdir(), "jit-github-"));
process.env.JIT_HOME = HOME;
process.env.JIT_DISABLE_EMBEDDINGS = "1";

// A stand-in for the `skills` CLI. It writes what the real one writes
// (`<cwd>/.agents/skills/<name>/SKILL.md`) and prints the same JSON shape on
// stdout, so the wrapper is exercised without npx, git, or the network.
const FAKE = path.join(HOME, "fake-skills.mjs");
writeFileSync(
  FAKE,
  [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "",
    "const argv = process.argv.slice(2);",
    'const source = argv[argv.indexOf("add") + 1] || "";',
    "const root = path.join(process.cwd(), '.agents', 'skills');",
    "",
    "function body(name, description) {",
    "  return ['---', 'name: ' + name, 'description: ' + description,",
    "    'when_to_use: never', '---', 'Do the ' + name + ' thing.'].join('\\n');",
    "}",
    "function put(name, description) {",
    "  const dir = path.join(root, name);",
    "  mkdirSync(dir, { recursive: true });",
    "  writeFileSync(path.join(dir, 'SKILL.md'), body(name, description));",
    "  return dir;",
    "}",
    "",
    "const out = [];",
    "if (source === 'acme/ok') {",
    "  for (const [name, description] of [['alpha-skill', 'Alpha skill'], ['beta-skill', 'Beta skill']]) {",
    "    const dir = put(name, description);",
    "    out.push({ name, status: 'installed', source, ref: null, hash: 'hash-' + name,",
    "      path: dir, scope: 'project', agents: ['Universal'], mode: 'copy' });",
    "  }",
    "} else if (source === 'acme/partial') {",
    "  const dir = put('alpha-skill', 'Alpha skill');",
    "  out.push({ name: 'alpha-skill', status: 'installed', source, path: dir });",
    "  out.push({ name: 'gamma-skill', status: 'skipped', reason: 'no matching skill found' });",
    "} else if (source === 'acme/escape') {",
    "  out.push({ name: 'outside', status: 'installed', source, hash: 'h',",
    "    path: path.join(process.cwd(), 'outside') });",
    "} else if (source === 'acme/token') {",
    "  out.push({ name: 'token-probe', status: 'skipped',",
    "    reason: 'token=' + (process.env.GITHUB_TOKEN || 'none') });",
    "} else if (source === 'acme/fail') {",
    "  process.stdout.write('not json\\n');",
    "  process.exit(1);",
    "}",
    "process.stdout.write(JSON.stringify(out));",
    "",
  ].join("\n"),
);
process.env.JIT_SKILLS_CLI = `"${process.execPath}" "${FAKE}"`;

const { parseGithubRef, isGithubRef } = await import("../src/github.js");
const { materializeSource } = await import("../src/skillsCli.js");
const { catalog, install } = await import("../src/marketplace.js");
const { saveConfig, JIT_SKILLS_DIR } = await import("../src/config.js");

test("a GitHub reference is parsed from shorthand and from a URL", () => {
  assert.deepEqual(parseGithubRef("vercel-labs/agent-skills"), {
    owner: "vercel-labs",
    repo: "agent-skills",
    ref: "",
    subpath: "",
  });
  assert.deepEqual(parseGithubRef("owner/repo@v1#skills/web"), {
    owner: "owner",
    repo: "repo",
    ref: "v1",
    subpath: "skills/web",
  });
  assert.deepEqual(
    parseGithubRef("https://github.com/owner/repo/tree/main/skills"),
    { owner: "owner", repo: "repo", ref: "main", subpath: "skills" },
  );
});

test("a catalog URL is not mistaken for a repository", () => {
  assert.equal(isGithubRef("https://example.com/catalog.json"), false);
  assert.equal(isGithubRef("https://github.com/owner/repo"), true);
  assert.equal(isGithubRef("not a source"), false);
  assert.equal(isGithubRef(""), false);
});

test("materializing a source lists the skills the CLI installed", async () => {
  const result = await materializeSource("acme/ok");
  assert.equal(result.warning, "");
  assert.deepEqual(
    result.skills.map((skill) => skill.name).sort(),
    ["alpha-skill", "beta-skill"],
  );
  for (const skill of result.skills) {
    const file = path.join(skill.path, "SKILL.md");
    assert.ok(existsSync(file), `expected ${file}`);
    assert.match(skill.path, /\.agents[\\/]skills[\\/]alpha-skill|\.agents[\\/]skills[\\/]beta-skill/);
  }
});

test("a skipped entry becomes a warning instead of a skill", async () => {
  const result = await materializeSource("acme/partial");
  assert.deepEqual(result.skills.map((skill) => skill.name), ["alpha-skill"]);
  assert.match(result.warning, /gamma-skill/);
});

test("a skill installed outside the target directory is refused", async () => {
  const result = await materializeSource("acme/escape");
  assert.deepEqual(result.skills, []);
  assert.match(result.warning, /unexpected install path/);
});

test("a CLI failure surfaces a readable error", async () => {
  await assert.rejects(
    () => materializeSource("acme/fail"),
    /skills CLI returned no result/,
  );
});

test("JIT_GITHUB_TOKEN is forwarded to the CLI as GITHUB_TOKEN", async () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.JIT_GITHUB_TOKEN = "secret-token";
  try {
    const result = await materializeSource("acme/token");
    assert.match(result.warning, /token=secret-token/);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
    delete process.env.JIT_GITHUB_TOKEN;
  }
});

test("a repository source installs into the JIT store", async () => {
  saveConfig({ marketplace_urls: ["acme/ok"] });
  const listed = await catalog();
  assert.equal(listed.source, "remote");
  assert.equal(listed.warning, "");
  assert.deepEqual(
    listed.items.map((item) => item.id).sort(),
    ["alpha-skill", "beta-skill"],
  );
  const alpha = listed.items.find((item) => item.id === "alpha-skill");
  assert.ok(alpha);
  assert.equal(alpha.origin, "skills:acme/ok");
  assert.equal(alpha.install.skills_source, "acme/ok");
  assert.equal(alpha.checksum_present, true);

  const result = await install("alpha-skill");
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.ok(existsSync(path.join(JIT_SKILLS_DIR, "alpha-skill", "SKILL.md")));
  // Nothing changed between listing and installing, so the CLI hash matches and
  // there is no staleness warning.
  const warnings = result.warnings as Array<{ rule: string }>;
  assert.equal(warnings.some((finding) => finding.rule === "content-changed"), false);
});
