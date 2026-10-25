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
  defaultManager,
  MCPClientManager,
  shutdown as shutdownMcp,
} from "../mcp/client.js";
import { jitSchemaTokens } from "../mcp-server.js";
import { evaluate, recordRetrieval } from "../retrieval/retriever.js";
import {
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

function isLocalEndpoint(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
      new URL(value).hostname.toLowerCase(),
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
    // At rest a plain skill setup keeps every name and description in context;
    // JIT keeps its fixed tool schema. A task's body is fetched on demand by
    // both, so it is identical on each side and is not part of the comparison.
    const jitTokens = schemaTokens;
    const catalogTokens = stats.catalog_tokens;
    const saved = Math.max(0, catalogTokens - jitTokens);
    const reduction = catalogTokens
      ? Number(((1 - jitTokens / catalogTokens) * 100).toFixed(1))
      : 0;
    const averageCatalog = stats.total
      ? Math.floor(stats.catalog_tokens / stats.total)
      : 0;
    const breakEven = breakEvenSize(schemaTokens, averageCatalog);
    const retrieval = retrievalStats(initDb(), 1);
    return c.json({
      ...stats,
      tokens: {
        jit: jitTokens,
        catalog: catalogTokens,
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
      "embedding_local_model",
      "embedding_api_key",
      "embedding_api_base",
      "embedding_api_model",
    ]) {
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
    for (const bodyKey of ["embedding_local_dim", "embedding_api_dim"] as const) {
      if (!(bodyKey in body)) continue;
      const dimension = Number(body[bodyKey]);
      if (!Number.isInteger(dimension) || dimension < 1 || dimension > 16384) {
        throw new HttpError(400, `${bodyKey} must be an integer from 1 to 16384`);
      }
      updates[bodyKey] = dimension;
    }
    const currentConfig = loadConfig();
    const embeddingProvider = String(
      updates.embedding_provider || currentConfig.embedding_provider,
    );
    const embeddingBase = String(
      updates.embedding_api_base ?? currentConfig.embedding_api_base,
    );
    const embeddingModel = String(
      updates.embedding_api_model ?? currentConfig.embedding_api_model,
    );
    const embeddingKey = String(
      updates.embedding_api_key ?? currentConfig.embedding_api_key,
    );
    const localEmbeddingModel = String(
      updates.embedding_local_model ?? currentConfig.embedding_local_model,
    );
    if (
      Object.keys(updates).some((key) => key.startsWith("embedding_")) &&
      embeddingProvider === "local" &&
      !localEmbeddingModel
    ) {
      throw new HttpError(400, "a local embedding model is required");
    }
    if (
      Object.keys(updates).some((key) => key.startsWith("embedding_")) &&
      embeddingProvider === "openai-compatible"
    ) {
      if (!embeddingBase || !isSecureApiBase(embeddingBase)) {
        throw new HttpError(
          400,
          "embeddings API base must use https:// (http:// is allowed only for localhost)",
        );
      }
      if (!embeddingModel) {
        throw new HttpError(400, "an embeddings model is required");
      }
      if (!embeddingKey && !isLocalEndpoint(embeddingBase)) {
        throw new HttpError(400, "a remote embeddings endpoint requires an API key");
      }
    }
    for (const key of ["rerank_api_key", "rerank_api_base", "rerank_model"]) {
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
    saveConfig(updates as Partial<import("../types.js").Config>);
    return c.json({ saved: true, config: publicConfig() });
  });

  app.post("/api/embeddings/reindex", async (c) => {
    const items = getAllItems(initDb());
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const kind of ["skill", "tool"] as const) {
      const group = items.filter((item) => item.kind === kind);
      if (!group.length) continue;
      const result = await indexItems(group, kind);
      added += result.added;
      updated += result.updated;
      skipped += result.skipped;
      errors.push(...result.errors);
    }
    return c.json({ added, updated, skipped, errors });
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
