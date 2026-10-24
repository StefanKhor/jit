import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  atomicWriteFile,
  JIT_SKILLS_DIR,
  MAX_SKILL_BYTES,
} from "./config.js";
import { fetchText } from "./remote.js";
import { isGithubRef } from "./github.js";
import { materializeSource, type CliSkill } from "./skillsCli.js";
import {
  deleteItem,
  deleteToolsForServer,
  indexItems,
  parseSkillText,
} from "./indexer.js";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { defaultManager } from "./mcp/client.js";
import { scanMcpConfig, scanText } from "./skillScan.js";
import { getItem, initDb, listItems } from "./storage/db.js";
import type {
  InspectResult,
  MarketplaceInput,
  MarketplaceItem,
  MarketplaceResponse,
  ScanReport,
} from "./types.js";

const REMOTE_TTL_MS = 300_000;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const remoteCache: {
  url: string;
  at: number;
  items: MarketplaceItem[];
  error: string;
} = { url: "", at: 0, items: [], error: "" };

function normalizeItem(
  raw: unknown,
  origin: string,
): MarketplaceItem | null {
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

  const installRecord = install as Record<string, unknown>;
  const hasUrlBody =
    kind === "skill" &&
    typeof installRecord.url === "string" &&
    installRecord.url.trim() !== "";
  return {
    ...(source as unknown as MarketplaceItem),
    id,
    kind,
    name: String(source.name || id).trim(),
    description: String(source.description || "").trim(),
    category: String(source.category || "Other").trim(),
    inputs,
    install: installRecord,
    origin,
    checksum_present: hasUrlBody
      ? Boolean(String(installRecord.sha256 || "").trim())
      : true,
  };
}

async function fetchRemote(url: string): Promise<MarketplaceItem[]> {
  const body = await fetchText(url, { label: "catalog", timeoutMs: 12_000 });
  const parsed = JSON.parse(body) as unknown;
  const items =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { items?: unknown }).items
      : parsed;
  if (!Array.isArray(items)) {
    throw new Error("catalog must contain an items array");
  }
  return items
    .map((raw) => normalizeItem(raw, url))
    .filter((item): item is MarketplaceItem => item !== null);
}

// A repository source is resolved by the skills CLI; each directory it installs
// becomes a catalog entry whose install step copies that directory into the JIT
// store. The SKILL.md frontmatter supplies the id, name, and description.
function itemFromCliSkill(
  skill: CliSkill,
  source: string,
): MarketplaceItem | null {
  const file = path.join(skill.path, "SKILL.md");
  let parsed;
  try {
    parsed = parseSkillText(readFileSync(file, "utf8"), file);
  } catch (error) {
    logger.warn(
      "skills entry %s could not be read: %s",
      skill.name,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  const id = parsed.id.trim();
  if (!SAFE_ID.test(id)) {
    logger.warn("skills entry %s has an unusable id '%s'", skill.name, id);
    return null;
  }
  return {
    id,
    kind: "skill",
    name: parsed.name || skill.name,
    description: parsed.description,
    category: parsed.categories[0] || "Skill",
    author: source.split("/")[0] || "",
    origin: `skills:${source}`,
    checksum_present: true,
    inputs: [],
    install: {
      skills_source: source,
      skills_name: skill.name,
      skills_hash: skill.hash,
    },
  };
}

function pickCliSkill(
  skills: CliSkill[],
  item: MarketplaceItem,
): CliSkill | null {
  const name = String(item.install.skills_name || "").trim();
  return (
    skills.find((skill) => skill.name === name) ||
    skills.find((skill) => skill.path === String(item.install.skills_path || "")) ||
    null
  );
}

export async function catalog(): Promise<{
  items: MarketplaceItem[];
  source: string;
  warning: string;
}> {
  const urls = [...new Set((loadConfig().marketplace_urls || []).map((value) => String(value).trim()).filter(Boolean))];
  if (urls.length === 0) {
    // JIT ships no catalog of its own: the marketplace is exactly the sources
    // the user pointed it at.
    return {
      items: [],
      source: "none",
      warning:
        "No marketplace catalogs configured. Add a catalog URL or a GitHub repository.",
    };
  }

  const now = Date.now();
  const cacheKey = urls.join("\n");
  let remoteItems: MarketplaceItem[] = [];
  let warning = "";
  if (remoteCache.url === cacheKey && now - remoteCache.at < REMOTE_TTL_MS) {
    remoteItems = remoteCache.items;
    warning = remoteCache.error;
  } else {
    const errors: string[] = [];
    const merged = new Map<string, MarketplaceItem>();
    for (const entered of urls) {
      try {
        if (isGithubRef(entered)) {
          const found = await materializeSource(entered);
          for (const skill of found.skills) {
            const item = itemFromCliSkill(skill, entered);
            if (item) merged.set(item.id, item);
          }
          if (found.warning) errors.push(found.warning);
        } else {
          for (const item of await fetchRemote(entered)) merged.set(item.id, item);
        }
      } catch (error) {
        errors.push(
          `${entered}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    remoteItems = [...merged.values()];
    warning = errors.join("; ");
    if (warning) logger.warn("remote marketplace failed: %s", warning);
    remoteCache.url = cacheKey;
    remoteCache.at = now;
    remoteCache.items = remoteItems;
    remoteCache.error = warning;
  }

  return {
    items: remoteItems,
    source: remoteItems.length ? "remote" : "none",
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
  const skills = new Set(listItems(initDb()).map((item) => item.id));
  return { mcp, skills };
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
  return fetchText(url, {
    label: "skill",
    timeoutMs: 20_000,
    expectedSha256: expectedSha,
  });
}

function existingSkill(itemId: string) {
  return getItem(initDb(), itemId);
}

function ackMessage(report: ScanReport): string {
  const first = report.findings.find((finding) => finding.level !== "low");
  return (
    "this entry needs explicit acknowledgement before install" +
    (first ? `: ${first.detail}` : "")
  );
}

async function installMcp(
  item: MarketplaceItem,
  values: Record<string, string>,
  acknowledge: boolean,
): Promise<Record<string, unknown>> {
  const config = substitute(item.install, values);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("invalid MCP definition");
  }
  const report = scanMcpConfig(config as Record<string, unknown>);
  if (report.requires_ack && !acknowledge) {
    throw new Error(ackMessage(report));
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
    warnings: report.findings,
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

// Copy a skills-CLI-provided skill directory into the JIT store. The CLI owns
// the download; JIT owns the scan, the index, and where the files live.
async function installCliSkill(
  item: MarketplaceItem,
  source: string,
  acknowledge: boolean,
): Promise<Record<string, unknown>> {
  const found = await materializeSource(source);
  const skill = pickCliSkill(found.skills, item);
  if (!skill) throw new Error(`${source} no longer provides '${item.id}'`);

  const body = readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill is larger than the size limit");
  }
  const report = scanText(body);
  if (report.requires_ack && !acknowledge) {
    throw new Error(ackMessage(report));
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

  // Validate before replacing anything, so a malformed entry cannot destroy the
  // currently installed copy.
  const parsed = parseSkillText(body, destination);
  if (parsed.id !== item.id) {
    throw new Error("skill frontmatter name must match the marketplace id");
  }
  parsed.name = item.name;
  if (parsed.categories.length === 0 && item.category) {
    parsed.categories = [item.category];
  }
  parsed.source = item.origin || "marketplace";

  const directory = path.dirname(destination);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.dirname(directory), { recursive: true });
  cpSync(skill.path, directory, { recursive: true });

  const warnings = [...report.findings];
  // The CLI's hash covers the whole skill. Comparing it with the hash recorded
  // when the source was listed detects a change between review and install.
  const expected = String(item.install.skills_hash || "").trim();
  if (expected && skill.hash && expected !== skill.hash) {
    warnings.push({
      level: "low",
      rule: "content-changed",
      detail: "the skill changed at the source since it was listed",
    });
  }
  const indexed = await indexItems([parsed], "skill");
  return {
    ok: true,
    id: item.id,
    kind: "skill",
    installed: true,
    connected: true,
    warnings,
    ...indexed,
  };
}

async function installSkill(
  item: MarketplaceItem,
  _values: Record<string, string>,
  acknowledge: boolean,
): Promise<Record<string, unknown>> {
  const spec = item.install;
  const cliSource = String(spec.skills_source || "").trim();
  if (cliSource) return installCliSkill(item, cliSource, acknowledge);

  let body = spec.body;
  if (body === undefined || body === null) {
    const url = String(spec.url || "").trim();
    if (!url) throw new Error("skill definition needs a body or a URL");
    const expectedSha = String(spec.sha256 || "").trim();
    // A catalog is a single point of compromise, and an unpinned body can
    // change between review and install, so a URL body must carry a checksum.
    if (!expectedSha) {
      throw new Error(
        "catalog entry is missing a sha256 checksum for its skill body",
      );
    }
    body = await fetchSkill(url, expectedSha);
  }
  if (typeof body !== "string") throw new Error("skill body must be text");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill is larger than the size limit");
  }

  const report = scanText(body);
  if (report.requires_ack && !acknowledge) {
    throw new Error(ackMessage(report));
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
  parsed.source = item.origin || "catalog";
  mkdirSync(path.dirname(destination), { recursive: true });
  atomicWriteFile(destination, body, 0o644);
  const indexed = await indexItems([parsed], "skill");
  return {
    ok: true,
    id: item.id,
    kind: "skill",
    installed: true,
    connected: true,
    warnings: report.findings,
    ...indexed,
  };
}

export interface InstallOptions {
  acknowledge?: boolean;
}

export async function install(
  itemId: string,
  inputs: Record<string, unknown> = {},
  options: InstallOptions = {},
): Promise<Record<string, unknown>> {
  const item = await find(itemId);
  if (!item) throw new Error("not found in the marketplace");
  const values = inputValues(item, inputs);
  const acknowledge = Boolean(options.acknowledge);
  if (item.kind === "mcp") return installMcp(item, values, acknowledge);
  return installSkill(item, values, acknowledge);
}

// Fetch and scan an entry without installing it, so the dashboard can warn
// before the user commits. Nothing is written here.
export async function inspect(itemId: string): Promise<InspectResult> {
  const item = await find(itemId);
  if (!item) throw new Error("not found in the marketplace");
  if (item.kind === "mcp") {
    return {
      id: item.id,
      kind: "mcp",
      checksum_required: false,
      checksum_present: true,
      report: scanMcpConfig(item.install as Record<string, unknown>),
    };
  }
  const spec = item.install;
  const url = String(spec.url || "").trim();
  const cliSource = String(spec.skills_source || "").trim();
  const checksumRequired = Boolean(url) && !cliSource;
  const checksumPresent = cliSource
    ? true
    : Boolean(String(spec.sha256 || "").trim());
  const failed = (detail: string): InspectResult => ({
    id: item.id,
    kind: "skill",
    checksum_required: checksumRequired,
    checksum_present: checksumPresent,
    report: {
      ok: false,
      requires_ack: true,
      findings: [{ level: "medium", rule: "fetch-failed", detail }],
    },
  });
  let body: string | undefined;
  if (typeof spec.body === "string") {
    body = spec.body;
  } else if (cliSource) {
    try {
      const found = await materializeSource(cliSource);
      const skill = pickCliSkill(found.skills, item);
      if (!skill) throw new Error(`${cliSource} no longer provides '${item.id}'`);
      body = readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  } else if (url) {
    try {
      body = await fetchSkill(url, String(spec.sha256 || ""));
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    id: item.id,
    kind: "skill",
    checksum_required: checksumRequired,
    checksum_present: checksumPresent,
    report: body !== undefined
      ? scanText(body)
      : { ok: true, requires_ack: false, findings: [] },
  };
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

  const directory = path.join(JIT_SKILLS_DIR, itemId);
  const destination = path.join(directory, "SKILL.md");
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
    // A skill is a directory: resources it references live alongside SKILL.md.
    rmSync(directory, { recursive: true, force: true });
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
