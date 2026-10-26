import { existsSync, readFileSync, statSync } from "node:fs";

import {
  atomicWriteFile,
  embeddingSignature,
  INDEX_FILE,
} from "../config.js";
import type {
  IndexItem,
  ListItem,
  Stats,
  StoredItem,
} from "../types.js";

/**
 * The index is one plain file, not a database. `index.json` holds every skill
 * (metadata, body, content hash, and its embedding as base64) plus the embedding
 * signature. It is the single source of truth and is always replaced atomically,
 * so a reader sees either the whole previous file or the whole next one.
 *
 * That single-writer, atomic-replace model is what keeps writes safe without a
 * database. Reads are cached in-process and revalidated against the file's
 * mtime/size, so a `jit serve` process notices dashboard edits immediately.
 */

const INDEX_VERSION = 1;

/** A skill as serialized to `index.json`. The embedding is base64 float32. */
interface Row {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  categories: string[];
  aliases: string[];
  body: string;
  path: string;
  enabled: boolean;
  content_hash: string;
  updated_at: string;
  embedding: string | null;
}

interface IndexFile {
  version: number;
  embedding_signature: string | null;
  revision: number;
  items: Row[];
}

export interface UpsertRow {
  item: IndexItem;
  contentHash: string;
  embedding: Float32Array | null;
  updatedAt: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * Token estimates mirror the character-based heuristic used by the dashboard:
 * roughly four characters per token, rounded up, plus a fixed per-entry cost for
 * the name/description pair a plain catalog would carry.
 */
function estimateTokens(text: string): number {
  return Math.floor((text.length + 3) / 4);
}

function catalogTokens(row: Row): number {
  return estimateTokens(row.name) + estimateTokens(row.description) + 12;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function byName(a: Row, b: Row): number {
  if (a.name === b.name) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.name < b.name ? -1 : 1;
}

function encodeVector(vector: Float32Array | null): string | null {
  if (!vector) return null;
  return Buffer.from(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  ).toString("base64");
}

function decodeVector(value: unknown): Float32Array | null {
  if (typeof value !== "string" || !value) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength % 4 !== 0) return null;
  // Copy into an aligned buffer: `Buffer.from(base64)` may hand back a view
  // into Node's shared pool, whose byteOffset is not safe for a Float32Array.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return new Float32Array(bytes.buffer);
}

function asRow(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    name: String(row.name ?? id),
    description: String(row.description ?? ""),
    when_to_use: String(row.when_to_use ?? ""),
    categories: asStringList(row.categories),
    aliases: asStringList(row.aliases),
    body: String(row.body ?? ""),
    path: String(row.path ?? ""),
    enabled: row.enabled !== false,
    content_hash: String(row.content_hash ?? ""),
    updated_at: String(row.updated_at ?? ""),
    embedding: typeof row.embedding === "string" && row.embedding ? row.embedding : null,
  };
}

function emptyIndex(): IndexFile {
  return { version: INDEX_VERSION, embedding_signature: null, revision: 0, items: [] };
}

function normalize(value: unknown): IndexFile {
  const source = (
    value && typeof value === "object" ? value : {}
  ) as Record<string, unknown>;
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(asRow)
    .filter((row): row is Row => row !== null);
  items.sort(byName);
  return {
    version: INDEX_VERSION,
    embedding_signature:
      typeof source.embedding_signature === "string"
        ? source.embedding_signature
        : null,
    revision: typeof source.revision === "number" ? source.revision : 0,
    items,
  };
}

// Bumped on every in-process write so a same-millisecond rewrite is still
// visible, alongside the file signature for cross-process edits.
let writeSeq = 0;
let cache: { token: string; file: IndexFile } | null = null;

function fileToken(): string {
  try {
    const info = statSync(INDEX_FILE);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

function currentToken(): string {
  return `${writeSeq}:${fileToken()}`;
}

/**
 * Read the index, reusing the in-process copy while the file is unchanged.
 *
 * A malformed file throws rather than reading as empty: silently treating a
 * corrupt index as "no skills" would let the next write overwrite recoverable
 * data with an empty index.
 */
function readIndex(): IndexFile {
  const token = currentToken();
  if (cache && cache.token === token) return cache.file;
  let file = emptyIndex();
  if (existsSync(INDEX_FILE)) {
    let raw: string;
    try {
      raw = readFileSync(INDEX_FILE, "utf8");
    } catch (error) {
      throw new Error(`could not read ${INDEX_FILE}: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${INDEX_FILE} is not valid JSON: ${errorMessage(error)}`);
    }
    file = normalize(parsed);
  }
  // Cache under the token observed before the read: if a writer replaced the
  // file mid-read, the next call sees a different token and reads again.
  cache = { token, file };
  return file;
}

function writeIndex(file: IndexFile): void {
  file.version = INDEX_VERSION;
  file.revision += 1;
  atomicWriteFile(INDEX_FILE, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  writeSeq += 1;
  cache = { token: currentToken(), file };
}

function rowToItem(row: Row, includeBody = true): StoredItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    when_to_use: row.when_to_use,
    categories: row.categories,
    aliases: row.aliases,
    body: includeBody ? row.body : "",
    path: row.path,
    enabled: row.enabled,
    content_hash: row.content_hash,
    updated_at: row.updated_at,
    embedding: decodeVector(row.embedding),
  };
}

/**
 * Changes when the on-disk index changes, so a cached corpus can tell whether
 * it is stale. Cheap: one `stat`, no read.
 */
export function dataVersion(): string {
  return currentToken();
}

export function getEmbeddingSignature(): string | null {
  return readIndex().embedding_signature;
}

export function getItem(id: string): StoredItem | null {
  const row = readIndex().items.find((item) => item.id === id);
  return row ? rowToItem(row) : null;
}

export function getAllItems(includeBody = true): StoredItem[] {
  return readIndex().items.map((row) => rowToItem(row, includeBody));
}

export function getExisting(): Map<
  string,
  { content_hash: string; embedding: Float32Array | null }
> {
  return new Map(
    readIndex().items.map((row) => [
      row.id,
      { content_hash: row.content_hash, embedding: decodeVector(row.embedding) },
    ]),
  );
}

export function listItems(): ListItem[] {
  const file = readIndex();
  const embeddingsCurrent =
    file.embedding_signature === embeddingSignature();
  return file.items.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    categories: row.categories,
    path: row.path,
    aliases: row.aliases,
    enabled: row.enabled,
    tokens: estimateTokens(row.body),
    catalog_tokens: catalogTokens(row),
    has_embedding: embeddingsCurrent && row.embedding !== null,
  }));
}

export function getStats(): Stats {
  const file = readIndex();
  const embeddingsCurrent =
    file.embedding_signature === embeddingSignature();
  const categories = new Map<string, number>();
  const heaviest: Array<{ name: string; tokens: number }> = [];
  let enabled = 0;
  let disabled = 0;
  let bodyTokens = 0;
  let catalog = 0;
  let largest = 0;
  let embedded = 0;
  for (const row of file.items) {
    if (row.enabled) enabled += 1;
    else disabled += 1;
    const body = estimateTokens(row.body);
    bodyTokens += body;
    catalog += catalogTokens(row);
    if (body > largest) largest = body;
    if (row.embedding !== null) embedded += 1;
    for (const name of row.categories) {
      categories.set(name, (categories.get(name) || 0) + 1);
    }
    heaviest.push({ name: row.name, tokens: body });
  }
  const total = file.items.length;
  heaviest.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    total,
    enabled,
    disabled,
    body_tokens: bodyTokens,
    catalog_tokens: catalog,
    average_body: total ? Math.floor(bodyTokens / total) : 0,
    largest,
    heaviest: heaviest.slice(0, 6),
    categories: [...categories.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count })),
    embedding_coverage: {
      total,
      embedded: embeddingsCurrent ? embedded : 0,
    },
  };
}

/**
 * Insert or update a batch in one atomic write, optionally recording the
 * embedding signature the vectors were produced with. Existing `enabled` state
 * is preserved, matching the previous upsert semantics.
 */
export function upsertItems(rows: UpsertRow[], signature?: string): void {
  if (rows.length === 0 && signature === undefined) return;
  const file = readIndex();
  const byId = new Map(file.items.map((row) => [row.id, row]));
  for (const { item, contentHash, embedding, updatedAt } of rows) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      id: item.id,
      name: item.name,
      description: item.description || "",
      when_to_use: item.when_to_use || "",
      categories: item.categories || [],
      aliases: item.aliases || [],
      body: item.body || "",
      path: item.path || "",
      enabled: existing ? existing.enabled : true,
      content_hash: contentHash,
      updated_at: updatedAt,
      embedding: encodeVector(embedding),
    });
  }
  file.items = [...byId.values()].sort(byName);
  // Only overwrite the signature when vectors were actually produced, so a
  // failed embedding run retries instead of marking stale vectors as current.
  if (signature !== undefined) file.embedding_signature = signature;
  writeIndex(file);
}

export function deleteItem(id: string): boolean {
  const file = readIndex();
  const remaining = file.items.filter((row) => row.id !== id);
  if (remaining.length === file.items.length) return false;
  file.items = remaining;
  writeIndex(file);
  return true;
}

export function setEnabled(id: string, enabled: boolean): boolean {
  const file = readIndex();
  const row = file.items.find((item) => item.id === id);
  if (!row) return false;
  if (row.enabled === enabled) return true;
  row.enabled = enabled;
  writeIndex(file);
  return true;
}

export function clearIndex(): void {
  const file = readIndex();
  file.items = [];
  writeIndex(file);
}
