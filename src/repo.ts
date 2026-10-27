import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { REPOS_DIR } from "./config.js";

/** One depth-1 clone, nothing more. JIT never executes repo content — the
 *  files are only read, indexed, and served as text. */
export interface CloneResult {
  repo: string;
  dir: string;
}

/** Normalize "owner/repo", a GitHub URL, or any https git URL to a clone URL
 *  plus a folder name under the repo cache. `file://` and bare local paths
 *  are rejected: the import tab already indexes local folders, and this
 *  route exists for pulling from remotes. */
export function normalizeRepo(rawInput: string): { url: string; name: string } {
  const input = String(rawInput || "").trim();
  if (!input) throw new Error("repository url required");
  const shorthand = input.match(/^[A-Za-z0-9][A-Za-z0-9._-]*\/([A-Za-z0-9._-]+)$/);
  if (shorthand && shorthand[1]) {
    return { url: `https://github.com/${input}.git`, name: shorthand[1] };
  }
  const scpLike = input.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  const httpsLike = input.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (httpsLike) {
    const tail = (httpsLike[2] || "").split("/").filter(Boolean);
    const name = tail[tail.length - 1] || "repo";
    return { url: `https://${httpsLike[1]}/${tail.join("/")}.git`, name };
  }
  if (scpLike) {
    const scpName = (scpLike[2] || "").split("/").pop() || "repo";
    return {
      url: `https://${scpLike[1]}/${scpLike[2]}.git`,
      name: scpName,
    };
  }
  throw new Error(
    "use a github repo (owner/name), an https clone url, or a git@ url",
  );
}

function runGit(args: string[], cwd?: string): void {
  try {
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0]} failed: ${message.slice(0, 400)}`);
  }
}

/** Clone (or refresh) a skill repo into JIT's repo cache and return the local
 *  path — the transfer picker takes it from there, exactly like any folder. */
export function cloneRepo(rawInput: string): CloneResult {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error("git is not installed or not on PATH");
  }
  const { url, name } = normalizeRepo(rawInput);
  mkdirSync(REPOS_DIR, { recursive: true });
  const dir = path.join(REPOS_DIR, name);
  if (existsSync(path.join(dir, ".git"))) {
    // Already cloned: a pull keeps it current without deleting anything.
    runGit(["pull", "--ff-only"], dir);
  } else {
    if (existsSync(dir)) {
      throw new Error(
        `${dir} already exists but is not a git clone; remove it and retry`,
      );
    }
    runGit(["clone", "--depth", "1", url, dir]);
  }
  return { repo: url, dir };
}
