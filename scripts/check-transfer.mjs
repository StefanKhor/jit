import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "jit-transfer-check-"));
const embeddings = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { input } = JSON.parse(body);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({
    data: input.map((_, index) => ({ index, embedding: [1, 0] })),
  }));
});
embeddings.listen(0, "127.0.0.1");
await once(embeddings, "listening");
after(async () => {
  await new Promise((resolve) => embeddings.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

// Exercise real indexing without downloading a model or contacting a cloud API.
Object.assign(process.env, {
  JIT_HOME: path.join(root, "jit"),
  JIT_LOG_LEVEL: "ERROR",
  JIT_DISABLE_EMBEDDINGS: "",
  JIT_EMBEDDING_PROVIDER: "openai-compatible",
  JIT_EMBEDDING_API_BASE: `http://127.0.0.1:${embeddings.address().port}/v1`,
  JIT_EMBEDDING_API_MODEL: "test-embedding",
  JIT_EMBEDDING_API_DIM: "2",
  JIT_EMBEDDING_API_KEY: "",
});
const { copySkillsToJit, exportSkills, indexSkillsInPlace, removeSkillCopy } =
  await import("../dist/transfer.js");
const { getItem } = await import("../dist/indexer.js");
const { INDEX_FILE, JIT_SKILLS_DIR } = await import("../dist/config.js");

const script = "#!/bin/sh\necho checked\n";
const asset = Buffer.from([0, 255, 128, 10]);

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function skill(name) {
  const file = path.join(root, "sources", name, "SKILL.md");
  write(file, `---\nname: ${name}\ndescription: Test procedure\n---\nUse scripts/check.sh and references/nested/guide.md.\n`);
  write(path.join(path.dirname(file), "scripts/check.sh"), script);
  write(path.join(path.dirname(file), "references/nested/guide.md"), "Guide\n");
  write(path.join(path.dirname(file), "assets/data.bin"), asset);
  return file;
}

function assertBundle(directory) {
  assert.ok(existsSync(path.join(directory, "SKILL.md")));
  assert.equal(readFileSync(path.join(directory, "scripts/check.sh"), "utf8"), script);
  assert.equal(readFileSync(path.join(directory, "references/nested/guide.md"), "utf8"), "Guide\n");
  assert.deepEqual(readFileSync(path.join(directory, "assets/data.bin")), asset);
}

function linkDirectory(target, link) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("import and export preserve a selected skill's whole directory", async () => {
  const source = skill("bundle");
  skill("neighbor");
  write(path.join(path.dirname(source), ".git/config"), "not skill content");
  write(path.join(path.dirname(source), ".metadata"), "keep this");
  chmodSync(path.join(path.dirname(source), "scripts/check.sh"), 0o755);
  const copied = await copySkillsToJit(path.join(root, "sources"), false, new Set(["bundle"]));
  assert.deepEqual(copied.errors, []);
  assert.equal(copied.copied.length, 1);
  const managed = path.join(JIT_SKILLS_DIR, "bundle");
  assertBundle(managed);
  assert.ok(!existsSync(path.join(JIT_SKILLS_DIR, "neighbor")));
  assert.ok(!existsSync(path.join(managed, ".git")));
  assert.equal(readFileSync(path.join(managed, ".metadata"), "utf8"), "keep this");
  assert.equal(getItem("bundle").path, path.join(managed, "SKILL.md"));
  const row = JSON.parse(readFileSync(INDEX_FILE, "utf8")).items.find((item) => item.id === "bundle");
  assert.ok(!Object.hasOwn(row, "body"));

  const destination = path.join(root, "exported");
  const exported = await exportSkills(["bundle"], destination);
  assert.deepEqual(exported.errors, []);
  assert.equal(exported.exported.length, 1);
  assertBundle(path.join(destination, "bundle"));
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(destination, "bundle/scripts/check.sh")).mode & 0o777, 0o755);
  }
});

test("standalone markdown does not copy unrelated files from its parent", async () => {
  const source = path.join(root, "loose/standalone.md");
  write(source, "# A single-file procedure\n");
  write(path.join(path.dirname(source), "private.txt"), "not a skill asset");
  const copied = await copySkillsToJit(source);
  assert.deepEqual(copied.errors, []);
  assert.deepEqual(readdirSync(path.join(JIT_SKILLS_DIR, "standalone")), ["SKILL.md"]);
  assert.ok(existsSync(source));

  await indexSkillsInPlace(source);
  const destination = path.join(root, "loose-export");
  const exported = await exportSkills(["standalone"], destination);
  assert.deepEqual(exported.errors, []);
  assert.deepEqual(readdirSync(path.join(destination, "standalone")), ["SKILL.md"]);
});

test("overwrite is opt-in and replaces stale supporting files", async () => {
  const source = skill("overwrite");
  await copySkillsToJit(source);
  const managed = path.join(JIT_SKILLS_DIR, "overwrite");
  write(path.join(managed, "stale.txt"), "old asset");
  write(path.join(path.dirname(source), "scripts/check.sh"), "updated script");
  const blocked = await copySkillsToJit(source);
  assert.equal(blocked.copied.length, 0);
  assert.match(blocked.errors[0], /already exists/);
  assertBundle(managed);

  const replaced = await copySkillsToJit(source, true);
  assert.deepEqual(replaced.errors, []);
  assert.equal(readFileSync(path.join(managed, "scripts/check.sh"), "utf8"), "updated script");
  assert.ok(!existsSync(path.join(managed, "stale.txt")));
  assert.ok(existsSync(source));

  const destination = path.join(root, "overwrite-export");
  const target = path.join(destination, "overwrite");
  write(path.join(target, "keep.txt"), "existing destination");
  const skipped = await exportSkills(["overwrite"], destination);
  assert.deepEqual(skipped.skipped, ["overwrite"]);
  assert.ok(existsSync(path.join(target, "keep.txt")));
  const exported = await exportSkills(["overwrite"], destination, true);
  assert.deepEqual(exported.errors, []);
  assert.ok(!existsSync(path.join(target, "keep.txt")));
  assert.equal(readFileSync(path.join(target, "scripts/check.sh"), "utf8"), "updated script");
});

test("a failed bundle copy leaves the previous copy intact", async () => {
  const source = skill("failed-copy");
  await copySkillsToJit(source);
  const outside = path.join(root, "outside");
  write(path.join(outside, "private.txt"), "do not follow this link");
  linkDirectory(outside, path.join(path.dirname(source), "external"));
  write(path.join(path.dirname(source), "scripts/check.sh"), "new script");
  const copied = await copySkillsToJit(source, true);
  assert.equal(copied.copied.length, 0);
  assert.match(copied.errors[0], /cannot copy links/);
  assertBundle(path.join(JIT_SKILLS_DIR, "failed-copy"));
  assert.ok(!readdirSync(JIT_SKILLS_DIR).some((name) => name.startsWith(".jit-transfer-")));
  assert.equal(readFileSync(path.join(outside, "private.txt"), "utf8"), "do not follow this link");

  await indexSkillsInPlace(source);
  await copySkillsToJit(skill("valid-export"));
  const destination = path.join(root, "failed-export");
  const exported = await exportSkills(["failed-copy", "valid-export"], destination);
  assert.match(exported.errors[0], /cannot copy links/);
  assert.deepEqual(exported.exported.map((item) => item.id), ["valid-export"]);
  assertBundle(path.join(destination, "valid-export"));
});

test("copying cannot replace a destination through a symbolic link", async () => {
  const source = skill("linked-target");
  const outside = path.join(root, "linked-outside");
  write(path.join(outside, "keep.txt"), "untouched");
  linkDirectory(outside, path.join(JIT_SKILLS_DIR, "linked-target"));
  const copied = await copySkillsToJit(source, true);
  assert.match(copied.errors[0], /symbolic link/);
  assert.deepEqual(readdirSync(outside), ["keep.txt"]);
});

test("overlapping skill folders are rejected rather than recursively copied or replaced", async () => {
  const source = skill("overlap");
  await indexSkillsInPlace(source);
  const exported = await exportSkills(["overlap"], path.join(path.dirname(source), "nested"), true);
  assert.match(exported.errors[0], /must not overlap/);
  assertBundle(path.dirname(source));

  const nested = path.join(root, "ancestor/ancestor-skill/..nested/procedure.md");
  write(nested, "---\nname: ancestor-skill\n---\nStandalone procedure\n");
  await indexSkillsInPlace(nested);
  const ancestor = await exportSkills(["ancestor-skill"], path.join(root, "ancestor"), true);
  assert.match(ancestor.errors[0], /must not overlap/);
  assert.ok(existsSync(nested));
});

test("uninstall removes a managed bundle but leaves original and neighboring files", async () => {
  const source = skill("uninstall");
  await copySkillsToJit(source);
  const neighbor = path.join(JIT_SKILLS_DIR, "keep.txt");
  write(neighbor, "untouched");
  assert.equal(await removeSkillCopy("uninstall"), true);
  assert.ok(!existsSync(path.join(JIT_SKILLS_DIR, "uninstall")));
  assert.equal(getItem("uninstall"), null);
  assertBundle(path.dirname(source));
  assert.ok(existsSync(neighbor));

  const local = skill("local-only");
  await indexSkillsInPlace(local);
  assert.equal(await removeSkillCopy("local-only"), false);
  assertBundle(path.dirname(local));
  assert.equal(getItem("local-only"), null);

  const nested = path.join(JIT_SKILLS_DIR, "group/nested/SKILL.md");
  write(nested, "---\nname: nested-managed\n---\nNested procedure\n");
  write(path.join(path.dirname(nested), "scripts/helper.py"), "print('helper')\n");
  await indexSkillsInPlace(nested);
  assert.equal(await removeSkillCopy("nested-managed"), true);
  assert.ok(!existsSync(path.dirname(nested)));
  assert.ok(existsSync(path.join(JIT_SKILLS_DIR, "group")));
  assert.ok(existsSync(neighbor));
});

test("uninstall refuses a managed path that resolves outside JIT storage", async () => {
  const source = skill("linked-uninstall");
  const linked = path.join(JIT_SKILLS_DIR, "linked-uninstall");
  linkDirectory(path.dirname(source), linked);
  await indexSkillsInPlace(path.join(linked, "SKILL.md"));
  assert.equal(await removeSkillCopy("linked-uninstall"), false);
  assert.ok(getItem("linked-uninstall"));
  assertBundle(path.dirname(source));
});
