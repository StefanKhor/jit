import fs from "node:fs";
import path from "node:path";

import { INDEX_DIR } from "./config.js";
import type { RetrievalTrace } from "./types.js";

// Cross-process lookup log. The stdio MCP server and the dashboard are
// separate processes, so agent-invoked lookups land in one JSONL file under
// JIT_HOME rather than either process's memory — the dashboard can then show
// what agents actually asked and how the pipeline answered. Metadata only:
// intents, verdicts, timings and the retrieval trace. Never skill bodies.

export interface LookupRecord {
  ts: string; // ISO timestamp
  tool: "JIT_FIND" | "JIT_RUN";
  intent?: string; // JIT_FIND: what the agent searched for
  name?: string; // JIT_RUN: the exact name requested
  found: boolean;
  results?: string[]; // hit names, bodies excluded
  near_misses?: string[];
  close_matches?: string[];
  warning?: string;
  ms: number;
  trace?: RetrievalTrace; // JIT_FIND only; same shape the Search page renders
}

const LOG_PATH = path.join(INDEX_DIR, "lookups.jsonl");

// Tail cap: reads trim the file back to this many records so it cannot grow
// without limit.
const MAX_RECORDS = 500;

export function logLookup(record: LookupRecord): void {
  try {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  } catch (error) {
    // The log is a debugging aid; a failed append must never fail a lookup.
    console.warn("lookup log write failed:", error);
  }
}

/** Newest first. Trims the file to the last MAX_RECORDS entries on read. */
export function readLookups(limit = 100): LookupRecord[] {
  let lines: string[] = [];
  try {
    const text = fs.readFileSync(LOG_PATH, "utf8");
    lines = text.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
  if (lines.length > MAX_RECORDS) {
    lines = lines.slice(-MAX_RECORDS);
    try {
      fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n");
    } catch {
      // Trimming is best-effort; next read retries.
    }
  }
  const records: LookupRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as LookupRecord);
    } catch {
      // A torn or partial line (crash mid-append) is skipped, not fatal.
    }
  }
  return records.slice(-limit).reverse();
}
