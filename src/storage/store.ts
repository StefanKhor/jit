import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

import {
  atomicWriteFile,
  embeddingSignature,
  ensureJitDir,
  INDEX_FILE,
  RETRIEVAL_LOG_FILE,
} from "../config.js";
import type {
  IndexItem,
  ListItem,
  RetrievalLogEntry,
  RetrievalStats,
  Stats,
  StoredItem,
} from "../types.js";

/**
 * The index is two plain files, not a database:
 *
 * - `index.json` holds every skill (metadata, body, content hash, and its
 *   embedding as base64) plus the embedding signature. It is the single source
 *   of truth and is always replaced atomically, so a reader sees either the
 *   whole previous file or the whole next one.
 * - `retrieval.jsonl` is append-only telemetry, one JSON object per line. It is
 *   written by both the dashboard and `jit serve`, trimmed by size, and never
 *   read on the retrieval path.
 *
 * Splitting the two is what keeps writes safe without a database: `index.json`
 * has a single writer (the dashboard), while the log is append-only and
 * best-effort. Reads of the index are cached in-process and revalidated against
 * the file's mtime/size, so a `jit serve` process notices dashboard edits
 * immediately.
 */

const INDEX_VERSION = 1;
const RETRIEVAL_LOG_LIMIT = 500;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_INTENT_CHARS = 2000;

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

export interface RetrievalRecord {
  source: string;
  intent: string;
  bestId: string;
  bestName: string;
  score: number;
  cosine: number;
  rerank: number | null;
  candidates: number;
  decision: "hit" | "miss";
  elapsedMs: number;
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

/*
 * Retrieval telemetry. Append-only, so the two processes that record lookups
 * (the dashboard and `jit serve`) never contend for a read-modify-write of the
 * index. Losing a line to a rare interleaved append is acceptable; the reader
 * skips anything it cannot parse.
 */

// A local ordering key, not a durable id: millisecond timestamp with 1000
// sub-slots per process so entries sort newest-first.
let logSeq = 0;

function nextLogId(): number {
  logSeq = (logSeq + 1) % 1000;
  return Date.now() * 1000 + logSeq;
}

export function logRetrieval(record: RetrievalRecord): void {
  const entry: RetrievalLogEntry = {
    id: nextLogId(),
    ts: new Date().toISOString(),
    source: record.source,
    intent: record.intent.slice(0, MAX_INTENT_CHARS),
    best_id: record.bestId,
    best_name: record.bestName,
    score: record.score,
    cosine: record.cosine,
    rerank: record.rerank,
    candidates: record.candidates,
    decision: record.decision,
    elapsed_ms: record.elapsedMs,
  };
  ensureJitDir();
  appendFileSync(RETRIEVAL_LOG_FILE, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  trimLog();
}

function asLogEntry(value: unknown): RetrievalLogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const decision = row.decision === "hit" ? "hit" : "miss";
  return {
    id: Number(row.id ?? 0),
    ts: String(row.ts ?? ""),
    source: String(row.source ?? ""),
    intent: String(row.intent ?? ""),
    best_id: String(row.best_id ?? ""),
    best_name: String(row.best_name ?? ""),
    score: Number(row.score ?? 0),
    cosine: Number(row.cosine ?? 0),
    rerank:
      row.rerank === null || row.rerank === undefined
        ? null
        : Number(row.rerank),
    candidates: Number(row.candidates ?? 0),
    decision,
    elapsed_ms: Number(row.elapsed_ms ?? 0),
  };
}

/** Every log entry, oldest first. Unparseable lines are skipped. */
function readLog(): RetrievalLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(RETRIEVAL_LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const entries: RetrievalLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asLogEntry(parsed);
    if (entry) entries.push(entry);
  }
  return entries;
}

function trimLog(): void {
  let size: number;
  try {
    size = statSync(RETRIEVAL_LOG_FILE).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  const kept = readLog().slice(-RETRIEVAL_LOG_LIMIT);
  atomicWriteFile(
    RETRIEVAL_LOG_FILE,
    kept.map((entry) => JSON.stringify(entry)).join("\n") +
      (kept.length ? "\n" : ""),
    0o600,
  );
}

export function listRetrievals(limit = 100): RetrievalLogEntry[] {
  const bounded = Math.max(1, Math.min(1000, limit));
  return readLog().reverse().slice(0, bounded);
}

export function retrievalStats(recentLimit = 50): RetrievalStats {
  const entries = readLog();
  const recent = [...entries].reverse().slice(0, Math.max(1, recentLimit));
  let hits = 0;
  let misses = 0;
  for (const entry of entries) {
    if (entry.decision === "hit") hits += 1;
    else misses += 1;
  }
  const grouped = new Map<string, { count: number; best_name: string }>();
  for (const entry of entries) {
    if (entry.decision !== "miss") continue;
    const key = entry.intent.trim().toLowerCase();
    if (!key) continue;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, { count: 1, best_name: entry.best_name });
  }
  const total = entries.length;
  return {
    total,
    hits,
    misses,
    miss_rate: total ? Number(((misses / total) * 100).toFixed(1)) : 0,
    threshold: 0,
    recent,
    misses_recent: recent.filter((entry) => entry.decision === "miss"),
    top_misses: [...grouped.entries()]
      .map(([intent, value]) => ({ intent, ...value }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

export function clearRetrievals(): number {
  const count = readLog().length;
  atomicWriteFile(RETRIEVAL_LOG_FILE, "", 0o600);
  return count;
}
