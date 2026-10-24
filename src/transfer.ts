import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import {
  atomicWriteFile,
  JIT_SKILLS_DIR,
  MAX_SKILL_BYTES,
  MCP_CONFIG,
} from "./config.js";
import {
  deleteItem,
  discoverSkills,
  expandHome,
  getItem,
  indexItems,
  parseSkillFile,
  parseSkillText,
} from "./indexer.js";
import { logger } from "./logger.js";
import { defaultManager } from "./mcp/client.js";
import { initDb } from "./storage/db.js";
import type {
  ExportMcpResult,
  ExportSkillsResult,
  IndexItem,
  McpServerConfig,
  TransferResult,
} from "./types.js";

function skillDirName(itemId: unknown): string {
  const name = String(itemId || "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".")
  ) {
    throw new Error("skill name must be a simple file name");
  }
  return name;
}

function discover(rawPath: string | undefined): string[] {
  const raw = String(rawPath || "").trim();
  if (!raw) return discoverSkills();
  const base = path.resolve(expandHome(raw));
  if (!existsSync(base)) throw new Error(`path not found: ${raw}`);
  const stat = statSync(base);
  const files = stat.isFile() ? [base] : discoverSkills([base]);
  if (files.length === 0) throw new Error("no skill files found");
  return files;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function indexParsed(
  items: IndexItem[],
  errors: string[],
): Promise<{ added: number; updated: number; skipped: number; errors: string[] }> {
  if (items.length === 0) {
    return { added: 0, updated: 0, skipped: 0, errors };
  }
  const result = await indexItems(items, "skill");
  return { ...result, errors: [...errors, ...result.errors] };
}

export async function copySkillsToJit(
  rawPath?: string,
  overwrite = false,
): Promise<TransferResult> {
  const files = discover(rawPath);
  const copied: string[] = [];
  const parsedItems: IndexItem[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const source = parseSkillFile(file);
      const itemId = skillDirName(source.id);
      const destination = path.join(JIT_SKILLS_DIR, itemId, "SKILL.md");

      if (path.resolve(destination) === path.resolve(file)) {
        copied.push(destination);
        parsedItems.push(source);
        continue;
      }
      if (existsSync(destination) && !overwrite) {
        errors.push(
          `${file}: a JIT copy of '${itemId}' already exists ` +
            "(enable overwrite to replace it)",
        );
        continue;
      }

      const text = readFileSync(file, "utf8");
      // Validate against the destination path before replacing an existing
      // copy. This keeps the previous JIT-owned skill intact on bad input.
      const parsed = parseSkillText(text, destination);
      if (parsed.id !== itemId) {
        throw new Error("skill id changed while copying");
      }
      atomicWriteFile(destination, text, 0o644);
      copied.push(destination);
      parsedItems.push(parsed);
    } catch (error) {
      errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const indexed = await indexParsed(parsedItems, errors);
  return {
    mode: "copy",
    found: files.length,
    copied,
    added: indexed.added,
    updated: indexed.updated,
    skipped: indexed.skipped,
    errors: indexed.errors,
  };
}

export async function indexSkillsInPlace(
  rawPath?: string,
): Promise<TransferResult> {
  const files = discover(rawPath);
  const items: IndexItem[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      items.push(parseSkillFile(file));
    } catch (error) {
      errors.push(
        `${path.basename(file)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const indexed = await indexParsed(items, errors);
  return {
    mode: "link",
    found: files.length,
    copied: [],
    added: indexed.added,
    updated: indexed.updated,
    skipped: indexed.skipped,
    errors: indexed.errors,
  };
}

export async function transferSkills(
  rawPath?: string,
  copy = true,
  overwrite = false,
): Promise<TransferResult> {
  return copy
    ? copySkillsToJit(rawPath, overwrite)
    : indexSkillsInPlace(rawPath);
}

export async function exportSkills(
  ids: unknown,
  destination: unknown,
  overwrite = false,
): Promise<ExportSkillsResult> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("select at least one skill");
  }
  if (ids.length > 500) throw new Error("too many skills");
  const rawDestination = String(destination || "").trim();
  if (!rawDestination) throw new Error("destination folder is required");
  const dest = path.resolve(expandHome(rawDestination));
  const jitRoot = path.resolve(JIT_SKILLS_DIR);
  if (inside(jitRoot, dest)) {
    throw new Error("choose a folder outside ~/.jit/skills");
  }
  if (existsSync(dest) && !statSync(dest).isDirectory()) {
    throw new Error("destination is not a folder");
  }
  mkdirSync(dest, { recursive: true });

  const db = initDb();
  const exported: Array<{ id: string; path: string }> = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  try {
    for (const rawId of ids) {
      const itemId = String(rawId || "").trim();
      if (!itemId) continue;
      const item = getItem(db, itemId);
      if (!item) {
        errors.push(`${itemId}: not found`);
        continue;
      }
      if (item.kind !== "skill") {
        errors.push(`${itemId}: not a skill`);
        continue;
      }
      let dirName: string;
      try {
        dirName = skillDirName(itemId);
      } catch (error) {
        errors.push(
          `${itemId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const source = path.resolve(expandHome(item.path || ""));
      if (!existsSync(source) || !statSync(source).isFile()) {
        errors.push(`${itemId}: source file is missing`);
        continue;
      }
      if (statSync(source).size > MAX_SKILL_BYTES) {
        errors.push(`${itemId}: source file exceeds the size limit`);
        continue;
      }
      const target = path.join(dest, dirName, "SKILL.md");
      if (path.resolve(target) === source) {
        skipped.push(itemId);
        continue;
      }
      if (existsSync(target) && !overwrite) {
        skipped.push(itemId);
        continue;
      }
      atomicWriteFile(target, readFileSync(source, "utf8"), 0o644);
      exported.push({ id: itemId, path: target });
    }
  } finally {
    db.close();
  }

  return { exported, skipped, errors, destination: dest };
}

function openCodeEntry(config: McpServerConfig): Record<string, unknown> {
  const url = config.url || config.serverUrl;
  if (url) {
    const entry: Record<string, unknown> = {
      type: "remote",
      url: String(url),
      enabled: true,
    };
    if (config.headers && Object.keys(config.headers).length > 0) {
      entry.headers = { ...config.headers };
    }
    return entry;
  }
  const entry: Record<string, unknown> = {
    type: "local",
    command: [
      String(config.command || ""),
      ...(config.args || []).map(String),
    ],
    enabled: true,
  };
  if (config.env && Object.keys(config.env).length > 0) {
    entry.environment = { ...config.env };
  }
  return entry;
}

function cleanConfig(config: McpServerConfig): McpServerConfig {
  const result: McpServerConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith("_") && value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export async function exportMcp(
  servers: unknown,
  destination: unknown,
  overwrite = false,
): Promise<ExportMcpResult> {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error("select at least one server");
  }
  if (servers.length > 100) throw new Error("too many servers");
  const rawDestination = String(destination || "").trim();
  if (!rawDestination) throw new Error("destination config is required");
  const dest = path.resolve(expandHome(rawDestination));
  if (dest === path.resolve(MCP_CONFIG)) {
    throw new Error("choose a client config, not JIT's own mcp.json");
  }
  if (existsSync(dest) && statSync(dest).isDirectory()) {
    throw new Error("destination is a folder");
  }

  const managed = defaultManager().managedServers();
  const configs: Record<string, McpServerConfig> = {};
  for (const rawName of servers) {
    const name = String(rawName || "").trim();
    const config = managed[name];
    if (!config) throw new Error(`'${name}' is not managed by JIT`);
    configs[name] = config;
  }

  let data: Record<string, unknown> = {};
  if (existsSync(dest)) {
    try {
      const parsed = JSON.parse(readFileSync(dest, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("destination must contain a JSON object");
      }
      data = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `destination is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const opencode = ["opencode.json", "opencode.jsonc"].includes(
    path.basename(dest),
  );
  let target: Record<string, unknown>;
  let entries: Record<string, unknown>;
  if (opencode) {
    const section = data.mcp;
    if (section && typeof section === "object" && !Array.isArray(section)) {
      const mcp = section as Record<string, unknown>;
      if (
        mcp.servers &&
        typeof mcp.servers === "object" &&
        !Array.isArray(mcp.servers)
      ) {
        target = mcp.servers as Record<string, unknown>;
      } else if (mcp.servers !== undefined) {
        throw new Error("destination 'mcp.servers' must be an object");
      } else {
        target = mcp;
      }
    } else {
      target = {};
      data.mcp = target;
    }
    entries = Object.fromEntries(
      Object.entries(configs).map(([name, config]) => [
        name,
        openCodeEntry(config),
      ]),
    );
  } else {
    const section = data.mcpServers;
    if (section && typeof section === "object" && !Array.isArray(section)) {
      target = section as Record<string, unknown>;
    } else {
      target = {};
      data.mcpServers = target;
    }
    entries = Object.fromEntries(
      Object.entries(configs).map(([name, config]) => [
        name,
        cleanConfig(config),
      ]),
    );
  }

  const exported: string[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (name in target && !overwrite) {
      skipped.push(name);
      continue;
    }
    target[name] = entry;
    exported.push(name);
  }

  if (exported.length > 0) {
    let mode = 0o600;
    if (existsSync(dest)) {
      try {
        mode = statSync(dest).mode & 0o777;
      } catch {
        // Keep the default.
      }
    }
    atomicWriteFile(
      dest,
      JSON.stringify(data, null, 2) + "\n",
      mode,
    );
  }

  return {
    exported,
    skipped,
    errors: [],
    path: dest,
    format: opencode ? "opencode" : "mcpServers",
  };
}

export async function removeSkillCopy(id: string): Promise<boolean> {
  const db = initDb();
  let fileRemoved = false;
  try {
    const item = getItem(db, id);
    if (!item) return false;
    const resolved = path.resolve(item.path || "");
    const root = path.resolve(JIT_SKILLS_DIR);
    let removeIndex = true;
    if (inside(root, resolved) && existsSync(resolved)) {
      try {
        unlinkSync(resolved);
        fileRemoved = true;
        try {
          const parent = path.dirname(resolved);
          if (path.resolve(parent) !== root) {
            rmdirSync(parent);
          }
        } catch {
          // Directory is not empty; leave it.
        }
      } catch (error) {
        removeIndex = false;
        logger.warn("could not remove JIT skill copy: %s", error);
      }
    }
    if (removeIndex) deleteItem(id);
    return fileRemoved;
  } finally {
    db.close();
  }
}
