import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import {
  DEFAULT_HOST,
  DEFAULT_NEBIUS_API_BASE,
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
import { isGithubRef } from "../github.js";
import { isSkillsShRef, isSkillsShUrl } from "../skillsSh.js";
import {
  clearIndex,
  deleteItem,
  deleteToolsForServer,
  getItem,
  getStats,
  indexItems,
  listItems,
  setEnabled,
  tokenEstimate,
} from "../indexer.js";
import {
  clearRetrievals,
  closeDb,
  getAllItems,
  initDb,
  retrievalStats,
} from "../storage/db.js";
import { logger } from "../logger.js";
import {
  annotatedCatalog,
  inspect as inspectMarketplace,
  install as installMarketplace,
  searchMarketplace,
  topMarketplace,
  uninstall as uninstallMarketplace,
} from "../marketplace.js";
import {
  defaultManager,
  MCPClientManager,
  shutdown as shutdownMcp,
} from "../mcp/client.js";
import { jitSchemaTokens } from "../mcp-server.js";
import { evaluate, recordRetrieval } from "../retrieval/retriever.js";
import {
  exportMcp,
  exportSkills,
  indexSkillsInPlace,
  removeSkillCopy,
  transferSkills,
} from "../transfer.js";
import type { IndexItem, ItemKind } from "../types.js";

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

function isSecureApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    );
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

// The smallest index size at which one JIT call costs less than loading the
// whole index statically. A JIT call pays its fixed tool schema plus the one
// entry body it returns; loading everything pays every body and every catalog
// entry. The two meet where
//   schema + body == size * (body + catalog)
// so the first size that wins is one past that crossing. Sizes below the
// result favour loading everything, sizes at or above it favour JIT.
export function breakEvenSize(
  schemaTokens: number,
  averageBody: number,
  averageCatalog: number,
): number {
  const perEntry = averageBody + averageCatalog;
  if (perEntry <= 0) return 0;
  return Math.floor((schemaTokens + averageBody) / perEntry) + 1;
}

let dashboardCache: string | null = null;

function dashboardHtml(): string {
  if (dashboardCache !== null) return dashboardCache;
  if (!existsSync(DASHBOARD_HTML)) {
    return "<h1>Dashboard asset missing. Run <code>npm run build</code>.</h1>";
  }
  dashboardCache = readFileSync(DASHBOARD_HTML, "utf8");
  return dashboardCache;
}

function setSecurityHeaders(c: Context): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
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

  app.get("/api/status", (c) => {
    const stats = getStats(initDb());
    return c.json({
      indexed: stats.total,
      skills: stats.skills,
      tools: stats.tools,
      enabled: stats.enabled,
    });
  });

  app.get("/api/stats", async (c) => {
    const stats = getStats(initDb());
    const schemaTokens = await jitSchemaTokens();
    const staticTokens = stats.body_tokens + stats.catalog_tokens;
    const taskTokens = stats.total
      ? schemaTokens + stats.average_body
      : schemaTokens;
    const saved = Math.max(0, staticTokens - taskTokens);
    const reduction = staticTokens
      ? Number(((1 - taskTokens / staticTokens) * 100).toFixed(1))
      : 0;
    // Per-task cost is roughly startup + one average entry; static cost grows
    // with the index. Break-even is the size where those two cross.
    const averageCatalog = stats.total
      ? Math.floor(stats.catalog_tokens / stats.total)
      : 0;
    const breakEven = breakEvenSize(
      schemaTokens,
      stats.average_body,
      averageCatalog,
    );
    const retrieval = retrievalStats(initDb(), 1);
    return c.json({
      ...stats,
      tokens: {
        static: staticTokens,
        jit: taskTokens,
        startup: schemaTokens,
        average_item: stats.average_body,
        largest_item: stats.largest,
        saved,
        reduction_pct: reduction,
        break_even: breakEven,
      },
      retrieval: {
        total: retrieval.total,
        misses: retrieval.misses,
        miss_rate: retrieval.miss_rate,
      },
    });
  });

  app.get("/api/config", (c) => c.json(publicConfig()));

  app.post("/api/config", async (c) => {
    const body = await readJson(c);
    const updates: Record<string, unknown> = {};
    for (const key of [
      "nebius_api_key",
      "nebius_api_base",
      "nemotron_nano_model",
    ]) {
      if (key in body) updates[key] = String(body[key] || "").trim();
    }
    const base = String(updates.nebius_api_base || "");
    if (base && !isSecureApiBase(base)) {
      throw new HttpError(
        400,
        "API base must use https:// (http:// is allowed only for localhost)",
      );
    }
    if ("nebius_api_base" in updates) {
      updates.nebius_api_base = (base || DEFAULT_NEBIUS_API_BASE).replace(
        /\/+$/,
        "",
      );
    }
    for (const key of ["nemotron_nano_model"]) {
      if (key in updates && !updates[key]) delete updates[key];
    }
    if ("rerank_enabled" in body) {
      updates.rerank_enabled = boolValue(body.rerank_enabled, false);
    }
    if ("confidence_threshold" in body) {
      const parsed = Number(body.confidence_threshold);
      if (!Number.isFinite(parsed)) {
        throw new HttpError(400, "confidence_threshold must be a number");
      }
      updates.confidence_threshold = Math.min(1, Math.max(0, parsed));
    }
    if ("api_key" in body) updates.api_key = String(body.api_key || "").trim();
    if ("marketplace_urls" in body) {
      const raw = body.marketplace_urls;
      if (!Array.isArray(raw)) {
        throw new HttpError(400, "marketplace_urls must be an array of URLs");
      }
      const urls: string[] = [];
      for (const entry of raw) {
        const url = String(entry || "").trim();
        if (url && !urls.includes(url)) urls.push(url);
      }
      if (urls.length > 10) {
        throw new HttpError(400, "at most 10 marketplace catalogs are supported");
      }
      // Match the fetch policy in marketplace.ts so a catalog cannot be
      // configured that would only fail later at fetch time. A repository is
      // accepted as `owner/repo`, `owner/repo@ref`, or a URL, and a link to the
      // skills.sh directory resolves to the repository behind it.
      for (const url of urls) {
        if (isGithubRef(url) || isSkillsShRef(url)) continue;
        // A skills.sh link that addresses neither a repository nor a skill is a
        // mistake, not a catalog; say so instead of failing at fetch time.
        if (isSkillsShUrl(url)) {
          throw new HttpError(
            400,
            "a skills.sh link must address a repository or a skill",
          );
        }
        if (isSecureApiBase(url)) continue;
        throw new HttpError(
          400,
          "catalog entries must be https:// URLs, GitHub repositories, or skills.sh links",
        );
      }
      updates.marketplace_urls = urls;
    }
    if (boolValue(body.complete_setup, false)) updates.first_run = false;
    saveConfig(updates as Partial<import("../types.js").Config>);
    return c.json({ saved: true, config: publicConfig() });
  });

  app.get("/api/skills", (c) => {
    const items = listItems(initDb());
    const root = path.resolve(JIT_SKILLS_DIR);
    return c.json({
      skills: items
        .filter((item) => item.kind === "skill")
        .map((item) => ({
          ...item,
          managed: inside(root, path.resolve(item.path || "")),
        })),
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
    const item = getItem(initDb(), id);
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
    const item = getItem(initDb(), id);
    if (!item) throw new HttpError(404, "not found");
    if (purge) {
      const fileRemoved = await removeSkillCopy(id);
      if (getItem(initDb(), id)) {
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

  app.post("/api/skills/transfer", async (c) => {
    const body = await readJson(c);
    const rawPath = String(body.path || "").trim();
    const copy = boolValue(body.copy, true);
    const overwrite = boolValue(body.overwrite, false);
    try {
      return c.json(await transferSkills(rawPath, copy, overwrite));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
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
          if (!getItem(initDb(), id)) throw new Error("not found");
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

  app.get("/api/marketplace", async (c) => {
    return c.json(await annotatedCatalog());
  });

  // An entry discovered on skills.sh is in no configured catalog. It carries
  // the source it came from, which is what the review and install calls below
  // pass back so the CLI can resolve it.
  const sourceHint = (body: Record<string, unknown>) => ({
    source: String(body.source || "").trim(),
    skill: String(body.skill || "").trim(),
  });

  app.get("/api/marketplace/search", async (c) => {
    const query = String(c.req.query("q") || "").trim();
    try {
      return c.json(await searchMarketplace(query));
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "search failed",
      );
    }
  });

  app.get("/api/marketplace/top", async (c) => {
    const view = String(c.req.query("view") || "all-time").trim();
    const page = Number(c.req.query("page") || 1);
    try {
      return c.json(await topMarketplace(view, page));
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "leaderboard failed",
      );
    }
  });

  app.post("/api/marketplace/inspect", async (c) => {
    const body = await readJson(c);
    const id = String(body.id || "").trim().toLowerCase();
    if (!id) throw new HttpError(400, "id required");
    try {
      return c.json(await inspectMarketplace(id, sourceHint(body)));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "inspect failed");
    }
  });

  app.post("/api/marketplace/install", async (c) => {
    const body = await readJson(c);
    const id = String(body.id || "").trim().toLowerCase();
    if (!id) throw new HttpError(400, "id required");
    const inputs =
      body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};
    const acknowledge = boolValue(body.acknowledge, false);
    try {
      return c.json(
        await installMarketplace(id, inputs, {
          acknowledge,
          ...sourceHint(body),
        }),
      );
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "install failed");
    }
  });

  app.post("/api/marketplace/uninstall", async (c) => {
    const body = await readJson(c);
    const id = String(body.id || "").trim().toLowerCase();
    if (!id) throw new HttpError(400, "id required");
    try {
      return c.json(await uninstallMarketplace(id));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "uninstall failed");
    }
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

  app.get("/api/mcp/configs", (c) => {
    const paths = MCPClientManager.externalConfigPaths();
    return c.json({
      paths: paths.map((item) => ({ path: item, exists: existsSync(item) })),
    });
  });

  app.post("/api/mcp/import", async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.servers) || body.servers.length === 0) {
      throw new HttpError(400, "servers must be a non-empty list");
    }
    if (body.servers.length > 100) throw new HttpError(413, "too many servers");
    return c.json(await manager.importServers(body.servers));
  });

  app.post("/api/mcp/export", async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.servers) || body.servers.length === 0) {
      throw new HttpError(400, "servers must be a non-empty list");
    }
    try {
      return c.json(
        await exportMcp(
          body.servers,
          body.destination,
          boolValue(body.overwrite, false),
        ),
      );
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
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
    const manifests = manager.indexTools(name);
    if (manifests.length === 0) {
      deleteToolsForServer(name);
      return c.json({
        ...result,
        connected: true,
        added: 0,
        updated: 0,
        skipped: 0,
        errors: [],
      });
    }
    deleteToolsForServer(name);
    const indexed = await indexItems(manifests, "tool");
    return c.json({ ...result, connected: true, ...indexed });
  });

  app.post("/api/mcp/remove", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    if (!server) throw new HttpError(400, "server required");
    const removed = manager.removeServer(server);
    const toolsRemoved = deleteToolsForServer(server);
    return c.json({ removed, tools_removed: toolsRemoved });
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

  app.post("/api/mcp/index", async (c) => {
    const body = await readJson(c);
    const server = String(body.server || "").trim();
    if (!server) throw new HttpError(400, "server required");
    await manager.loadConfigs();
    if (!(await manager.connect(server))) {
      throw new HttpError(502, manager.getStatus()[server]?.error || "connection failed");
    }
    const manifests = manager.indexTools(server);
    if (manifests.length === 0) {
      deleteToolsForServer(server);
      throw new HttpError(400, "server exposes no tools");
    }
    deleteToolsForServer(server);
    return c.json(await indexItems(manifests, "tool"));
  });

  // Batch the MCP verbs the same way as skills: best-effort per server, with a
  // full account of what changed and what did not.
  app.post("/api/mcp/bulk", async (c) => {
    const body = await readJson(c);
    const servers = Array.isArray(body.servers)
      ? body.servers.map((value: unknown) => String(value).trim()).filter(Boolean)
      : [];
    if (servers.length === 0) throw new HttpError(400, "servers must be a non-empty list");
    if (servers.length > 100) throw new HttpError(413, "too many servers");
    const action = String(body.action || "").trim();
    if (!["connect", "disconnect", "index", "remove"].includes(action)) {
      throw new HttpError(400, "action must be connect, disconnect, index, or remove");
    }

    const ok: string[] = [];
    const failed: Array<{ server: string; error: string }> = [];
    const tools: Record<string, number> = {};
    if (action === "connect" || action === "index") await manager.loadConfigs();

    for (const server of servers) {
      try {
        if (action === "remove") {
          manager.removeServer(server);
          tools[server] = deleteToolsForServer(server);
        } else if (action === "disconnect") {
          await manager.disconnect(server);
        } else {
          if (!(await manager.connect(server))) {
            throw new Error(manager.getStatus()[server]?.error || "connection failed");
          }
          if (action === "index") {
            const manifests = manager.indexTools(server);
            deleteToolsForServer(server);
            if (manifests.length === 0) throw new Error("server exposes no tools");
            tools[server] = (await indexItems(manifests, "tool")).added;
          } else {
            tools[server] = manager.getTools(server).length;
          }
        }
        ok.push(server);
      } catch (error) {
        failed.push({
          server,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return c.json({ action, ok, failed, tools });
  });

  app.get("/api/search", async (c) => {
    const intent = String(c.req.query("intent") || "").trim();
    return c.json(await search(intent));
  });

  app.post("/api/search", async (c) => {
    const body = await readJson(c);
    return c.json(await search(String(body.intent || "").trim()));
  });

  app.get("/api/retrieval", (c) => {
    const raw = Number(c.req.query("limit") || 100);
    const limit = Number.isFinite(raw) ? raw : 100;
    const stats = retrievalStats(initDb(), limit);
    stats.threshold = loadConfig().confidence_threshold;
    return c.json(stats);
  });

  app.post("/api/retrieval/clear", (c) => {
    return c.json({ cleared: clearRetrievals(initDb()) });
  });

  app.get("/api/export", (c) => {
    const items = getAllItems(initDb()).map((item) => {
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
    const tools: IndexItem[] = [];
    const disabled: string[] = [];
    const errors: string[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const source = raw as Record<string, unknown>;
      const id = String(source.id || source.name || "").trim();
      if (!id) continue;
      const kind: ItemKind = source.kind === "tool" ? "tool" : "skill";
      if (source.enabled === false || source.enabled === 0 || source.enabled === "false") {
        disabled.push(id);
      }
      const item: IndexItem = {
        id,
        name: String(source.name || id),
        description: String(source.description || ""),
        when_to_use: String(source.when_to_use || source.description || ""),
        categories: Array.isArray(source.categories)
          ? source.categories.map(String)
          : [],
        aliases: Array.isArray(source.aliases) ? source.aliases.map(String) : [],
        body: String(source.body || ""),
        path: String(source.path || ""),
        kind,
      };
      if (kind === "tool") {
        item.server = String(source.server || id.split("__", 1)[0] || "");
        item.params = Array.isArray(source.params)
          ? source.params.map(String)
          : [];
        item.required = Array.isArray(source.required)
          ? source.required.map(String)
          : [];
        item.schema =
          source.schema && typeof source.schema === "object"
            ? (source.schema as Record<string, unknown>)
            : undefined;
        tools.push(item);
      } else {
        skills.push(item);
      }
    }
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const [group, kind] of [
      [skills, "skill"],
      [tools, "tool"],
    ] as const) {
      if (group.length === 0) continue;
      try {
        const result = await indexItems(group, kind);
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
  recordRetrieval(evaluation, intent, "dashboard", performance.now() - started);
  return {
    result: evaluation.result,
    candidates: evaluation.candidates,
    near_misses: evaluation.nearMisses,
    reranked: evaluation.reranked,
    keyword_only: evaluation.keywordOnly,
    threshold: evaluation.threshold,
    elapsed_ms: Number((performance.now() - started).toFixed(1)),
  };
}

export function startDashboard(
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
): ReturnType<typeof serve> {
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
      closeDb();
      process.exit(0);
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return server;
}
