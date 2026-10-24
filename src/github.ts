import path from "node:path";

import { parseSkillText } from "./indexer.js";
import { logger } from "./logger.js";
import { MCPClientManager } from "./mcp/client.js";
import { fetchText, sha256 } from "./remote.js";

// A GitHub repository can act as a marketplace source. JIT pins the repository
// to a commit, then either reads the `marketplace.json` it ships or crawls it
// for `SKILL.md` files and MCP definitions. Everything is fetched from
// raw.githubusercontent.com at the pinned commit, so a url body that resolved
// once cannot change under the user between review and install.
const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
const API_BYTES = 4 * 1024 * 1024;
const CATALOG_BYTES = 4 * 1024 * 1024;
const TREE_LIMIT = 20_000;
const SKILL_LIMIT = 60;
const MCP_FILE_LIMIT = 5;
const MCP_LIMIT = 20;
const CONCURRENCY = 6;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const SKILL_FILE = /(^|\/)SKILL\.md$/i;
const MCP_FILE = /(^|\/)(\.mcp\.json|mcp\.json|mcp\.servers\.json)$/i;

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit; empty means the repository default branch. */
  ref: string;
  /** Directory inside the repository to treat as the marketplace root. */
  subpath: string;
}

export interface GithubCatalog {
  origin: string;
  items: unknown[];
  warning: string;
}

/** `owner/repo`, `owner/repo@ref#subdir`, or a github.com URL. */
export function parseGithubRef(input: string): GithubRef | null {
  const value = String(input || "").trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0] || "";
    const repo = (parts[1] || "").replace(/\.git$/i, "");
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
    if (parts[2] === "tree" && parts.length >= 4) {
      return {
        owner,
        repo,
        ref: decodeURIComponent(parts[3] || ""),
        subpath: parts
          .slice(4)
          .map((part) => decodeURIComponent(part))
          .join("/"),
      };
    }
    return { owner, repo, ref: "", subpath: "" };
  }

  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@([^\s#]+))?(?:#(\S*))?$/.exec(
    value,
  );
  if (!match) return null;
  return {
    owner: match[1] || "",
    repo: match[2] || "",
    ref: match[3] || "",
    subpath: (match[4] || "").replace(/^\/+|\/+$/g, ""),
  };
}

export function isGithubRef(input: string): boolean {
  return parseGithubRef(input) !== null;
}

// A `github.com/owner/repo/blob/<ref>/<path>` link is what the Copy button on
// GitHub gives you. Rewrite it to the raw host so it works as a plain catalog
// URL; anything else is returned untouched.
export function toRawGithubUrl(input: string): string {
  const value = String(input || "").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return value;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return value;
  const owner = parts[0] || "";
  const repo = (parts[1] || "").replace(/\.git$/i, "");
  const ref = encodeURIComponent(parts[3] || "");
  const rest = parts.slice(4).map((part) => encodeURIComponent(part)).join("/");
  return `${RAW_ROOT}/${owner}/${repo}/${ref}/${rest}`;
}

function githubHeaders(): Record<string, string> {
  const token = (
    process.env.JIT_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ""
  ).trim();
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "jit-mcp",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function rawUrl(
  owner: string,
  repo: string,
  sha: string,
  file: string,
): string {
  const encoded = file
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${RAW_ROOT}/${owner}/${repo}/${sha}/${encoded}`;
}

async function githubJson<T>(
  path: string,
  headers: Record<string, string>,
  label: string,
): Promise<T> {
  const body = await fetchText(`${API_ROOT}${path}`, {
    headers,
    maxBytes: API_BYTES,
    timeoutMs: 15_000,
    label,
  });
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, values.length)) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await run(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Resolve `a/./b/../c` to `a/c`, refusing paths that escape the repository.
function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return "";
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractMcpServers(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const candidates: unknown[] = [record.mcpServers];
  const section = record.mcp;
  if (section && typeof section === "object" && !Array.isArray(section)) {
    candidates.push((section as Record<string, unknown>).servers);
    candidates.push(section);
  }
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      Object.keys(candidate as Record<string, unknown>).length > 0
    ) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function slugName(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
}

// Rewrite a repository's own marketplace.json: skill bodies referenced by a
// relative path come from the pinned commit, and any body without a checksum
// is fetched once here so the entry is installable and verifiable.
async function resolveCatalogEntries(
  listed: unknown[],
  context: {
    owner: string;
    repo: string;
    sha: string;
    scope: string;
    blobs: Set<string>;
    notes: string[];
    headers: Record<string, string>;
  },
): Promise<unknown[]> {
  const { owner, repo, sha, scope, blobs, notes, headers } = context;
  const baseDir = scope ? `${scope}/` : "";
  const resolved = await mapLimit(listed, CONCURRENCY, async (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = { ...(entry as Record<string, unknown>) };
    const install = item.install;
    if (!install || typeof install !== "object" || Array.isArray(install)) {
      return item;
    }
    const spec = install as Record<string, unknown>;
    const url = String(spec.url || "").trim();
    if (!url || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return item;
    const target = normalizePath(`${baseDir}${url.replace(/^\.?\//, "")}`);
    if (!target || !blobs.has(target)) {
      notes.push(`${String(item.id || url)}: ${url} is not in the repository`);
      return null;
    }
    try {
      const body = await fetchText(rawUrl(owner, repo, sha, target), {
        label: "skill",
        headers,
        timeoutMs: 15_000,
      });
      spec.url = rawUrl(owner, repo, sha, target);
      if (!String(spec.sha256 || "").trim()) spec.sha256 = sha256(body);
      return item;
    } catch (error) {
      notes.push(`${String(item.id || url)}: ${message(error)}`);
      return null;
    }
  });
  return resolved.filter(
    (entry): entry is Record<string, unknown> => entry !== null,
  );
}

export async function discoverGithubRepo(
  input: string,
): Promise<GithubCatalog> {
  const ref = parseGithubRef(input);
  if (!ref) throw new Error("not a GitHub repository reference");
  const headers = githubHeaders();
  const slug = `${ref.owner}/${ref.repo}`;

  const commitPath = `/repos/${slug}/commits/${encodeURIComponent(ref.ref || "HEAD")}`;
  let commit: { sha?: unknown };
  try {
    commit = await githubJson<{ sha?: unknown }>(
      commitPath,
      headers,
      "GitHub repository",
    );
  } catch (error) {
    throw new Error(
      `could not read ${slug}${ref.ref ? `@${ref.ref}` : ""}: ${message(error)}`,
    );
  }
  const sha = String(commit.sha || "").trim();
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`could not resolve a commit for ${slug}`);
  }

  let tree: { tree?: unknown; truncated?: unknown };
  try {
    tree = await githubJson<{ tree?: unknown; truncated?: unknown }>(
      `/repos/${slug}/git/trees/${sha}?recursive=1`,
      headers,
      "GitHub repository tree",
    );
  } catch (error) {
    throw new Error(`could not list ${slug}: ${message(error)}`);
  }
  const blobs = new Set<string>();
  if (Array.isArray(tree.tree)) {
    for (const entry of tree.tree.slice(0, TREE_LIMIT)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      if (node.type === "blob" && typeof node.path === "string") {
        blobs.add(node.path);
      }
    }
  }

  const scope = normalizePath(ref.subpath);
  const inScope = (file: string) =>
    !scope || file === scope || file.startsWith(`${scope}/`);
  const scoped = [...blobs].filter(inScope);
  const origin = `github:${slug}@${sha.slice(0, 7)}${scope ? `/${scope}` : ""}`;
  const notes: string[] = [];
  if (tree.truncated === true) {
    notes.push(`${origin}: the repository tree was too large to read fully`);
  }

  const catalogPath = scope ? `${scope}/marketplace.json` : "marketplace.json";
  if (scoped.includes(catalogPath)) {
    const body = await fetchText(rawUrl(ref.owner, ref.repo, sha, catalogPath), {
      label: "catalog",
      headers,
      timeoutMs: 15_000,
      maxBytes: CATALOG_BYTES,
    });
    const parsed = JSON.parse(body) as unknown;
    const listed =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { items?: unknown }).items
        : parsed;
    if (!Array.isArray(listed)) {
      throw new Error("catalog must contain an items array");
    }
    const items = await resolveCatalogEntries(listed, {
      owner: ref.owner,
      repo: ref.repo,
      sha,
      scope,
      blobs,
      notes,
      headers,
    });
    logger.debug("github catalog %s: %d items", origin, items.length);
    return { origin, items, warning: notes.join("; ") };
  }

  const items: unknown[] = [];
  const seen = new Set<string>();

  const skillPaths = scoped.filter((file) => SKILL_FILE.test(file)).slice(0, SKILL_LIMIT);
  const skillBodies = await mapLimit(skillPaths, CONCURRENCY, async (file) => {
    try {
      const body = await fetchText(rawUrl(ref.owner, ref.repo, sha, file), {
        label: "skill",
        headers,
        timeoutMs: 15_000,
      });
      return { file, body };
    } catch (error) {
      notes.push(`${file}: ${message(error)}`);
      return null;
    }
  });
  for (const entry of skillBodies) {
    if (!entry) continue;
    let parsed;
    try {
      parsed = parseSkillText(entry.body, entry.file);
    } catch (error) {
      notes.push(`${entry.file}: ${message(error)}`);
      continue;
    }
    const id = parsed.id.trim();
    if (!SAFE_ID.test(id)) {
      notes.push(
        `${entry.file}: '${id}' must be lowercase letters, numbers, dot, dash, or underscore`,
      );
      continue;
    }
    if (seen.has(id)) {
      notes.push(`${entry.file}: duplicate id '${id}'`);
      continue;
    }
    seen.add(id);
    items.push({
      id,
      kind: "skill",
      name: parsed.name,
      description: parsed.description,
      category: parsed.categories[0] || "GitHub",
      author: ref.owner,
      source: origin,
      install: { url: rawUrl(ref.owner, ref.repo, sha, entry.file), sha256: sha256(entry.body) },
    });
  }

  const mcpPaths = scoped
    .filter((file) => MCP_FILE.test(file) && path.extname(file).toLowerCase() === ".json")
    .slice(0, MCP_FILE_LIMIT);
  const mcpDocs = await mapLimit(mcpPaths, CONCURRENCY, async (file) => {
    try {
      const text = await fetchText(rawUrl(ref.owner, ref.repo, sha, file), {
        label: "MCP config",
        headers,
        timeoutMs: 15_000,
      });
      return { file, text };
    } catch (error) {
      notes.push(`${file}: ${message(error)}`);
      return null;
    }
  });
  let mcpCount = 0;
  for (const entry of mcpDocs) {
    if (!entry) continue;
    let data: unknown;
    try {
      data = JSON.parse(entry.text);
    } catch {
      notes.push(`${entry.file}: not valid JSON`);
      continue;
    }
    const servers = extractMcpServers(data);
    if (!servers) {
      notes.push(`${entry.file}: no mcpServers found`);
      continue;
    }
    for (const [label, config] of Object.entries(servers)) {
      if (mcpCount >= MCP_LIMIT) break;
      const normalized = MCPClientManager.normalizeConfig(config);
      if (!normalized) continue;
      const id = slugName(label);
      if (!id || !SAFE_ID.test(id)) {
        notes.push(`${entry.file}: '${label}' is not a usable server name`);
        continue;
      }
      if (seen.has(id)) {
        notes.push(`${entry.file}: duplicate id '${id}'`);
        continue;
      }
      seen.add(id);
      mcpCount += 1;
      const described = (config as Record<string, unknown>).description;
      items.push({
        id,
        kind: "mcp",
        name: String(label).trim() || id,
        description:
          typeof described === "string" && described.trim()
            ? described.trim()
            : `MCP server defined in ${slug}`,
        category: "MCP",
        author: ref.owner,
        source: origin,
        install: normalized,
      });
    }
  }

  if (items.length === 0 && notes.length === 0) {
    notes.push(
      `${origin}: no marketplace.json, SKILL.md, or MCP config found`,
    );
  }
  logger.debug("github repo %s: %d items", origin, items.length);
  return { origin, items, warning: notes.join("; ") };
}
