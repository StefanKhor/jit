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
import {
  parseSkillsShRef,
  searchSkillsSh,
  topSkills,
  type SkillsShHit,
  type TopView,
} from "./skillsSh.js";
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
import { scanMcpConfig, enforceGate, type SecurityGate } from "./skillScan.js";
import { scanSkillPayload } from "./skillspector.js";
import { getItem, initDb, listItems } from "./storage/db.js";
import type {
  InspectResult,
  MarketplaceDiscovery,
  MarketplaceInput,
  MarketplaceItem,
  MarketplaceResponse,
  MarketplaceTopResponse,
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
  origin = `skills:${source}`,
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
    origin,
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
    // JIT ships no catalog of its own: this list is exactly the sources the user
    // pointed it at. The skills.sh directory is browsed separately.
    return {
      items: [],
      source: "none",
      warning:
        "No marketplace catalogs configured. Add a catalog URL, a GitHub repository, or a skills.sh link.",
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
        const directory = parseSkillsShRef(entered);
        if (directory) {
          const found = await materializeSource(directory.source, directory.skill);
          const origin = `skills.sh:${directory.source}${
            directory.skill ? `/${directory.skill}` : ""
          }`;
          for (const skill of found.skills) {
            const item = itemFromCliSkill(skill, directory.source, origin);
            if (item) merged.set(item.id, item);
          }
          if (found.warning) errors.push(found.warning);
        } else if (isGithubRef(entered)) {
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

export interface SourceHint {
  /** `owner/repo` the skills CLI resolves. */
  source?: string;
  /** One skill inside that source; empty materializes the whole repository. */
  skill?: string;
}

/**
 * An id resolves against the configured catalogs first. Entries discovered on
 * skills.sh are in no catalog, so they carry the source they came from and are
 * materialized on demand — the same cached call a catalog listing makes, so
 * reviewing and then installing one skill does not clone it twice.
 */
async function resolveItem(
  itemId: string,
  hint: SourceHint = {},
): Promise<MarketplaceItem | null> {
  const known = await find(itemId);
  if (known) return known;

  const source = String(hint.source || "").trim();
  if (!source) return null;
  const skill = String(hint.skill || "").trim();
  const found = await materializeSource(source, skill);
  const entry = skill
    ? found.skills.find((candidate) => candidate.name === skill) || found.skills[0]
    : found.skills[0];
  if (!entry) throw new Error(`'${itemId}' is not provided by ${source}`);
  const item = itemFromCliSkill(
    entry,
    source,
    `skills.sh:${source}${skill ? `/${skill}` : ""}`,
  );
  if (!item) throw new Error(`'${itemId}' could not be read from ${source}`);
  return item;
}

// A skills.sh listing is enough to show a card, but not to install: the real id,
// name, and description come from SKILL.md at review time. Until then the entry
// is a pointer the resolve step above follows.
function itemFromHit(hit: SkillsShHit): MarketplaceItem | null {
  const id = hit.skill.trim().toLowerCase();
  if (!SAFE_ID.test(id)) return null;
  return {
    id,
    kind: "skill",
    name: hit.name,
    description: "",
    category: "Skill",
    author: hit.source.split("/")[0] || "",
    origin: `skills.sh:${hit.source}/${hit.skill}`,
    checksum_present: true,
    inputs: [],
    install: {
      skills_source: hit.source,
      skills_name: hit.skill,
      skills_hash: "",
    },
    installs: hit.installs,
    weekly_installs: hit.weekly,
  };
}

async function withInstalledState(
  items: MarketplaceItem[],
): Promise<MarketplaceItem[]> {
  const { skills } = await installedState();
  for (const item of items) item.installed = skills.has(item.id);
  return items;
}

/** Search the directory. Nothing here is downloaded or trusted yet. */
export async function searchMarketplace(
  query: string,
): Promise<MarketplaceDiscovery> {
  const hits = await searchSkillsSh(query);
  const items = hits
    .map(itemFromHit)
    .filter((item): item is MarketplaceItem => item !== null);
  return { items: await withInstalledState(items), warning: "" };
}

/** The directory's own ranking, one page at a time. */
export async function topMarketplace(
  view: string,
  page = 1,
  pageSize = 100,
): Promise<MarketplaceTopResponse> {
  const current: TopView = view === "trending" ? "trending" : "all-time";
  const result = await topSkills(current, page, pageSize);
  const items = result.hits
    .map(itemFromHit)
    .filter((item): item is MarketplaceItem => item !== null);
  return {
    items: await withInstalledState(items),
    warning: "",
    view: result.view,
    page: result.page,
    page_size: result.pageSize,
    has_more: result.hasMore,
    total: result.total,
  };
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

/** The acknowledgement / override a caller can present to the install gate. */
type Gate = SecurityGate;

async function installMcp(
  item: MarketplaceItem,
  values: Record<string, string>,
  gate: Gate,
): Promise<Record<string, unknown>> {
  const config = substitute(item.install, values);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("invalid MCP definition");
  }
  const report = scanMcpConfig(config as Record<string, unknown>);
  enforceGate(report, gate);
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
  gate: Gate,
): Promise<Record<string, unknown>> {
  const found = await materializeSource(source);
  const skill = pickCliSkill(found.skills, item);
  if (!skill) throw new Error(`${source} no longer provides '${item.id}'`);

  const body = readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill is larger than the size limit");
  }
  // Scan the whole materialized directory, so scripts beside SKILL.md are seen.
  const report = await scanSkillPayload({ path: skill.path });
  enforceGate(report, gate);
  const scanWarnings = report.findings;

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

  const warnings = [...scanWarnings];
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
  gate: Gate,
): Promise<Record<string, unknown>> {
  const spec = item.install;
  const cliSource = String(spec.skills_source || "").trim();
  if (cliSource) return installCliSkill(item, cliSource, gate);

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

  const report = await scanSkillPayload({ body });
  enforceGate(report, gate);

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

export interface InstallOptions extends SourceHint {
  acknowledge?: boolean;
  /** Override a hard block from the security scan. */
  force?: boolean;
}

export async function install(
  itemId: string,
  inputs: Record<string, unknown> = {},
  options: InstallOptions = {},
): Promise<Record<string, unknown>> {
  const item = await resolveItem(itemId, options);
  if (!item) throw new Error("not found in the marketplace");
  const values = inputValues(item, inputs);
  const gate: Gate = {
    acknowledge: Boolean(options.acknowledge),
    force: Boolean(options.force),
  };
  if (item.kind === "mcp") return installMcp(item, values, gate);
  return installSkill(item, values, gate);
}

// Fetch and scan an entry without installing it, so the dashboard can warn
// before the user commits. Nothing is written here.
export async function inspect(
  itemId: string,
  hint: SourceHint = {},
): Promise<InspectResult> {
  const item = await resolveItem(itemId, hint);
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
      gate: "ack",
      findings: [{ level: "medium", rule: "fetch-failed", detail }],
    },
  });
  let body: string | undefined;
  let target: string | undefined;
  if (typeof spec.body === "string") {
    body = spec.body;
  } else if (cliSource) {
    try {
      const found = await materializeSource(cliSource);
      const skill = pickCliSkill(found.skills, item);
      if (!skill) throw new Error(`${cliSource} no longer provides '${item.id}'`);
      body = readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
      target = skill.path;
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
    report:
      body !== undefined
        ? await scanSkillPayload({ body, path: target })
        : { ok: true, requires_ack: false, findings: [] },
  };
}

export async function uninstall(
  itemId: string,
): Promise<Record<string, unknown>> {
  const item = await find(itemId);
  // A skill installed from the skills.sh directory is in no configured catalog,
  // but it is still JIT-owned and removable by id. An id that names a managed
  // MCP server takes the server path either way.
  const manager = defaultManager();
  const isMcp = item
    ? item.kind === "mcp"
    : await manager
        .loadConfigs()
        .then(() => manager.getStatus()[itemId] !== undefined);

  if (isMcp) {
    const removed = manager.removeServer(itemId);
    const toolsRemoved = deleteToolsForServer(itemId);
    return {
      ok: true,
      id: itemId,
      removed,
      tools_removed: toolsRemoved,
    };
  }

  if (!item && !existingSkill(itemId)) {
    throw new Error("not found in the marketplace");
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
