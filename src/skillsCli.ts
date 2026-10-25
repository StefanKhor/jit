import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { INDEX_DIR } from "./config.js";
import { logger } from "./logger.js";

// Repository sources are resolved by the open `skills` CLI
// (github.com/vercel-labs/skills), which owns source resolution, repository
// layouts, downloads, and its own install directory. JIT does not reimplement
// any of that: it runs the CLI into a cache directory and imports the result
// into its own store.
const CLI_VERSION = (process.env.JIT_SKILLS_CLI_VERSION || "1.7.4").trim();
const CLI_COMMAND = (
  process.env.JIT_SKILLS_CLI || `npx --yes skills@${CLI_VERSION}`
).trim();

const CACHE_DIR = path.join(INDEX_DIR, "marketplace");
const CACHE_TTL_MS = 300_000;
const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** The CLI installs to `<cwd>/.agents/skills/` for the `universal` agent. */
const INSTALL_ROOT = path.join(".agents", "skills");
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface CliSkill {
  /** Directory name the CLI used for the skill. */
  name: string;
  /** Absolute path of the materialized skill directory. */
  path: string;
  /** Content hash the CLI reported, or an empty string. */
  hash: string;
}

export interface CliResult {
  skills: CliSkill[];
  warning: string;
}

const cache = new Map<string, { at: number; result: CliResult; dir: string }>();

function cacheKey(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function command(): string[] {
  // Respect double quotes so a command such as
  // `"C:\Program Files\nodejs\node.exe" script.mjs` survives the split.
  const parts = (CLI_COMMAND.match(/"[^"]*"|\S+/g) || []).map((part) =>
    part.replace(/^"|"$/g, ""),
  );
  if (parts.length === 0) throw new Error("JIT_SKILLS_CLI is empty");
  return parts;
}

function quote(part: string): string {
  // Every argument reaching this point is a validated source reference or skill
  // name, so none can contain a quote; only whitespace needs handling.
  return /\s/.test(part) ? `"${part}"` : part;
}

interface ExecuteResult {
  stdout: string;
  stderr: string;
  error?: Error;
}

function execute(args: string[], cwd: string): Promise<ExecuteResult> {
  const parts = command();
  const env = {
    ...process.env,
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    // The CLI looks for GITHUB_TOKEN / GH_TOKEN; let JIT's own variable feed it.
    ...(process.env.GITHUB_TOKEN || !process.env.JIT_GITHUB_TOKEN
      ? {}
      : { GITHUB_TOKEN: process.env.JIT_GITHUB_TOKEN }),
  };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const child =
      process.platform === "win32"
        ? // cmd.exe resolves npx to npx.cmd. Sources and skill names have been
          // validated before reaching this call; quote arguments for cmd.exe.
          spawn([...parts, ...args].map(quote).join(" "), {
            cwd,
            env,
            windowsHide: true,
            shell: true,
          })
        : spawn(parts[0] as string, [...parts.slice(1), ...args], {
            cwd,
            env,
            windowsHide: true,
          });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...(error ? { error } : {}) });
    };

    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`skills CLI timed out after ${Math.round(TIMEOUT_MS / 1000)}s`));
    }, TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("skills CLI output exceeded the size limit"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            signal
              ? `skills CLI was terminated by ${signal}`
              : `skills CLI exited with code ${String(code)}`,
          ),
        );
      }
    });
  });
}

function readJson(stdout: string): Array<Record<string, unknown>> | null {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function firstLine(stderr: string, fallback: string): string {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => line && !/^[|│▕▏]*\s*$/.test(line))
    .slice(-2)
    .join(" ")
    .trim();
  return detail || fallback;
}

/**
 * Materialize the skills a source provides, by running the `skills` CLI in a
 * cache directory. Pass `skill` to materialize a single skill instead of the
 * whole repository; the CLI only writes that directory, so the copy step later
 * has nothing else to pick from. Results are reused for a few minutes so a page
 * load does not re-clone the repository.
 */
export async function materializeSource(
  source: string,
  skill = "",
): Promise<CliResult> {
  const scope = String(skill || "").trim();
  // The cache is keyed by the scope too, so listing a repository and installing
  // one of its skills do not overwrite each other's directory.
  const key = scope ? `${source}\u0000${scope}` : source;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS && existsSync(hit.dir)) {
    return hit.result;
  }

  // Reuse the stable directory when it can be cleared. On Windows, antivirus
  // scanners or another process can briefly hold a file in the old checkout;
  // that must not make the entire source unavailable. Fall back to a fresh
  // sibling directory when cleanup is blocked.
  const dir = hit?.dir || path.join(CACHE_DIR, cacheKey(key));
  let useDir = dir;
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
      throw error;
    }
    useDir = path.join(
      CACHE_DIR,
      `${cacheKey(key)}-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
  }
  mkdirSync(useDir, { recursive: true });
  const result = await execute(
    [
      "add",
      source,
      "--skill",
      scope || "*",
      "-a",
      "universal",
      "--copy",
      "-y",
      "--json",
    ],
    useDir,
  );
  const entries = readJson(result.stdout || "");
  if (!entries) {
    throw new Error(
      `the skills CLI returned no result: ${firstLine(
        result.stderr || "",
        result.error?.message || "no output",
      )}`,
    );
  }

  const root = path.resolve(useDir, INSTALL_ROOT);
  const skills: CliSkill[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    const name = String(entry.name || "").trim();
    if (String(entry.status || "") !== "installed") {
      const reason = String(entry.reason || "").trim();
      notes.push(`${name || "entry"}: ${reason || "not installed"}`);
      continue;
    }
    const resolved = path.resolve(String(entry.path || ""));
    // The path comes from our own child process, but never copy from outside
    // the directory we asked it to install into.
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      notes.push(`${name || "entry"}: unexpected install path`);
      continue;
    }
    if (!existsSync(path.join(resolved, "SKILL.md"))) {
      notes.push(`${name || "entry"}: no SKILL.md`);
      continue;
    }
    skills.push({
      name,
      path: resolved,
      hash: String(entry.hash || "").trim(),
    });
  }
  if (skills.length === 0 && notes.length === 0) {
    notes.push(
      scope
        ? `${source} does not provide '${scope}'`
        : `${source} provides no installable skills`,
    );
  }

  const payload: CliResult = { skills, warning: notes.join("; ") };
  cache.set(key, { at: now, result: payload, dir: useDir });
  if (payload.warning) logger.warn("skills CLI: %s", payload.warning);
  logger.debug("skills CLI %s %s: %d skills", source, scope || "*", skills.length);
  return payload;
}
