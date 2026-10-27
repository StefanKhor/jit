import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SKILL_PATHS,
  DASHBOARD_HTML,
  JIT_SKILLS_DIR,
  MAX_REQUEST_BYTES,
  VERSION,
} from "../config.js";
import {
  loadConfig,
  publicConfig,
  saveConfig,
} from "../config.js";
import {
  clearIndex,
  deleteItem,
  discoverSkills,
  getItem,
  getStats,
  indexItems,
  listItems,
  setEnabled,
  tokenEstimate,
} from "../indexer.js";
import { getAllItems } from "../storage/store.js";
import { logger } from "../logger.js";
import { isLocalEndpoint } from "../net.js";
import {
  defaultManager,
  MCPClientManager,
  shutdown as shutdownMcp,
} from "../mcp/client.js";
import { jitSchemaTokens } from "../mcp-server.js";
import { cloneRepo } from "../repo.js";
import { evaluate } from "../retrieval/retriever.js";
import {
  discoverTransferable,
  exportSkills,
  indexSkillsInPlace,
  removeSkillCopy,
  transferSkills,
} from "../transfer.js";
import type { Config, IndexItem } from "../types.js";

const START_TIME = Date.now();

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * How skills split between the user's own folders and JIT's store. Both numbers
 * come from the same scan the indexer uses, so they describe what is actually
 * on disk; a skill present in both places is counted in both.
 */
function countSources(jitRoot: string): { local: number; jit: number } {
  let local = 0;
  let jit = 0;
  for (const file of discoverSkills()) {
    if (inside(jitRoot, path.resolve(file))) jit += 1;
    else local += 1;
  }
  return { local, jit };
}

function isSecureApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLocalEndpoint(value);
  } catch {
    return false;
  }
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const length = Number(c.req.header("content-length") || 0);
  if (length > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "request body too large");
  }

  const stream = c.req.raw.body;
  if (!stream) throw new HttpError(400, "invalid JSON");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// The smallest index size at which a JIT call costs less than the alternative:
// keeping a catalog of every entry's name and description in context. Both
// approaches pull in one entry body when a skill is used, so the body cancels
// and the comparison is really JIT's fixed tool schema against the catalog.
// They meet where schema == size * catalog, so the first size that wins is one
// past that crossing. Sizes below the result favour the catalog.
export function breakEvenSize(
  schemaTokens: number,
  averageCatalog: number,
): number {
  if (averageCatalog <= 0) return 0;
  return Math.floor(schemaTokens / averageCatalog) + 1;
}

let dashboardCache: string | null = null;

function dashboardHtml(): string {
  if (dashboardCache !== null) return dashboardCache;
  if (!existsSync(DASHBOARD_HTML)) {
    return "<h1>Dashboard asset missing. Run <code>bun run build</code>.</h1>";
  }
  dashboardCache = readFileSync(DASHBOARD_HTML, "utf8");
  return dashboardCache;
}

function setSecurityHeaders(c: Context): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
}

const MAX_EMBEDDING_DIM = 16384;

// Addresses that only ever reach the dashboard from the machine itself. Used
// both for the bind guard in startDashboard and for the keyless Host check.
const LOOPBACK_ADDRS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const EMBEDDING_UPDATE_KEYS = [
  "embedding_local_model",
  "embedding_api_key",
  "embedding_api_base",
  "embedding_api_model",
] as const;

const RERANK_UPDATE_KEYS = [
  "rerank_api_key",
  "rerank_api_base",
  "rerank_model",
] as const;

/**
 * Validate and normalise a dashboard config payload. Rules that span more than
 * one field — a remote embedding endpoint needs a key, a local provider needs a
 * model — live here so the route stays a two-liner and the rules can be read in
 * one place.
 */
function buildConfigUpdates(body: Record<string, unknown>): Partial<Config> {
  const updates: Record<string, unknown> = {};

  for (const key of EMBEDDING_UPDATE_KEYS) {
    if (key in body) updates[key] = String(body[key] || "").trim();
  }
  if ("embedding_api_base" in updates) {
    updates.embedding_api_base = String(updates.embedding_api_base).replace(/\/+$/, "");
  }
  if ("embedding_provider" in body) {
    if (!["local", "openai-compatible"].includes(String(body.embedding_provider))) {
      throw new HttpError(400, "embedding_provider must be local or openai-compatible");
    }
    updates.embedding_provider = body.embedding_provider;
  }
  for (const key of ["embedding_local_dim", "embedding_api_dim"] as const) {
    if (!(key in body)) continue;
    const dimension = Number(body[key]);
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_EMBEDDING_DIM) {
      throw new HttpError(400, `${key} must be an integer from 1 to ${MAX_EMBEDDING_DIM}`);
    }
    updates[key] = dimension;
  }

  const touchesEmbeddings = Object.keys(updates).some((key) =>
    key.startsWith("embedding_"),
  );
  if (touchesEmbeddings) {
    const current = loadConfig();
    const provider = String(updates.embedding_provider || current.embedding_provider);
    if (provider === "local") {
      const model = String(updates.embedding_local_model ?? current.embedding_local_model);
      if (!model) throw new HttpError(400, "a local embedding model is required");
    } else {
      const base = String(updates.embedding_api_base ?? current.embedding_api_base);
      const model = String(updates.embedding_api_model ?? current.embedding_api_model);
      const key = String(updates.embedding_api_key ?? current.embedding_api_key);
      if (!base || !isSecureApiBase(base)) {
        throw new HttpError(
          400,
          "embeddings API base must use https:// (http:// is allowed only for localhost)",
        );
      }
      if (!model) throw new HttpError(400, "an embeddings model is required");
      if (!key && !isLocalEndpoint(base)) {
        throw new HttpError(400, "a remote embeddings endpoint requires an API key");
      }
    }
  }

  for (const key of RERANK_UPDATE_KEYS) {
    if (key in body) updates[key] = String(body[key] || "").trim();
  }
  const rerankBase = String(updates.rerank_api_base || "");
  if (rerankBase && !isSecureApiBase(rerankBase)) {
    throw new HttpError(
      400,
      "rerank API base must use https:// (http:// is allowed only for localhost)",
    );
  }
  if ("rerank_api_base" in updates) {
    updates.rerank_api_base = rerankBase.replace(/\/+$/, "");
  }

  if ("confidence_threshold" in body) {
    const parsed = Number(body.confidence_threshold);
    if (!Number.isFinite(parsed)) {
      throw new HttpError(400, "confidence_threshold must be a number");
    }
    updates.confidence_threshold = Math.min(1, Math.max(0, parsed));
  }
  if ("api_key" in body) updates.api_key = String(body.api_key || "").trim();
  if (boolValue(body.complete_setup, false)) updates.first_run = false;

  return updates as Partial<Config>;
}

export function createApp(): Hono {
  const app = new Hono();
  const manager = defaultManager();

  app.use("*", async (c, next) => {
    setSecurityHeaders(c);
    await next();
  });

  app.get("/", (c) => {
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return c.html(dashboardHtml());
  });

  app.get("/index.html", (c) => c.redirect("/"));

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/api/health", (c) =>
    c.json({
      status: "healthy",
      version: VERSION,
      uptime_seconds: Number(((Date.now() - START_TIME) / 1000).toFixed(1)),
      auth_required: Boolean(loadConfig().api_key),
    }),
  );

  app.use("/api/*", async (c, next) => {
    const expected = String(loadConfig().api_key || "");
    if (!expected) return next();
    const header = c.req.header("authorization") || "";
    const supplied = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7)
      : c.req.header("x-api-key") || "";
    if (!safeEqual(supplied, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // Browser hardening. With a key configured, auth already blocks cross-site
  // abuse: an attacker page cannot attach Authorization/X-Api-Key without a
  // CORS preflight this server never answers. Keyless installs are
  // loopback-bound (startDashboard refuses anything else), so for them the
  // checks below only have to hold for browsers talking to their own
  // localhost; curl and other API clients are unaffected.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    // Every cross-site form POST carries one of the "simple" content types,
    // the dashboard always sends application/json, and bodyless calls send no
    // content type at all. Rejecting the rest makes drive-by form POSTs
    // harmless without affecting non-browser clients.
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type && type !== "application/json") {
        return c.json({ error: "content-type must be application/json" }, 415);
      }
    }
    if (!loadConfig().api_key) {
      // A direct remote client can send any Host header it likes — including
      // Host: 127.0.0.1 — so the header checks below are not enough on their
      // own. Keyless requests must also arrive over a loopback socket. This is
      // what keeps the surface closed even if the key is later cleared at
      // runtime while the server stays bound beyond loopback.
      const remote = (
        c.env as { incoming?: { socket?: { remoteAddress?: string } } }
      ).incoming?.socket?.remoteAddress;
      // Node reports IPv4-mapped IPv6 peers as ::ffff:a.b.c.d.
      const peer = (remote || "").replace(/^::ffff:/i, "").toLowerCase();
      if (!peer || !["127.0.0.1", "::1"].includes(peer)) {
        return c.json({ error: "remote access requires an API key" }, 403);
      }
      // DNS rebinding arrives with an attacker-chosen Host header.
      const host = c.req.header("host") || "";
      let hostname = "";
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        // An unparseable Host is rejected by the loopback check below.
      }
      if (!LOOPBACK_ADDRS.has(hostname)) {
        return c.json({ error: "unexpected host header" }, 403);
      }
      // Browsers label cross-site requests with a foreign Origin.
      const origin = c.req.header("origin");
      if (origin) {
        try {
          if (new URL(origin).host !== host) {
            return c.json({ error: "cross-origin request rejected" }, 403);
          }
        } catch {
          return c.json({ error: "invalid origin header" }, 403);
        }
      }
    }
    return next();
  });

  app.get("/api/status", (c) => {
    const stats = getStats();
    return c.json({
      indexed: stats.total,
      enabled: stats.enabled,
    });
  });

  app.get("/api/stats", async (c) => {
    const stats = getStats();
    const schemaTokens = await jitSchemaTokens();
    // At rest a plain skill setup keeps every name and description in context;
    // JIT keeps its fixed tool schema. A task's body is fetched on demand by
    // both, so it is identical on each side and is not part of the comparison.
    const jitTokens = schemaTokens;
    const catalogTokens = stats.catalog_tokens;
    const saved = Math.max(0, catalogTokens - jitTokens);
    const averageCatalog = stats.total
      ? Math.floor(stats.catalog_tokens / stats.total)
      : 0;
    const breakEven = breakEvenSize(schemaTokens, averageCatalog);
    return c.json({
      ...stats,
      tokens: {
        jit: jitTokens,
        catalog: catalogTokens,
        average_item: stats.average_body,
        largest_item: stats.largest,
        saved,
        break_even: breakEven,
      },
    });
  });

  app.get("/api/config", (c) => c.json(publicConfig()));

  app.post("/api/config", async (c) => {
    saveConfig(buildConfigUpdates(await readJson(c)));
    return c.json({ saved: true, config: publicConfig() });
  });

  app.post("/api/embeddings/reindex", async (c) => {
    const items = getAllItems();
    return c.json(await indexItems(items));
  });

  app.get("/api/skills", (c) => {
    const items = listItems();
    const root = path.resolve(JIT_SKILLS_DIR);
    return c.json({
      skills: items.map((item) => ({
        ...item,
        managed: inside(root, path.resolve(item.path || "")),
      })),
      // Where skills live, counted from disk rather than from the index: the
      // index holds one row per id, so a skill that sits in a local folder and
      // in JIT's store has already lost one of those places by the time it is
      // read. Counting the scan instead lets both places be reported.
      sources: countSources(root),
    });
  });

  app.get("/api/skills/sources", (c) =>
    c.json({
      paths: DEFAULT_SKILL_PATHS.map((item) => ({
        path: item,
        exists: existsSync(item),
      })),
    }),
  );

  app.get("/api/skills/:id", (c) => {
    const id = c.req.param("id");
    const item = getItem(id);
    if (!item) throw new HttpError(404, "not found");
    const {
      embedding: _embedding,
      content_hash: _hash,
      updated_at: _updated,
      ...publicItem
    } = item;
    return c.json({
      ...publicItem,
      tokens: tokenEstimate(item.body),
    });
  });

  app.delete("/api/skills/:id", async (c) => {
    const id = c.req.param("id");
    const purge = ["1", "true", "yes"].includes(
      String(c.req.query("purge") || "0").toLowerCase(),
    );
    const item = getItem(id);
    if (!item) throw new HttpError(404, "not found");
    if (purge) {
      const fileRemoved = await removeSkillCopy(id);
      if (getItem(id)) {
        throw new HttpError(500, "could not remove the JIT-owned skill copy");
      }
      return c.json({ removed: id, file_removed: fileRemoved, purged: true });
    }
    const removed = deleteItem(id);
    if (!removed) throw new HttpError(404, "not found");
    return c.json({ removed: id, file_removed: false, purged: false });
  });

  app.post("/api/skills/toggle", async (c) => {
    const body = await readJson(c);
    const id = String(body.id || body.name || "").trim();
    if (!id) throw new HttpError(400, "id required");
    const enabled = boolValue(body.enabled, true);
    if (!setEnabled(id, enabled)) throw new HttpError(404, "not found");
    return c.json({ id, enabled });
  });

  // Pull a skill repo from a remote (github shorthand, https, or git@ url):
  // clone into JIT's repo cache, then hand the local path back so the transfer
  // picker treats it like any other folder. Repo content is only ever read.
  app.post("/api/skills/clone", async (c) => {
    const body = await readJson(c);
    const rawRepo = String(body.repo || "").trim();
    if (!rawRepo) throw new HttpError(400, "repo required");
    try {
      return c.json(cloneRepo(rawRepo));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, message);
    }
  });

  app.post("/api/skills/add", async (c) => {
    const body = await readJson(c);
    const rawPath = String(body.path || "").trim();
    if (!rawPath) throw new HttpError(400, "path required");
    try {
      return c.json(await indexSkillsInPlace(rawPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("path not found") ? 404 : 400, message);
    }
  });

  app.post("/api/skills/scan", async (c) => {
    return c.json(await indexSkillsInPlace());
  });

  // Discovery for the transfer picker: what a scan would find, without
  // importing. Read-only over the requested path (or the usual skill folders).
  app.post("/api/skills/discover", async (c) => {
    let body: Record<string, unknown> = {};
    // The body is optional — an absent one scans the usual folders. A present
    // but malformed or oversized one is a client bug, not an absence: surface
    // it instead of silently scanning the defaults.
    if (Number(c.req.header("content-length") || 0) > 0) {
      body = await readJson(c);
    }
    try {
      return c.json(discoverTransferable(String(body.path || "").trim()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(
        message.includes("path not found") ? 404 : 400,
        message,
      );
    }
  });

  app.post("/api/skills/transfer", async (c) => {
    const body = await readJson(c);
    const rawPath = String(body.path || "").trim();
    const copy = boolValue(body.copy, true);
    const overwrite = boolValue(body.overwrite, false);
    // Optional selection from the discovery picker; absent means transfer
    // everything the scan finds. A present-but-malformed ids must fail loud:
    // falling back to "everything" would import on a client bug.
    let only: Set<string> | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) {
        throw new HttpError(400, "ids must be a list of skill ids");
      }
      only = new Set(
        body.ids.map((value: unknown) => String(value).trim()).filter(Boolean),
      );
      if (only.size > 500) {
        throw new HttpError(413, "too many ids; split the request");
      }
    }
    try {
      return c.json(await transferSkills(rawPath, copy, overwrite, only));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(
        message.includes("path not found") ? 404 : 400,
        message,
      );
    }
  });

  app.post("/api/skills/export", async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new HttpError(400, "ids must be a non-empty list");
    }
    try {
      return c.json(
        await exportSkills(
          body.ids,
          body.destination,
          boolValue(body.overwrite, false),
        ),
      );
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  });

  // One request for a whole selection. Every id is attempted; a single bad row
  // never aborts the batch, so the client gets an exact per-item account.
  app.post("/api/skills/bulk", async (c) => {
    const body = await readJson(c);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((value: unknown) => String(value).trim()).filter(Boolean)
      : [];
    if (ids.length === 0) throw new HttpError(400, "ids must be a non-empty list");
    if (ids.length > 500) throw new HttpError(413, "too many ids; split the request");
    const action = String(body.action || "").trim();
    if (!["enable", "disable", "remove"].includes(action)) {
      throw new HttpError(400, "action must be enable, disable, or remove");
    }

    const ok: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    let filesRemoved = 0;
    for (const id of ids) {
      try {
        if (action === "remove") {
          if (!getItem(id)) throw new Error("not found");
          // Unindexes always; only deletes the file when JIT owns the copy.
          if (await removeSkillCopy(id)) filesRemoved += 1;
        } else if (!setEnabled(id, action === "enable")) {
          throw new Error("not found");
        }
        ok.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return c.json({ action, ok, failed, files_removed: filesRemoved });
  });

  app.get("/api/mcp", async (c) => {
    return c.json({ servers: await manager.statusSummary() });
  });

  app.get("/api/mcp/imports", async (c) => {
    const paths = MCPClientManager.externalConfigPaths().map((item) => ({
      path: item,
      exists: existsSync(item),
    }));
    return c.json({ paths, servers: manager.externalServers() });
  });

  app.post("/api/mcp/import", async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.servers) || body.servers.length === 0) {
      throw new HttpError(400, "servers must be a non-empty list");
    }
    if (body.servers.length > 100) throw new HttpError(413, "too many servers");
    return c.json(await manager.importServers(body.servers));
  });

  app.post("/api/mcp/add", async (c) => {
    const body = await readJson(c);
    const name = String(body.name || "").trim();
    const config = body.config;
    if (!name || !config || typeof config !== "object" || Array.isArray(config)) {
      throw new HttpError(400, "name and config are required");
    }
    if (!manager.addServer(name, config)) {
      throw new HttpError(400, "invalid server name or config");
    }
    const result: Record<string, unknown> = {
      installed: true,
      server: name,
      connected: false,
    };
    if (!(await manager.connect(name))) {
      result.error = manager.getStatus()[name]?.error || "connection failed";
      return c.json(result);
    }
    return c.json({
      ...result,
      connected: true,
      tools: manager.getTools(name).length,
    });
  });

  app.post("/api/mcp/remove", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    if (!server) throw new HttpError(400, "server required");
    const removed = manager.removeServer(server);
    return c.json({ removed });
  });

  app.post("/api/mcp/connect", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    if (!server) throw new HttpError(400, "server required");
    await manager.loadConfigs();
    if (!(await manager.connect(server))) {
      throw new HttpError(502, manager.getStatus()[server]?.error || "connection failed");
    }
    return c.json({
      connected: true,
      server,
      tools: manager.getTools(server).map((tool) => ({
        name: tool.name,
        description: tool.description || "",
      })),
    });
  });

  app.post("/api/mcp/disconnect", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    if (!server) throw new HttpError(400, "server required");
    await manager.disconnect(server);
    return c.json({ disconnected: server });
  });

  // Full tool listing for one server, schemas included — the dashboard's tool
  // runner renders arg hints from them.
  app.get("/api/mcp/tools", async (c) => {
    const server = String(c.req.query("server") || "").trim();
    if (!server) throw new HttpError(400, "server required");
    const status = manager.getStatus()[server];
    if (!status) throw new HttpError(404, "unknown server");
    if (status.status !== "connected") {
      throw new HttpError(409, "server is not connected");
    }
    return c.json({
      server,
      tools: manager.getTools(server).map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || null,
      })),
    });
  });

  // Invoke a tool on a connected MCP server. Unlike JIT_FIND these calls run
  // external code with real side effects, so the dashboard UI confirms before
  // sending, and the response is the tool's own result, verbatim.
  app.post("/api/mcp/call", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    const tool = String(body.tool || "").trim();
    if (!server || !tool) {
      throw new HttpError(400, "server and tool are required");
    }
    const args = body.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new HttpError(400, "args must be an object");
    }
    try {
      return c.json(
        await manager.callTool(server, tool, args as Record<string, unknown>),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(
        message.startsWith("unknown MCP server") || message.includes("not connected")
          ? 409
          : 502,
        message,
      );
    }
  });

  app.get("/api/search", async (c) => {
    const intent = String(c.req.query("intent") || "").trim();
    return c.json(await search(intent));
  });

  app.post("/api/search", async (c) => {
    const body = await readJson(c);
    return c.json(await search(String(body.intent || "").trim()));
  });

  app.get("/api/export", (c) => {
    const items = getAllItems().map((item) => {
      const { embedding: _embedding, content_hash: _hash, updated_at: _updated, ...rest } = item;
      return rest;
    });
    return c.json({
      version: 2,
      exported_at: Date.now() / 1000,
      items,
    });
  });

  app.post("/api/import", async (c) => {
    const body = await readJson(c);
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new HttpError(400, "items must be a non-empty list");
    }
    if (rawItems.length > 50_000) throw new HttpError(413, "too many items");
    const skills: IndexItem[] = [];
    const disabled: string[] = [];
    const errors: string[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const source = raw as Record<string, unknown>;
      const id = String(source.id || source.name || "").trim();
      if (!id) continue;
      if (source.enabled === false || source.enabled === 0 || source.enabled === "false") {
        disabled.push(id);
      }
      skills.push({
        id,
        name: String(source.name || id),
        description: String(source.description || ""),
        body: String(source.body || ""),
        path: String(source.path || ""),
      });
    }
    let added = 0;
    let updated = 0;
    let skipped = 0;
    if (skills.length > 0) {
      try {
        const result = await indexItems(skills);
        added += result.added;
        updated += result.updated;
        skipped += result.skipped;
        errors.push(...result.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const id of disabled) setEnabled(id, false);
    return c.json({ added, updated, skipped, errors });
  });

  app.post("/api/clear", (c) => {
    clearIndex();
    return c.json({ cleared: true });
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not found" }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    logger.error("request failed: %s", error);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

async function search(intent: string): Promise<Record<string, unknown>> {
  if (!intent) throw new HttpError(400, "intent required");
  if (intent.length > 2000) throw new HttpError(400, "intent too long");
  const started = performance.now();
  const evaluation = await evaluate(intent, 5);
  return {
    results: evaluation.results,
    candidates: evaluation.candidates,
    near_misses: evaluation.nearMisses,
    reranked: evaluation.reranked,
    ...(evaluation.warning ? { warning: evaluation.warning } : {}),
    ...(evaluation.rankingWarning
      ? { ranking_warning: evaluation.rankingWarning }
      : {}),
    threshold: evaluation.threshold,
    elapsed_ms: Number((performance.now() - started).toFixed(1)),
  };
}

export function startDashboard(
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
): ReturnType<typeof serve> {
  // The management API can rewrite config, purge the index, read indexed
  // files back and spawn user-defined MCP servers. Binding it beyond loopback
  // without a key hands all of that to anyone who can reach the port.
  if (!LOOPBACK_ADDRS.has(host) && !loadConfig().api_key) {
    throw new Error(
      `refusing to bind the dashboard to ${host}: no API key is configured. ` +
        "Set JIT_API_KEY (or api_key in Settings) before exposing the " +
        "management API beyond loopback.",
    );
  }
  const app = createApp();
  const server = serve(
    { fetch: app.fetch, hostname: host, port },
    (info) => {
      const shown = ["0.0.0.0", "::"].includes(host) ? "localhost" : host;
      console.log(`JIT dashboard running at http://${shown}:${info.port}`);
    },
  );
  server.on("error", (error) => {
    logger.error("dashboard server error: %s", error);
    process.exitCode = 1;
  });

  const stop = (signal: string): void => {
    logger.info("received %s, shutting down", signal);
    server.close();
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000).unref();
    });
    void Promise.race([shutdownMcp(), timeout]).finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return server;
}
