import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
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
  (process.env.JIT_HOME || path.join(homedir(), ".jit")).replace(/^~(?=$|\/)/, homedir()),
);
export const META_DB = path.join(INDEX_DIR, "skills.db");
export const CONFIG_FILE = path.join(INDEX_DIR, "config.json");
export const MCP_CONFIG = path.join(INDEX_DIR, "mcp.json");
export const JIT_SKILLS_DIR = path.join(INDEX_DIR, "skills");
export const MODEL_CACHE_DIR = path.resolve(
  (process.env.JIT_MODEL_CACHE || path.join(INDEX_DIR, "models")).replace(
    /^~(?=$|\/)/,
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

export const CONFIDENCE_THRESHOLD = envNumber(
  "JIT_CONFIDENCE_THRESHOLD",
  0.6,
  0,
  1,
);
export const TOP_K_RETRIEVE = envNumber("JIT_TOP_K", 20, 1, 1000, true);

// Transformers.js needs an ONNX-converted model. The BAAI repository is the
// source model; Xenova/bge-small-en-v1.5 is the compatible local export.
export const EMBEDDING_MODEL =
  process.env.JIT_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = envNumber("JIT_EMBEDDING_DIM", 384, 1, 16384, true);
export const EMBEDDING_SIGNATURE_KEY = "embedding_signature";
const DEFAULT_EMBEDDING_PROVIDER =
  process.env.JIT_EMBEDDING_PROVIDER === "openai-compatible"
    ? "openai-compatible"
    : "local";

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

export const DEFAULT_CONFIG: Config = {
  embedding_provider: DEFAULT_EMBEDDING_PROVIDER,
  embedding_local_model: EMBEDDING_MODEL,
  embedding_local_dim: EMBEDDING_DIM,
  embedding_api_key: process.env.JIT_EMBEDDING_API_KEY || "",
  embedding_api_base: process.env.JIT_EMBEDDING_API_BASE || "",
  embedding_api_model: process.env.JIT_EMBEDDING_API_MODEL || "",
  embedding_api_dim: envNumber("JIT_EMBEDDING_API_DIM", 1536, 1, 16384, true),
  rerank_api_key: process.env.JIT_RERANK_API_KEY || "",
  rerank_api_base: "",
  rerank_model: "",
  api_key: "",
  rerank_enabled: false,
  confidence_threshold: CONFIDENCE_THRESHOLD,
  first_run: true,
  marketplace_urls: [],
  skillspector_llm_enabled: false,
};

const FILE_KEYS = new Set<keyof Config>([
  "embedding_provider",
  "embedding_local_model",
  "embedding_local_dim",
  "embedding_api_key",
  "embedding_api_base",
  "embedding_api_model",
  "embedding_api_dim",
  "rerank_api_key",
  "rerank_api_base",
  "rerank_model",
  "api_key",
  "rerank_enabled",
  "confidence_threshold",
  "first_run",
  "marketplace_urls",
  "skillspector_llm_enabled",
]);

const ENV_KEYS: Partial<Record<keyof Config, string>> = {
  embedding_api_key: "JIT_EMBEDDING_API_KEY",
  embedding_api_base: "JIT_EMBEDDING_API_BASE",
  embedding_api_model: "JIT_EMBEDDING_API_MODEL",
  rerank_api_key: "JIT_RERANK_API_KEY",
  rerank_api_base: "JIT_RERANK_API_BASE",
  rerank_model: "JIT_RERANK_MODEL",
  api_key: "JIT_API_KEY",
};

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
  const parsed = readJsonFile<unknown>(CONFIG_FILE, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const raw = parsed as Record<string, unknown>;
  const stored: Partial<Config> = {};
  for (const key of FILE_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (key === "embedding_provider") {
      if (value === "local" || value === "openai-compatible") {
        stored.embedding_provider = value;
      }
      continue;
    }
    if (key === "embedding_local_dim" || key === "embedding_api_dim") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 16384) {
        stored[key] = parsed;
      }
      continue;
    }
    if (
      key === "rerank_enabled" ||
      key === "first_run" ||
      key === "skillspector_llm_enabled"
    ) {
      if (typeof value === "boolean") {
        (stored as Record<string, unknown>)[key] = value;
      }
      continue;
    }
    if (key === "confidence_threshold") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        stored.confidence_threshold = parsed;
      }
      continue;
    }
    if (typeof value === "string") {
      (stored as Record<string, unknown>)[key] = value;
    }
  }
  if (Array.isArray(raw.marketplace_urls)) {
    stored.marketplace_urls = raw.marketplace_urls
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  return stored;
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
  for (const [key, envName] of Object.entries(ENV_KEYS) as Array<
    [keyof Config, string]
  >) {
    const value = process.env[envName];
    if (value) {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  config.first_run = Boolean(config.first_run);
  config.rerank_enabled = Boolean(config.rerank_enabled);
  const scannerLlmEnv = process.env.JIT_SKILLSPECTOR_LLM;
  if (scannerLlmEnv !== undefined && scannerLlmEnv.trim() !== "") {
    config.skillspector_llm_enabled = ["1", "true", "yes", "on"].includes(
      scannerLlmEnv.trim().toLowerCase(),
    );
  }
  if (process.env.JIT_EMBEDDING_PROVIDER === "local" ||
      process.env.JIT_EMBEDDING_PROVIDER === "openai-compatible") {
    config.embedding_provider = process.env.JIT_EMBEDDING_PROVIDER;
  }
  const localModelEnv = process.env.JIT_EMBEDDING_MODEL;
  if (localModelEnv) config.embedding_local_model = localModelEnv;
  const localDimEnv = Number(process.env.JIT_EMBEDDING_DIM);
  if (
    process.env.JIT_EMBEDDING_DIM &&
    Number.isInteger(localDimEnv) &&
    localDimEnv >= 1 &&
    localDimEnv <= 16384
  ) {
    config.embedding_local_dim = localDimEnv;
  }
  const apiDimEnv = Number(process.env.JIT_EMBEDDING_API_DIM);
  if (
    process.env.JIT_EMBEDDING_API_DIM &&
    Number.isInteger(apiDimEnv) &&
    apiDimEnv >= 1 &&
    apiDimEnv <= 16384
  ) {
    config.embedding_api_dim = apiDimEnv;
  }
  const envThreshold = Number(process.env.JIT_CONFIDENCE_THRESHOLD);
  if (process.env.JIT_CONFIDENCE_THRESHOLD && Number.isFinite(envThreshold)) {
    config.confidence_threshold = envThreshold;
  }
  config.confidence_threshold = Number.isFinite(Number(config.confidence_threshold))
    ? Math.min(1, Math.max(0, Number(config.confidence_threshold)))
    : CONFIDENCE_THRESHOLD;
  const envUrls = (process.env.JIT_MARKETPLACE_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (envUrls.length) {
    config.marketplace_urls = [...new Set([...(config.marketplace_urls || []), ...envUrls])];
  }
  config.marketplace_urls = Array.isArray(config.marketplace_urls)
    ? config.marketplace_urls.map((value) => String(value).trim()).filter(Boolean)
    : [];
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
    apiKey: "",
    apiBase: "",
    model: config.embedding_local_model,
    dimensions: config.embedding_local_dim,
  };
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
    if (FILE_KEYS.has(key) && value !== undefined && value !== null) {
      (stored as Record<string, unknown>)[key] = value;
    }
  }
  ensureJitDir();
  atomicWriteFile(CONFIG_FILE, JSON.stringify(stored, null, 2) + "\n", 0o600);
  storedConfigCache = null;
  return loadConfig();
}

export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
  return loadConfig()[key];
}

export function isFirstRun(): boolean {
  return Boolean(loadConfig().first_run);
}

export function completeFirstRun(): void {
  saveConfig({ first_run: false });
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
    skillspector_llm_env:
      process.env.JIT_SKILLSPECTOR_LLM !== undefined &&
      process.env.JIT_SKILLSPECTOR_LLM.trim() !== "",
    rerank_key_env: Boolean(process.env.JIT_RERANK_API_KEY),
    rerank_base_env: Boolean(process.env.JIT_RERANK_API_BASE),
    rerank_model_env: Boolean(process.env.JIT_RERANK_MODEL),
  };
  redacted.rerank_enabled = Boolean(config.rerank_enabled);
  return redacted;
}

export function configFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify(loadConfig()))
    .digest("hex");
}

export function isPosix(): boolean {
  return platform() !== "win32";
}
