import { existsSync, readFileSync, statSync } from "node:fs";

import {
  atomicWriteFile,
  embeddingSignature,
  INDEX_FILE,
} from "../config.js";
import { readSkillBody } from "../skill-text.js";
import type {
  IndexItem,
  ListItem,
  Stats,
  StoredItem,
} from "../types.js";

/**
 * The index is one plain file, not a database. `index.json` holds every skill's
 * metadata, its content hash, and its embedding as base64, plus the embedding
 * signature. It is the single source of truth and is always replaced atomically,
 * so a reader sees either the whole previous file or the whole next one.
 *
 * It does not hold the body. A skill is a directory on disk and its `SKILL.md`
 * stays the source of the text, so a lookup reads the body from there rather
 * than serving a copy that drifts the moment someone edits the file. The one
 * exception is an entry with no path to read — see `upsertItems`.
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
  /** Only kept for an entry with no path to read the body from. */
  body: string;
  /** Body tokens, measured at index time so no read is needed to report them. */
  tokens: number;
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
  const body = String(row.body ?? "");
  return {
    id,
    name: String(row.name ?? id),
    description: String(row.description ?? ""),
    body,
    // An index written before bodies moved out of the file carries no token
    // count, so measure the body it still has.
    tokens:
      typeof row.tokens === "number" ? row.tokens : estimateTokens(body),
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
    .filter((row): row is Row => row !== null)
    // Drop the body of anything with a file to read it from. An index written
    // before bodies moved out of the file still carries a copy, and the copy is
    // dead weight the moment the skill is edited. Stripping it here means the
    // file converges on the next write of any kind, not only on a reindex.
    .map((row) => (row.path ? { ...row, body: "" } : row));
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

/**
 * A row as written out. `body` is absent, not empty, for an entry that has a
 * file to read: an empty string is still a key on every one of a hundred rows,
 * saying only that there is nothing there.
 */
function serializeRow(row: Row): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    description: row.description,
  };
  if (row.body) json.body = row.body;
  json.tokens = row.tokens;
  json.path = row.path;
  json.enabled = row.enabled;
  json.content_hash = row.content_hash;
  json.updated_at = row.updated_at;
  json.embedding = row.embedding;
  return json;
}

function writeIndex(file: IndexFile): void {
  file.version = INDEX_VERSION;
  file.revision += 1;
  const payload = { ...file, items: file.items.map(serializeRow) };
  atomicWriteFile(INDEX_FILE, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  writeSeq += 1;
  cache = { token: currentToken(), file };
}

function rowToItem(row: Row, includeBody = true): StoredItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // The body is read from the skill file, not from the index. An entry with
    // no path has nothing to read, so it falls back to the copy the index kept.
    body: includeBody ? (row.path ? readSkillBody(row.path) : row.body) : "",
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
    path: row.path,
    enabled: row.enabled,
    tokens: row.tokens,
    catalog_tokens: catalogTokens(row),
    has_embedding: embeddingsCurrent && row.embedding !== null,
  }));
}

export function getStats(): Stats {
  const file = readIndex();
  const embeddingsCurrent =
    file.embedding_signature === embeddingSignature();
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
    const tokens = row.tokens;
    bodyTokens += tokens;
    catalog += catalogTokens(row);
    if (tokens > largest) largest = tokens;
    if (row.embedding !== null) embedded += 1;
    heaviest.push({ name: row.name, tokens });
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
      // The body is read back from the skill file at lookup time. An entry with
      // no path has no file to read, so it is the one case that keeps a copy.
      body: item.path ? "" : item.body || "",
      tokens: estimateTokens(item.body || ""),
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
