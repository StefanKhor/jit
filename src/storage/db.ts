import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  embeddingSignature,
  EMBEDDING_SIGNATURE_KEY,
  getEmbeddingSettings,
  INDEX_DIR,
  META_DB,
} from "../config.js";
import type {
  Counts,
  IndexItem,
  ItemKind,
  ListItem,
  Stats,
  StoredItem,
} from "../types.js";

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    when_to_use   TEXT,
    categories    TEXT,
    body          TEXT,
    path          TEXT,
    aliases       TEXT,
    embedding     BLOB,
    kind          TEXT DEFAULT 'skill',
    enabled       INTEGER DEFAULT 1,
    content_hash  TEXT,
    updated_at    TEXT,
    server        TEXT,
    params        TEXT,
    required      TEXT,
    schema        TEXT,
    source        TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS retrieval_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    source       TEXT,
    intent       TEXT,
    best_id      TEXT,
    best_name    TEXT,
    score        REAL,
    cosine       REAL,
    rerank       REAL,
    lexical      REAL,
    candidates   INTEGER,
    decision     TEXT,
    keyword_only INTEGER,
    elapsed_ms   REAL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_id ON retrieval_log(id DESC);
`;

const MIGRATIONS: Record<string, string> = {
  kind: "TEXT DEFAULT 'skill'",
  enabled: "INTEGER DEFAULT 1",
  embedding: "BLOB",
  content_hash: "TEXT",
  updated_at: "TEXT",
  server: "TEXT",
  params: "TEXT",
  required: "TEXT",
  schema: "TEXT",
  source: "TEXT",
};

export function openDb(): DatabaseSync {
  mkdirSync(path.dirname(META_DB), { recursive: true });
  const db = new DatabaseSync(META_DB);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=30000");
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(skills)").all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  for (const [column, ddl] of Object.entries(MIGRATIONS)) {
    if (!columns.has(column)) {
      try {
        db.exec(`ALTER TABLE skills ADD COLUMN ${column} ${ddl}`);
      } catch {
        // A concurrent process may have added it already.
      }
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_skills_kind ON skills(kind)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_skills_server ON skills(server)");
}

// One connection per process. Migrations are idempotent but run once instead of
// on every call. `node:sqlite` is synchronous, so a shared handle is safe while
// the dashboard serves concurrent async requests: no statement ever interleaves
// with another, and transactions contain no await points.
let shared: DatabaseSync | null = null;

export function initDb(): DatabaseSync {
  if (shared) return shared;
  const db = openDb();
  try {
    migrate(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best effort.
    }
    throw error;
  }
  shared = db;
  return shared;
}

export function closeDb(): void {
  if (!shared) return;
  try {
    shared.close();
  } catch {
    // Best effort.
  }
  shared = null;
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | Row
    | undefined;
  return row && row.value !== undefined && row.value !== null
    ? String(row.value)
    : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// A monotonic change counter shared through SQLite so a separate `jit serve`
// process observes dashboard edits. Every mutation bumps it; retrieval caches
// key off it.
export function bumpChangeSeq(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('change_seq', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run();
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    bumpChangeSeq(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function embeddingFromBlob(value: unknown): Float32Array | null {
  if (value instanceof Uint8Array) {
    if (value.byteLength % 4 !== 0) return null;
    return new Float32Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer) {
    return new Float32Array(value);
  }
  return null;
}

export function rowToItem(row: Row, includeBody = true): StoredItem {
  const kind = (row.kind === "tool" ? "tool" : "skill") as ItemKind;
  const id = String(row.id);
  const item: StoredItem = {
    id,
    name: String(row.name || id),
    description: String(row.description || ""),
    when_to_use: String(row.when_to_use || ""),
    categories: parseJsonArray(row.categories),
    aliases: parseJsonArray(row.aliases),
    body: includeBody ? String(row.body || "") : "",
    path: String(row.path || ""),
    kind,
    enabled: row.enabled === 0 ? false : true,
    content_hash: String(row.content_hash || ""),
    updated_at: String(row.updated_at || ""),
    embedding: embeddingFromBlob(row.embedding),
    server: row.server ? String(row.server) : undefined,
    params: parseJsonArray(row.params),
    required: parseJsonArray(row.required),
    schema: parseJsonObject(row.schema),
    source: row.source ? String(row.source) : undefined,
  };
  return item;
}

export function dataVersion(db: DatabaseSync): string {
  const row = db
    .prepare(
      `SELECT (SELECT value FROM meta WHERE key = 'change_seq') AS seq,
              (SELECT COUNT(*) FROM skills) AS n`,
    )
    .get() as Row;
  return `${String(row.seq ?? 0)}:${Number(row.n || 0)}`;
}

export function getAllItems(
  db: DatabaseSync,
  includeBody = true,
): StoredItem[] {
  const rows = db.prepare("SELECT * FROM skills ORDER BY kind, name").all() as Row[];
  return rows.map((row) => rowToItem(row, includeBody));
}

export function getItem(db: DatabaseSync, id: string): StoredItem | null {
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as
    | Row
    | undefined;
  return row ? rowToItem(row) : null;
}

export function getExisting(
  db: DatabaseSync,
): Map<string, { content_hash: string; embedding: Float32Array | null }> {
  const rows = db
    .prepare("SELECT id, content_hash, embedding FROM skills")
    .all() as Row[];
  return new Map(
    rows.map((row) => [
      String(row.id),
      {
        content_hash: String(row.content_hash || ""),
        embedding: embeddingFromBlob(row.embedding),
      },
    ]),
  );
}

export function listItems(db: DatabaseSync): ListItem[] {
  const dimensionBytes = getEmbeddingSettings().dimensions * 4;
  const embeddingsCurrent = getMeta(db, EMBEDDING_SIGNATURE_KEY) === embeddingSignature();
  const rows = db
    .prepare(
      `SELECT id, name, description, categories, path, aliases, kind, enabled,
              CASE WHEN length(embedding) = ? THEN 1 ELSE 0 END AS has_embedding,
              (length(COALESCE(body, '')) + 3) / 4 AS tokens,
              (length(COALESCE(name, '')) + 3) / 4
                + (length(COALESCE(description, '')) + 3) / 4 + 12 AS catalog_tokens
         FROM skills
        ORDER BY kind, name`,
    )
    .all(dimensionBytes) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name || row.id),
    description: String(row.description || ""),
    categories: parseJsonArray(row.categories),
    path: String(row.path || ""),
    aliases: parseJsonArray(row.aliases),
    kind: (row.kind === "tool" ? "tool" : "skill") as ItemKind,
    enabled: row.enabled !== 0,
    tokens: Number(row.tokens || 0),
    catalog_tokens: Number(row.catalog_tokens || 0),
    has_embedding: embeddingsCurrent && row.has_embedding === 1,
  }));
}

export function countItems(db: DatabaseSync): Counts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind = 'skill' THEN 1 ELSE 0 END) AS skills,
              SUM(CASE WHEN kind = 'tool' THEN 1 ELSE 0 END) AS tools
         FROM skills`,
    )
    .get() as Row;
  return {
    total: Number(row.total || 0),
    skills: Number(row.skills || 0),
    tools: Number(row.tools || 0),
  };
}

export function getStats(db: DatabaseSync): Stats {
  const dimensionBytes = getEmbeddingSettings().dimensions * 4;
  const embeddingsCurrent = getMeta(db, EMBEDDING_SIGNATURE_KEY) === embeddingSignature();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = 'skill'), 0) AS skills,
              COALESCE(SUM(kind = 'tool'), 0) AS tools,
              COALESCE(SUM(CASE WHEN kind = 'skill' AND length(embedding) = ? THEN 1 ELSE 0 END), 0) AS skills_embedded,
              COALESCE(SUM(CASE WHEN kind = 'tool' AND length(embedding) = ? THEN 1 ELSE 0 END), 0) AS tools_embedded,
              COALESCE(SUM(enabled = 1), 0) AS enabled,
              COALESCE(SUM(enabled = 0), 0) AS disabled,
              COALESCE(SUM((length(COALESCE(body, '')) + 3) / 4), 0) AS body_tokens,
              COALESCE(SUM((length(COALESCE(name, '')) + 3) / 4
                         + (length(COALESCE(description, '')) + 3) / 4 + 12), 0) AS catalog_tokens,
              COALESCE(MAX((length(COALESCE(body, '')) + 3) / 4), 0) AS largest
         FROM skills`,
    )
    .get(dimensionBytes, dimensionBytes) as Row;

  const heaviestRows = db
    .prepare(
      `SELECT name, kind, (length(COALESCE(body, '')) + 3) / 4 AS tokens
         FROM skills ORDER BY tokens DESC LIMIT 6`,
    )
    .all() as Row[];

  const categoryCounts = new Map<string, number>();
  const categoryRows = db.prepare("SELECT categories FROM skills").all() as Row[];
  for (const categoryRow of categoryRows) {
    for (const name of parseJsonArray(categoryRow.categories)) {
      categoryCounts.set(name, (categoryCounts.get(name) || 0) + 1);
    }
  }

  const total = Number(row.total || 0);
  const bodyTokens = Number(row.body_tokens || 0);
  return {
    total,
    skills: Number(row.skills || 0),
    tools: Number(row.tools || 0),
    enabled: Number(row.enabled || 0),
    disabled: Number(row.disabled || 0),
    body_tokens: bodyTokens,
    catalog_tokens: Number(row.catalog_tokens || 0),
    average_body: total ? Math.floor(bodyTokens / total) : 0,
    largest: Number(row.largest || 0),
    heaviest: heaviestRows.map((item) => ({
      name: String(item.name || ""),
      kind: (item.kind === "tool" ? "tool" : "skill") as ItemKind,
      tokens: Number(item.tokens || 0),
    })),
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count })),
    embedding_coverage: {
      skills_total: Number(row.skills || 0),
      skills_embedded: embeddingsCurrent ? Number(row.skills_embedded || 0) : 0,
      tools_total: Number(row.tools || 0),
      tools_embedded: embeddingsCurrent ? Number(row.tools_embedded || 0) : 0,
    },
  };
}

export interface UpsertRow {
  item: IndexItem;
  contentHash: string;
  embedding: Float32Array | null;
  updatedAt: string;
}

export function upsertItem(db: DatabaseSync, row: UpsertRow): void {
  const { item, contentHash, embedding, updatedAt } = row;
  db.prepare(
    `INSERT INTO skills
       (id, name, description, when_to_use, categories, body, path,
        aliases, embedding, kind, enabled, content_hash, updated_at,
        server, params, required, schema, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       description=excluded.description,
       when_to_use=excluded.when_to_use,
       categories=excluded.categories,
       body=excluded.body,
       path=excluded.path,
       aliases=excluded.aliases,
       embedding=excluded.embedding,
       kind=excluded.kind,
       content_hash=excluded.content_hash,
       updated_at=excluded.updated_at,
       server=excluded.server,
       params=excluded.params,
       required=excluded.required,
       schema=excluded.schema`,
  ).run(
    item.id,
    item.name,
    item.description || "",
    item.when_to_use || "",
    JSON.stringify(item.categories || []),
    item.body || "",
    item.path || "",
    JSON.stringify(item.aliases || []),
    embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null,
    item.kind,
    1,
    contentHash,
    updatedAt,
    item.server || null,
    JSON.stringify(item.params || []),
    JSON.stringify(item.required || []),
    item.schema ? JSON.stringify(item.schema) : null,
    item.source || null,
  );
}

export function deleteItem(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  const changed = Number(result.changes) > 0;
  if (changed) bumpChangeSeq(db);
  return changed;
}

export function deleteToolsForServer(db: DatabaseSync, server: string): number {
  const prefix = `${server}__`;
  const result = db
    .prepare(
      "DELETE FROM skills WHERE kind = 'tool' " +
        "AND (server = ? OR (server IS NULL AND substr(id, 1, ?) = ?))",
    )
    .run(server, prefix.length, prefix);
  const removed = Number(result.changes);
  if (removed > 0) bumpChangeSeq(db);
  return removed;
}

export function setEnabled(
  db: DatabaseSync,
  id: string,
  enabled: boolean,
): boolean {
  const result = db
    .prepare("UPDATE skills SET enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, id);
  const changed = Number(result.changes) > 0;
  if (changed) bumpChangeSeq(db);
  return changed;
}

export function clearIndex(): void {
  const db = initDb();
  db.exec("DELETE FROM skills");
  bumpChangeSeq(db);
}

// Provenance travels with the item on insert. The upsert's conflict clause
// deliberately leaves `source` untouched so a re-index never loses it.
const RETRIEVAL_LOG_LIMIT = 500;

export interface RetrievalRecord {
  source: string;
  intent: string;
  bestId: string;
  bestName: string;
  score: number;
  cosine: number;
  rerank: number | null;
  lexical: number;
  candidates: number;
  decision: "hit" | "miss";
  keywordOnly: boolean;
  elapsedMs: number;
}

export function logRetrieval(db: DatabaseSync, record: RetrievalRecord): void {
  db.prepare(
    `INSERT INTO retrieval_log
       (ts, source, intent, best_id, best_name, score, cosine, rerank,
        lexical, candidates, decision, keyword_only, elapsed_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    record.source,
    record.intent.slice(0, 2000),
    record.bestId,
    record.bestName,
    record.score,
    record.cosine,
    record.rerank,
    record.lexical,
    record.candidates,
    record.decision,
    record.keywordOnly ? 1 : 0,
    record.elapsedMs,
  );
  // Keep the log bounded; it is telemetry, not an audit trail.
  db.prepare(
    "DELETE FROM retrieval_log WHERE id <= (SELECT MAX(id) FROM retrieval_log) - ?",
  ).run(RETRIEVAL_LOG_LIMIT);
}

function rowToRetrieval(row: Row): import("../types.js").RetrievalLogEntry {
  return {
    id: Number(row.id || 0),
    ts: String(row.ts || ""),
    source: String(row.source || ""),
    intent: String(row.intent || ""),
    best_id: String(row.best_id || ""),
    best_name: String(row.best_name || ""),
    score: Number(row.score || 0),
    cosine: Number(row.cosine || 0),
    rerank: row.rerank === null || row.rerank === undefined ? null : Number(row.rerank),
    lexical: Number(row.lexical || 0),
    candidates: Number(row.candidates || 0),
    decision: row.decision === "hit" ? "hit" : "miss",
    keyword_only: row.keyword_only === 1,
    elapsed_ms: Number(row.elapsed_ms || 0),
  };
}

export function listRetrievals(db: DatabaseSync, limit = 100): import("../types.js").RetrievalLogEntry[] {
  const rows = db
    .prepare("SELECT * FROM retrieval_log ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(1000, limit))) as Row[];
  return rows.map(rowToRetrieval);
}

export function retrievalStats(
  db: DatabaseSync,
  recentLimit = 50,
): import("../types.js").RetrievalStats {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(decision = 'hit'), 0) AS hits,
              COALESCE(SUM(decision = 'miss'), 0) AS misses,
              COALESCE(SUM(keyword_only = 1), 0) AS keyword_only
         FROM retrieval_log`,
    )
    .get() as Row;
  const total = Number(totals.total || 0);
  const hits = Number(totals.hits || 0);
  const misses = Number(totals.misses || 0);
  const recent = listRetrievals(db, recentLimit);
  const missRows = db
    .prepare(
      "SELECT * FROM retrieval_log WHERE decision = 'miss' ORDER BY id DESC LIMIT 20",
    )
    .all() as Row[];
  const grouped = new Map<string, { count: number; best_name: string }>();
  for (const row of missRows) {
    const key = String(row.intent || "").trim().toLowerCase();
    if (!key) continue;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, { count: 1, best_name: String(row.best_name || "") });
  }
  return {
    total,
    hits,
    misses,
    miss_rate: total ? Number(((misses / total) * 100).toFixed(1)) : 0,
    keyword_only: Number(totals.keyword_only || 0),
    threshold: 0,
    recent,
    misses_recent: recent.filter((entry) => entry.decision === "miss"),
    top_misses: [...grouped.entries()]
      .map(([intent, value]) => ({ intent, ...value }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

export function clearRetrievals(db: DatabaseSync): number {
  const result = db.prepare("DELETE FROM retrieval_log").run();
  return Number(result.changes);
}

export function indexedToolCounts(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare("SELECT id, server FROM skills WHERE kind = 'tool'")
    .all() as Row[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const server =
      (row.server ? String(row.server) : "") ||
      String(row.id).split("__", 1)[0] ||
      "unknown";
    counts.set(server, (counts.get(server) || 0) + 1);
  }
  return counts;
}

export function ensureIndexDir(): void {
  mkdirSync(INDEX_DIR, { recursive: true });
}
