import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Config, PublicConfig } from "./types.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readPackageVersion(): string {
  try {
    const data = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return data.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export const VERSION = readPackageVersion();
export const PACKAGE_DIR = PACKAGE_ROOT;
export const STATIC_DIR = path.join(PACKAGE_ROOT, "static");
export const DASHBOARD_HTML = path.join(STATIC_DIR, "dashboard.html");

export const INDEX_DIR = path.resolve(
  (process.env.JIT_HOME || path.join(homedir(), ".jit")).replace(
    /^~(?=[\\/]|$)/,
    homedir(),
  ),
);
/** The whole index: skills, bodies, and base64 embeddings. Single writer. */
export const INDEX_FILE = path.join(INDEX_DIR, "index.json");
export const CONFIG_FILE = path.join(INDEX_DIR, "config.json");
export const MCP_CONFIG = path.join(INDEX_DIR, "mcp.json");
export const JIT_SKILLS_DIR = path.join(INDEX_DIR, "skills");
/** Cloned skill repos land here, one folder per repo, so a re-pull is a
 *  plain `git pull` and the user can inspect everything JIT fetched. */
export const REPOS_DIR = path.join(INDEX_DIR, "repos");
export const MODEL_CACHE_DIR = path.resolve(
  (process.env.JIT_MODEL_CACHE || path.join(INDEX_DIR, "models")).replace(
    /^~(?=[\\/]|$)/,
    homedir(),
  ),
);

export const DEFAULT_SKILL_PATHS = [
  path.join(homedir(), ".skills"),
  path.join(homedir(), ".claude", "skills"),
  path.join(homedir(), ".agents", "skills"),
  path.join(homedir(), ".codex", "skills"),
  path.join(homedir(), ".config", "opencode", "skills"),
  path.join(process.cwd(), ".opencode", "skills"),
  path.join(process.cwd(), "skills"),
  // JIT's own managed copies, so a scan still finds skills that live only in
  // JIT's storage — e.g. after the index is rebuilt from scratch.
  JIT_SKILLS_DIR,
];

function envNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(bounded) : bounded;
}

/**
 * How many vector hits are pulled before the decision layer sees them. This is
 * the ceiling on what the reranker can rescue, so it cannot be tiny — but the
 * ranking has no useful tail: on a 94-skill index the right skill is either in
 * the top few or not in the list at all (recall@5 and recall@20 were identical,
 * with the only misses at rank 40+). Ten keeps the rerank prompt small without
 * giving up a match. Raise it with JIT_TOP_K if a larger catalog behaves
 * differently.
 */
export const TOP_K_RETRIEVE = envNumber("JIT_TOP_K", 10, 1, 1000, true);

const MAX_EMBEDDING_DIM = 16384;

export const DEFAULT_HOST = process.env.JIT_HOST || "127.0.0.1";
export const DEFAULT_PORT = envNumber("JIT_PORT", 3000, 1, 65535, true);
export const MAX_REQUEST_BYTES = envNumber(
  "JIT_MAX_REQUEST_BYTES",
  16 * 1024 * 1024,
  1024,
  256 * 1024 * 1024,
  true,
);
export const MAX_SKILL_BYTES = envNumber(
  "JIT_MAX_SKILL_BYTES",
  2 * 1024 * 1024,
  1024,
  32 * 1024 * 1024,
  true,
);

// Plain defaults. Environment overrides are applied in `loadConfig`, so a
// default here is never env-derived and the two can be read independently.
export const DEFAULT_CONFIG: Config = {
  embedding_provider: "local",
  embedding_local_model: "Xenova/bge-small-en-v1.5",
  embedding_local_dim: 384,
  embedding_api_key: "",
  embedding_api_base: "",
  embedding_api_model: "",
  embedding_api_dim: 1536,
  rerank_api_key: "",
  rerank_api_base: "",
  rerank_model: "",
  api_key: "",
  confidence_threshold: 0.6,
  first_run: true,
};

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedInteger(value: unknown, max: number): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : undefined;
}

function unitInterval(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
}

interface ConfigField {
  /** Environment variable that overrides this key; omit when there is none. */
  env?: string;
  /**
   * Parse a raw value from `config.json` or an environment variable. Returning
   * `undefined` rejects it, so the default (or the previously stored value) is
   * kept. Both sources share one parser, so the file and the environment can
   * never drift apart.
   */
  parse?: (raw: unknown) => unknown;
}

/**
 * Every `Config` key described once. `Record<keyof Config, ...>` means adding a
 * key without a rule is a compile error rather than a silent gap.
 */
const CONFIG_FIELDS: Record<keyof Config, ConfigField> = {
  embedding_provider: {
    env: "JIT_EMBEDDING_PROVIDER",
    parse: (raw) =>
      raw === "local" || raw === "openai-compatible" ? raw : undefined,
  },
  embedding_local_model: { env: "JIT_EMBEDDING_MODEL", parse: textValue },
  embedding_local_dim: {
    env: "JIT_EMBEDDING_DIM",
    parse: (raw) => boundedInteger(raw, MAX_EMBEDDING_DIM),
  },
  embedding_api_key: { env: "JIT_EMBEDDING_API_KEY", parse: textValue },
  embedding_api_base: { env: "JIT_EMBEDDING_API_BASE", parse: textValue },
  embedding_api_model: { env: "JIT_EMBEDDING_API_MODEL", parse: textValue },
  embedding_api_dim: {
    env: "JIT_EMBEDDING_API_DIM",
    parse: (raw) => boundedInteger(raw, MAX_EMBEDDING_DIM),
  },
  rerank_api_key: { env: "JIT_RERANK_API_KEY", parse: textValue },
  rerank_api_base: { env: "JIT_RERANK_API_BASE", parse: textValue },
  rerank_model: { env: "JIT_RERANK_MODEL", parse: textValue },
  api_key: { env: "JIT_API_KEY", parse: textValue },
  confidence_threshold: { env: "JIT_CONFIDENCE_THRESHOLD", parse: unitInterval },
  first_run: { parse: (raw) => (typeof raw === "boolean" ? raw : undefined) },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as Array<keyof Config>;

export function ensureJitDir(): void {
  mkdirSync(INDEX_DIR, { recursive: true });
}

export function atomicWriteFile(
  file: string,
  contents: string,
  mode = 0o600,
): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, contents, { encoding: "utf8", mode });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return (data ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function readStoredConfig(): Partial<Config> {
  // Fail closed like readIndex: a corrupt config must not silently become the
  // defaults — that would turn auth off — and the next save would overwrite
  // the file for good, taking the stored credentials and endpoints with it.
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `config.json is corrupt; fix or remove it, then restart: ${CONFIG_FILE}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const rawRecord = parsed as Record<string, unknown>;
  const stored: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (!(key in rawRecord)) continue;
    const value = CONFIG_FIELDS[key].parse?.(rawRecord[key]);
    if (value !== undefined) stored[key] = value;
  }
  return stored as Partial<Config>;
}

// `loadConfig` is on the hot path (every API request, the auth check, every
// retrieval). Avoid re-reading and re-parsing config.json when it has not
// changed on disk. `saveConfig` invalidates this explicitly.
let storedConfigCache: {
  mtimeMs: number;
  size: number;
  value: Partial<Config>;
} | null = null;

function readStoredConfigCached(): Partial<Config> {
  let stat;
  try {
    stat = statSync(CONFIG_FILE);
  } catch {
    storedConfigCache = null;
    return {};
  }
  if (
    storedConfigCache &&
    storedConfigCache.mtimeMs === stat.mtimeMs &&
    storedConfigCache.size === stat.size
  ) {
    return storedConfigCache.value;
  }
  const value = readStoredConfig();
  storedConfigCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

export function loadConfig(): Config {
  const config: Config = { ...DEFAULT_CONFIG, ...readStoredConfigCached() };

  // The environment wins over config.json for every key that declares it.
  for (const key of CONFIG_KEYS) {
    const envName = CONFIG_FIELDS[key].env;
    if (!envName) continue;
    const raw = process.env[envName];
    if (raw === undefined || raw === "") continue;
    const value = CONFIG_FIELDS[key].parse?.(raw);
    if (value !== undefined) {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }

  config.first_run = Boolean(config.first_run);
  config.confidence_threshold =
    unitInterval(config.confidence_threshold) ??
    DEFAULT_CONFIG.confidence_threshold;
  return config;
}

export interface ActiveEmbeddingSettings {
  provider: Config["embedding_provider"];
  apiKey: string;
  apiBase: string;
  model: string;
  dimensions: number;
}

export function getEmbeddingSettings(
  config = loadConfig(),
): ActiveEmbeddingSettings {
  if (config.embedding_provider === "openai-compatible") {
    return {
      provider: config.embedding_provider,
      apiKey: config.embedding_api_key,
      apiBase: config.embedding_api_base,
      model: config.embedding_api_model,
      dimensions: config.embedding_api_dim,
    };
  }
  return {
    provider: "local",
    // The built-in local model runs offline; it never takes a key, even if a
    // stale embedding_api_key is still stored in the config.
    apiKey: "",
    apiBase: "",
    model: config.embedding_local_model,
    dimensions: config.embedding_local_dim,
  };
}

/** True when the embeddings dimension was deliberately configured — config.json
 *  or the JIT_EMBEDDING_API_DIM env — as opposed to riding the built-in
 *  default. `dimensions` is an OpenAI extension that strict OpenAI-compatible
 *  servers reject as an unknown field, so the client only sends it when it was
 *  actually pinned. */
export function embeddingDimExplicit(): boolean {
  if (process.env.JIT_EMBEDDING_API_DIM) return true;
  // Read the raw stored config: a user-pinned value equal to the default is
  // still pinned, and loadConfig() would have merged it away.
  return readStoredConfig().embedding_api_dim !== undefined;
}

export function embeddingSignature(): string {
  const { provider, apiBase, model, dimensions } = getEmbeddingSettings();
  return JSON.stringify({ provider, apiBase, model, dimensions });
}

export function saveConfig(updates: Partial<Config>): Config {
  const stored = readStoredConfig();
  for (const [key, value] of Object.entries(updates) as Array<
    [keyof Config, unknown]
  >) {
    if (value !== undefined && value !== null) {
      (stored as Record<string, unknown>)[key] = value;
    }
  }
  ensureJitDir();
  atomicWriteFile(CONFIG_FILE, JSON.stringify(stored, null, 2) + "\n", 0o600);
  storedConfigCache = null;
  return loadConfig();
}

export function publicConfig(): PublicConfig {
  const config = loadConfig();
  const redacted: PublicConfig = {
    ...config,
    embedding_api_key: config.embedding_api_key
      ? `***${config.embedding_api_key.slice(-4)}`
      : "",
    rerank_api_key: config.rerank_api_key
      ? `***${config.rerank_api_key.slice(-4)}`
      : "",
    api_key: config.api_key ? `***${config.api_key.slice(-4)}` : "",
    auth_env: Boolean(process.env.JIT_API_KEY),
    auth_enabled: Boolean(config.api_key),
    index_dir: INDEX_DIR,
    embedding_model: getEmbeddingSettings(config).model,
    embedding_dim: getEmbeddingSettings(config).dimensions,
    embedding_provider_env: Boolean(process.env.JIT_EMBEDDING_PROVIDER),
    embedding_key_env: Boolean(process.env.JIT_EMBEDDING_API_KEY),
    embedding_base_env: Boolean(process.env.JIT_EMBEDDING_API_BASE),
    embedding_model_env:
      config.embedding_provider === "local"
        ? Boolean(process.env.JIT_EMBEDDING_MODEL)
        : Boolean(process.env.JIT_EMBEDDING_API_MODEL),
    embedding_dim_env:
      config.embedding_provider === "local"
        ? Boolean(process.env.JIT_EMBEDDING_DIM)
        : Boolean(process.env.JIT_EMBEDDING_API_DIM),
    rerank_key_env: Boolean(process.env.JIT_RERANK_API_KEY),
    rerank_base_env: Boolean(process.env.JIT_RERANK_API_BASE),
    rerank_model_env: Boolean(process.env.JIT_RERANK_MODEL),
  };
  return redacted;
}


