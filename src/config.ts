import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
export const MARKETPLACE_FILE = path.join(PACKAGE_ROOT, "marketplace.json");

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

export const DEFAULT_NEBIUS_API_BASE =
  process.env.NEBIUS_API_BASE || "https://api.studio.nebius.ai/v1";
export const DEFAULT_NEBIUS_API_KEY = process.env.NEBIUS_API_KEY || "";
export const DEFAULT_NEMOTRON_NANO_MODEL =
  process.env.NEMOTRON_NANO_MODEL || "nvidia/nemotron-nano-9b-v2";
export const DEFAULT_NEMOTRON_ULTRA_MODEL =
  process.env.NEMOTRON_ULTRA_MODEL || "nvidia/nemotron-3-ultra";

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
  nebius_api_key: DEFAULT_NEBIUS_API_KEY,
  nebius_api_base: DEFAULT_NEBIUS_API_BASE,
  nemotron_nano_model: DEFAULT_NEMOTRON_NANO_MODEL,
  nemotron_ultra_model: DEFAULT_NEMOTRON_ULTRA_MODEL,
  api_key: "",
  rerank_enabled: true,
  first_run: true,
};

const FILE_KEYS = new Set<keyof Config>([
  "nebius_api_key",
  "nebius_api_base",
  "nemotron_nano_model",
  "nemotron_ultra_model",
  "api_key",
  "rerank_enabled",
  "first_run",
]);

const ENV_KEYS: Partial<Record<keyof Config, string>> = {
  nebius_api_key: "NEBIUS_API_KEY",
  nebius_api_base: "NEBIUS_API_BASE",
  nemotron_nano_model: "NEMOTRON_NANO_MODEL",
  nemotron_ultra_model: "NEMOTRON_ULTRA_MODEL",
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
    if (key === "rerank_enabled" || key === "first_run") {
      if (typeof value === "boolean") {
        (stored as Record<string, unknown>)[key] = value;
      }
      continue;
    }
    if (typeof value === "string") {
      (stored as Record<string, unknown>)[key] = value;
    }
  }
  return stored;
}

export function loadConfig(): Config {
  const config: Config = { ...DEFAULT_CONFIG, ...readStoredConfig() };
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
  config.nebius_api_base =
    config.nebius_api_base || DEFAULT_NEBIUS_API_BASE;
  config.nemotron_nano_model =
    config.nemotron_nano_model || DEFAULT_NEMOTRON_NANO_MODEL;
  config.nemotron_ultra_model =
    config.nemotron_ultra_model || DEFAULT_NEMOTRON_ULTRA_MODEL;
  return config;
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
    nebius_api_key: config.nebius_api_key
      ? `***${config.nebius_api_key.slice(-4)}`
      : "",
    api_key: config.api_key ? `***${config.api_key.slice(-4)}` : "",
    nebius_key_env: Boolean(process.env.NEBIUS_API_KEY),
    auth_env: Boolean(process.env.JIT_API_KEY),
    auth_enabled: Boolean(config.api_key),
    index_dir: INDEX_DIR,
    embedding_model: EMBEDDING_MODEL,
  };
  redacted.rerank_enabled =
    Boolean(config.nebius_api_key) && Boolean(config.rerank_enabled);
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
