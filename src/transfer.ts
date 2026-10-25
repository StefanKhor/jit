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
import { initDb } from "./storage/db.js";
import type {
  ExportSkillsResult,
  IndexItem,
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

  return { exported, skipped, errors, destination: dest };
}

export async function removeSkillCopy(id: string): Promise<boolean> {
  const item = getItem(initDb(), id);
  if (!item) return false;
  let fileRemoved = false;
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
}
