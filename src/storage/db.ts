import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { INDEX_DIR, META_DB } from "../config.js";
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
    schema        TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
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
};

export function openDb(): DatabaseSync {
  mkdirSync(path.dirname(META_DB), { recursive: true });
  const db = new DatabaseSync(META_DB);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=30000");
  return db;
}

export function initDb(): DatabaseSync {
  const db = openDb();
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
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
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
  };
  return item;
}

export function dataVersion(db: DatabaseSync): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(enabled), 0) AS enabled,
              COALESCE(MAX(updated_at), '') AS updated,
              COALESCE(MAX(content_hash), '') AS digest
         FROM skills`,
    )
    .get() as Row;
  return `${Number(row.n || 0)}:${Number(row.enabled || 0)}:${String(
    row.updated || "",
  )}:${String(row.digest || "")}`;
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
  const rows = db
    .prepare(
      `SELECT id, name, description, categories, path, aliases, kind, enabled,
              (length(COALESCE(body, '')) + 3) / 4 AS tokens
         FROM skills
        ORDER BY kind, name`,
    )
    .all() as Row[];
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
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = 'skill'), 0) AS skills,
              COALESCE(SUM(kind = 'tool'), 0) AS tools,
              COALESCE(SUM(enabled = 1), 0) AS enabled,
              COALESCE(SUM(enabled = 0), 0) AS disabled,
              COALESCE(SUM((length(COALESCE(body, '')) + 3) / 4), 0) AS body_tokens,
              COALESCE(SUM((length(COALESCE(name, '')) + 3) / 4
                         + (length(COALESCE(description, '')) + 3) / 4 + 12), 0) AS catalog_tokens,
              COALESCE(MAX((length(COALESCE(body, '')) + 3) / 4), 0) AS largest
         FROM skills`,
    )
    .get() as Row;

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
        server, params, required, schema)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
}

export function deleteItem(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function deleteToolsForServer(db: DatabaseSync, server: string): number {
  const prefix = `${server}__`;
  const result = db
    .prepare(
      "DELETE FROM skills WHERE kind = 'tool' " +
        "AND (server = ? OR (server IS NULL AND substr(id, 1, ?) = ?))",
    )
    .run(server, prefix.length, prefix);
  return Number(result.changes);
}

export function setEnabled(
  db: DatabaseSync,
  id: string,
  enabled: boolean,
): boolean {
  const result = db
    .prepare("UPDATE skills SET enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, id);
  return Number(result.changes) > 0;
}

export function clearIndex(): void {
  const db = initDb();
  try {
    db.exec("DELETE FROM skills");
  } finally {
    db.close();
  }
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
