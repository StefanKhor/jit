import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  atomicWriteFile,
  JIT_SKILLS_DIR,
  MARKETPLACE_FILE,
  MAX_SKILL_BYTES,
} from "./config.js";
import {
  deleteItem,
  deleteToolsForServer,
  indexItems,
  parseSkillText,
} from "./indexer.js";
import { logger } from "./logger.js";
import { defaultManager } from "./mcp/client.js";
import { getItem, initDb, listItems } from "./storage/db.js";
import type {
  MarketplaceInput,
  MarketplaceItem,
  MarketplaceResponse,
} from "./types.js";

const REMOTE_TTL_MS = 300_000;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const remoteCache: {
  url: string;
  at: number;
  items: MarketplaceItem[];
  error: string;
} = { url: "", at: 0, items: [], error: "" };

function normalizeItem(raw: unknown): MarketplaceItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = String(source.id || "").trim().toLowerCase();
  const kind = source.kind;
  const install = source.install;
  if (!SAFE_ID.test(id) || (kind !== "skill" && kind !== "mcp")) return null;
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    return null;
  }

  const inputs: MarketplaceInput[] = [];
  if (Array.isArray(source.inputs)) {
    for (const spec of source.inputs) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
      const input = spec as Record<string, unknown>;
      const key = String(input.key || "").trim();
      if (!key) continue;
      inputs.push({ ...input, key } as MarketplaceInput);
    }
  }

  return {
    ...(source as unknown as MarketplaceItem),
    id,
    kind,
    name: String(source.name || id).trim(),
    description: String(source.description || "").trim(),
    category: String(source.category || "Other").trim(),
    inputs,
    install: install as Record<string, unknown>,
  };
}

function loadBundled(): MarketplaceItem[] {
  if (!existsSync(MARKETPLACE_FILE)) {
    logger.warn("marketplace catalog missing: %s", MARKETPLACE_FILE);
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(MARKETPLACE_FILE, "utf8")) as unknown;
    const items =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { items?: unknown }).items
        : parsed;
    if (!Array.isArray(items)) return [];
    return items
      .map(normalizeItem)
      .filter((item): item is MarketplaceItem => item !== null);
  } catch (error) {
    logger.warn(
      "could not read marketplace catalog: %s",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

async function fetchRemote(url: string): Promise<MarketplaceItem[]> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "http:") {
    if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
      throw new Error("catalog URLs must use https://");
    }
  } else if (parsedUrl.protocol !== "https:") {
    throw new Error("catalog URLs must use https://");
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" &&
    !(
      finalUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(finalUrl.hostname)
    )
  ) {
    throw new Error("catalog redirect must use https://");
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_SKILL_BYTES) {
    throw new Error("catalog is larger than the size limit");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILL_BYTES) {
        throw new Error("catalog is larger than the size limit");
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  const items =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { items?: unknown }).items
      : parsed;
  if (!Array.isArray(items)) {
    throw new Error("catalog must contain an items array");
  }
  return items
    .map(normalizeItem)
    .filter((item): item is MarketplaceItem => item !== null);
}

export async function catalog(): Promise<{
  items: MarketplaceItem[];
  source: string;
  warning: string;
}> {
  const bundled = loadBundled();
  const url = (process.env.JIT_MARKETPLACE_URL || "").trim();
  if (!url) return { items: bundled, source: "bundled", warning: "" };

  const now = Date.now();
  let remote: MarketplaceItem[];
  let warning: string;
  if (remoteCache.url === url && now - remoteCache.at < REMOTE_TTL_MS) {
    remote = remoteCache.items;
    warning = remoteCache.error;
  } else {
    try {
      remote = await fetchRemote(url);
      warning = "";
    } catch (error) {
      remote = [];
      warning = `Remote catalog unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.warn("remote marketplace failed: %s", warning);
    }
    remoteCache.url = url;
    remoteCache.at = now;
    remoteCache.items = remote;
    remoteCache.error = warning;
  }

  if (remote.length === 0) {
    return { items: bundled, source: "bundled", warning };
  }
  const merged = new Map(bundled.map((item) => [item.id, item]));
  for (const item of remote) merged.set(item.id, item);
  return {
    items: [...merged.values()],
    source: "bundled+remote",
    warning,
  };
}

async function installedState(): Promise<{
  mcp: Set<string>;
  skills: Set<string>;
}> {
  const manager = defaultManager();
  await manager.loadConfigs();
  const mcp = new Set(Object.keys(manager.getStatus()));
  const db = initDb();
  try {
    const skills = new Set(listItems(db).map((item) => item.id));
    return { mcp, skills };
  } finally {
    db.close();
  }
}

export async function annotatedCatalog(): Promise<MarketplaceResponse> {
  const { items, source, warning } = await catalog();
  const { mcp, skills } = await installedState();
  for (const item of items) {
    if (item.kind === "mcp") {
      item.installed = mcp.has(item.id);
    } else {
      const file = path.join(JIT_SKILLS_DIR, item.id, "SKILL.md");
      item.installed = existsSync(file) && skills.has(item.id);
    }
  }
  return { items, source, warning };
}

async function find(itemId: string): Promise<MarketplaceItem | null> {
  const { items } = await catalog();
  return items.find((item) => item.id === itemId) || null;
}

function inputValues(
  item: MarketplaceItem,
  inputs: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const spec of item.inputs || []) {
    const raw = inputs[spec.key] ?? spec.default ?? "";
    let value = String(raw).trim();
    if (spec.required && !value) {
      throw new Error(`${spec.label || spec.key} is required`);
    }
    if (spec.type === "path" && value) {
      value = path.resolve(value.replace(/^~(?=$|\/)/, homedir()));
    }
    values[spec.key] = value;
  }
  return values;
}

function substitute(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [key, replacement] of Object.entries(values)) {
      result = result.split(`{{${key}}}`).join(replacement);
    }
    if (result.includes("{{")) {
      throw new Error("catalog definition has an unresolved input");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        substitute(entry, values),
      ]),
    );
  }
  return value;
}

async function fetchSkill(url: string, expectedSha = ""): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
      throw new Error("skill URLs must use https://");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("skill URLs must use https://");
  }

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" &&
    !(
      finalUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(finalUrl.hostname)
    )
  ) {
    throw new Error("skill redirect must use https://");
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_SKILL_BYTES) {
    throw new Error("skill is larger than the size limit");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILL_BYTES) {
        throw new Error("skill is larger than the size limit");
      }
      chunks.push(value);
    }
  }
  const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (expectedSha) {
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest.toLowerCase() !== expectedSha.trim().toLowerCase()) {
      throw new Error("skill checksum does not match the catalog");
    }
  }
  return data.toString("utf8");
}

function existingSkill(itemId: string) {
  const db = initDb();
  try {
    return getItem(db, itemId);
  } finally {
    db.close();
  }
}

async function installMcp(
  item: MarketplaceItem,
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const config = substitute(item.install, values);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("invalid MCP definition");
  }
  const manager = defaultManager();
  if (!manager.addServer(item.id, config)) {
    throw new Error("the MCP definition is invalid");
  }
  const connected = await manager.connect(item.id);
  const result: Record<string, unknown> = {
    ok: true,
    id: item.id,
    kind: "mcp",
    installed: true,
    connected,
  };
  if (!connected) {
    result.error =
      manager.getStatus()[item.id]?.error || "connection failed";
    return result;
  }
  const manifests = manager.indexTools(item.id);
  if (manifests.length === 0) {
    deleteToolsForServer(item.id);
    return { ...result, added: 0, updated: 0, skipped: 0, errors: [] };
  }
  deleteToolsForServer(item.id);
  const indexed = await indexItems(manifests, "tool");
  return { ...result, ...indexed };
}

async function installSkill(
  item: MarketplaceItem,
  _values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const spec = item.install;
  let body = spec.body;
  if (body === undefined || body === null) {
    const url = String(spec.url || "").trim();
    if (!url) throw new Error("skill definition needs a body or a URL");
    body = await fetchSkill(url, String(spec.sha256 || ""));
  }
  if (typeof body !== "string") throw new Error("skill body must be text");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill is larger than the size limit");
  }

  const destination = path.join(JIT_SKILLS_DIR, item.id, "SKILL.md");
  const existing = existingSkill(item.id);
  if (
    existing &&
    path.resolve(existing.path || "") !== path.resolve(destination)
  ) {
    throw new Error(
      `a skill named '${item.id}' is already indexed from ${existing.path}`,
    );
  }

  // Validate before touching an existing JIT-owned copy. A malformed catalog
  // entry must not destroy the currently installed version.
  const parsed = parseSkillText(body, destination);
  if (parsed.id !== item.id) {
    throw new Error("skill frontmatter name must match the catalog id");
  }
  parsed.name = item.name;
  if (parsed.categories.length === 0 && item.category) {
    parsed.categories = [item.category];
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  atomicWriteFile(destination, body, 0o644);
  const indexed = await indexItems([parsed], "skill");
  return {
    ok: true,
    id: item.id,
    kind: "skill",
    installed: true,
    connected: true,
    ...indexed,
  };
}

export async function install(
  itemId: string,
  inputs: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const item = await find(itemId);
  if (!item) throw new Error("not found in the marketplace");
  const values = inputValues(item, inputs);
  if (item.kind === "mcp") return installMcp(item, values);
  return installSkill(item, values);
}

export async function uninstall(
  itemId: string,
): Promise<Record<string, unknown>> {
  const item = await find(itemId);
  if (!item) throw new Error("not found in the marketplace");

  if (item.kind === "mcp") {
    const manager = defaultManager();
    const removed = manager.removeServer(itemId);
    const toolsRemoved = deleteToolsForServer(itemId);
    return {
      ok: true,
      id: itemId,
      removed,
      tools_removed: toolsRemoved,
    };
  }

  const destination = path.join(JIT_SKILLS_DIR, itemId, "SKILL.md");
  const existing = existingSkill(itemId);
  if (
    existing &&
    path.resolve(existing.path || "") !== path.resolve(destination)
  ) {
    throw new Error(
      `'${itemId}' was imported from ${existing.path}; remove it from Skills instead`,
    );
  }

  const fileRemoved = existsSync(destination);
  if (fileRemoved) {
    unlinkSync(destination);
    try {
      rmdirSync(path.dirname(destination));
    } catch {
      // Directory is not empty; leave it.
    }
  }
  const indexRemoved = deleteItem(itemId);
  return {
    ok: true,
    id: itemId,
    removed: indexRemoved || fileRemoved,
    file_removed: fileRemoved,
  };
}

export function parseMarketplaceSkill(text: string): string {
  return parseSkillText(text).id;
}
