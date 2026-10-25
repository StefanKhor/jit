import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import matter from "gray-matter";

import {
  DEFAULT_SKILL_PATHS,
  embeddingSignature,
  EMBEDDING_SIGNATURE_KEY,
  INDEX_DIR,
  MAX_SKILL_BYTES,
} from "./config.js";
import { embedTexts } from "./embedding.js";
import { logger } from "./logger.js";
import {
  clearIndex,
  countItems,
  dataVersion,
  deleteItem as dbDeleteItem,
  deleteToolsForServer as dbDeleteToolsForServer,
  getItem,
  getMeta,
  getStats,
  initDb,
  listItems,
  setEnabled as dbSetEnabled,
  setMeta,
  transaction,
  upsertItem,
  getExisting,
} from "./storage/db.js";
import type {
  Counts,
  IndexItem,
  ItemKind,
  ListItem,
  Stats,
} from "./types.js";

export { clearIndex, countItems, dataVersion, getItem, getStats, listItems };

const TOP_LEVEL_MARKDOWN = /\.md$/i;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
]);
const MAX_SCAN_DEPTH = 6;

// Batch local or remote embedding requests; import accepts up to 50k items.
const EMBED_BATCH_SIZE = 64;

// Records which embedding model produced the stored vectors. When the model or
// dimension changes, every vector is invalid and must be recomputed even if the
// entry text is unchanged.

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function isValidSkillFile(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (stat.size > MAX_SKILL_BYTES) {
      logger.warn("skipping oversized skill file: %s", file);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function discoverSkills(paths: string[] = DEFAULT_SKILL_PATHS): string[] {
  const found = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          depth >= MAX_SCAN_DEPTH ||
          entry.name.startsWith(".") ||
          SKIP_DIRS.has(entry.name)
        ) {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const isSkill = entry.name === "SKILL.md";
      const isTopLevelMarkdown =
        depth === 0 && TOP_LEVEL_MARKDOWN.test(entry.name) && !isSkill;
      if ((isSkill || isTopLevelMarkdown) && isValidSkillFile(full)) {
        found.add(full);
      }
    }
  };

  for (const raw of paths) {
    const base = path.resolve(expandHome(raw));
    if (!existsSync(base)) continue;
    try {
      const stat = statSync(base);
      if (stat.isFile()) {
        if (isValidSkillFile(base)) found.add(base);
        continue;
      }
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    walk(base, 0);
  }

  return [...found].sort();
}

function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((part) => String(part).trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

export function parseSkillText(
  text: string,
  sourcePath = "",
  fallbackName = "inline-skill",
): IndexItem {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) {
    throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  const parsed = matter(text);
  const meta = (parsed.data || {}) as Record<string, unknown>;
  const body = (parsed.content || "").trim();

  let name = String(meta.name || "").trim();
  if (!name) {
    if (sourcePath && path.basename(sourcePath) === "SKILL.md") {
      name = path.basename(path.dirname(sourcePath));
    } else if (sourcePath) {
      name = path.basename(sourcePath, path.extname(sourcePath));
    } else {
      name = fallbackName;
    }
  }
  name = name.replace(/[\\/]+/g, "-");
  const title = String(meta.title || name).trim();
  const description =
    String(meta.description || "").trim() ||
    body.slice(0, 120).replace(/\n/g, " ").trim() ||
    "No description";
  const whenToUse = String(
    meta.when_to_use || meta["when-to-use"] || "",
  ).trim();

  return {
    id: name,
    name: title || name,
    description,
    when_to_use: whenToUse || description,
    categories: asList(meta.categories),
    aliases: asList(meta.aliases),
    body,
    path: sourcePath,
    kind: "skill",
  };
}

export function parseSkillFile(file: string): IndexItem {
  const stat = statSync(file);
  if (stat.size > MAX_SKILL_BYTES) {
    throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  return parseSkillText(readFileSync(file, "utf8"), file);
}

export function buildEmbeddingText(item: IndexItem): string {
  if (item.kind === "tool") {
    return [
      item.name,
      item.description,
      (item.params || []).join(" "),
      (item.required || []).join(" "),
      item.server || "",
    ]
      .filter(Boolean)
      .join(" | ");
  }
  return [
    item.name.replace(/[-_]/g, " "),
    item.when_to_use,
    item.description,
    (item.aliases || []).join(" "),
  ]
    .filter(Boolean)
    .join(" | ");
}

export function contentHash(item: IndexItem): string {
  const payload = {
    name: item.name,
    description: item.description,
    when_to_use: item.when_to_use,
    categories: item.categories || [],
    aliases: item.aliases || [],
    body: item.body || "",
    kind: item.kind,
    // Path is part of the identity: moving a skill between a local folder and
    // JIT's own storage must update the indexed location even when the text is
    // identical. Tool manifests also need their callable surface in the hash.
    path: item.path || "",
    server: item.server || "",
    params: item.params || [],
    required: item.required || [],
    schema: item.schema || null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface IndexResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function indexItems(
  items: IndexItem[],
  itemType: ItemKind = "skill",
): Promise<IndexResult> {
  const db = initDb();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const activeSignature = embeddingSignature();
    const modelChanged = getMeta(db, EMBEDDING_SIGNATURE_KEY) !== activeSignature;
    const existing = getExisting(db);
    const pending: Array<{
      item: IndexItem;
      digest: string;
      current: { content_hash: string; embedding: Float32Array | null } | undefined;
    }> = [];

    for (const raw of items) {
      const item: IndexItem = {
        ...raw,
        kind: itemType,
        categories: raw.categories || [],
        aliases: raw.aliases || [],
        body: raw.body || "",
        path: raw.path || "",
      };
      const id = String(item.id || item.name || "").trim();
      if (!id) {
        errors.push("item without id/name skipped");
        continue;
      }
      item.id = id;
      const digest = contentHash(item);
      const current = existing.get(id);
      if (
        !modelChanged &&
        current &&
        current.content_hash === digest &&
        current.embedding !== null
      ) {
        skipped += 1;
        continue;
      }
      pending.push({ item, digest, current });
    }

    if (pending.length === 0) {
      return { added, updated, skipped, errors };
    }

    let embeddings: Array<Float32Array | null> = pending.map(
      ({ current }) => (modelChanged ? null : current?.embedding ?? null),
    );
    let embedded = false;
    try {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < pending.length; start += EMBED_BATCH_SIZE) {
        const batch = pending.slice(start, start + EMBED_BATCH_SIZE);
        const batchVectors = await embedTexts(
          batch.map(({ item }) => buildEmbeddingText(item)),
        );
        vectors.push(...batchVectors);
      }
      embeddings = pending.map((_, index) => vectors[index] || null);
      embedded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("embedding failed; indexing metadata only: %s", message);
      // Keep a previous vector only when the content and provider/model settings
      // are unchanged. Strict retrieval refuses entries without current vectors.
      errors.push(`embedding failed: ${message}`);
      embeddings = pending.map(({ current, digest }) =>
        !modelChanged && current?.content_hash === digest
          ? current.embedding
          : null,
      );
    }

    const now = new Date().toISOString();
    let addedNow = 0;
    let updatedNow = 0;
    transaction(db, () => {
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        if (!entry) continue;
        const { item, digest, current } = entry;
        upsertItem(db, {
          item,
          contentHash: digest,
          embedding: embeddings[index] ?? null,
          updatedAt: now,
        });
        if (current) updatedNow += 1;
        else addedNow += 1;
      }
      // Only record the signature once vectors were actually produced, so a
      // failed run retries instead of marking stale vectors as current.
      if (embedded) setMeta(db, EMBEDDING_SIGNATURE_KEY, activeSignature);
    });
    added += addedNow;
    updated += updatedNow;

    logger.info(
      "indexed %d items (%d added, %d updated)",
      pending.length,
      added,
      updated,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("indexing failed: %s", message);
    errors.push(message);
  }

  return { added, updated, skipped, errors };
}

export function deleteItem(id: string): boolean {
  return dbDeleteItem(initDb(), id);
}

export function deleteToolsForServer(server: string): number {
  return dbDeleteToolsForServer(initDb(), server);
}

export function setEnabled(id: string, enabled: boolean): boolean {
  return dbSetEnabled(initDb(), id, enabled);
}

export async function indexDefaultPaths(
  paths: string[] = DEFAULT_SKILL_PATHS,
): Promise<{
  found: number;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const files = discoverSkills(paths);
  const items: IndexItem[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      items.push(parseSkillFile(file));
    } catch (error) {
      errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (items.length === 0) {
    return { found: files.length, added: 0, updated: 0, skipped: 0, errors };
  }
  const result = await indexItems(items, "skill");
  return {
    found: files.length,
    added: result.added,
    updated: result.updated,
    skipped: result.skipped,
    errors: [...errors, ...result.errors],
  };
}

export function totalIndexed(): Counts {
  return countItems(initDb());
}

export function indexDirectory(): string {
  return INDEX_DIR;
}

export function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function getListItem(id: string): ListItem | null {
  return listItems(initDb()).find((item) => item.id === id) || null;
}

export function getStatsSnapshot(): Stats {
  return getStats(initDb());
}
