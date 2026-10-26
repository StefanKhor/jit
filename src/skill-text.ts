import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import matter from "gray-matter";

import { MAX_SKILL_BYTES } from "./config.js";
import type { IndexItem } from "./types.js";

/**
 * Reading a skill file: frontmatter in, metadata and body out.
 *
 * A skill is a file on disk, and that file stays the source of truth. The index
 * keeps the metadata and the vector; it does not keep a copy of the body, so a
 * lookup re-reads the body from here. That keeps one copy of the text — the one
 * the agent may also read a sibling of — instead of a stored copy that drifts
 * the moment someone edits a SKILL.md.
 *
 * This lives apart from the indexer on purpose: the store has to read a body,
 * and the indexer imports the store.
 */
export function parseSkillText(
  text: string,
  sourcePath = "",
  fallbackName = "inline-skill",
): IndexItem {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) {
    throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  const parsed = matter(text);
  const meta = (parsed.data || {}) as Record<string, unknown>;
  const body = (parsed.content || "").trim();

  let name = String(meta.name || "").trim();
  if (!name) {
    if (sourcePath && path.basename(sourcePath) === "SKILL.md") {
      name = path.basename(path.dirname(sourcePath));
    } else if (sourcePath) {
      name = path.basename(sourcePath, path.extname(sourcePath));
    } else {
      name = fallbackName;
    }
  }
  name = name.replace(/[\\/]+/g, "-");
  const title = String(meta.title || name).trim();
  const description =
    String(meta.description || "").trim() ||
    body.slice(0, 120).replace(/\n/g, " ").trim() ||
    "No description";
  return {
    id: name,
    name: title || name,
    description,
    body,
    path: sourcePath,
  };
}

export function parseSkillFile(file: string): IndexItem {
  const stat = statSync(file);
  if (stat.size > MAX_SKILL_BYTES) {
    throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  return parseSkillText(readFileSync(file, "utf8"), file);
}

/**
 * The body of a skill file, or "" when it cannot be read.
 *
 * Lookups read the body from disk rather than from the index, so a file that
 * was moved or deleted since the last scan has to degrade to "no content"
 * instead of throwing in the middle of retrieval.
 */
export function readSkillBody(file: string): string {
  try {
    return parseSkillFile(file).body;
  } catch {
    return "";
  }
}
