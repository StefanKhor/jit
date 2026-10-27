import { readLookups } from "./lookups.js";
import { getAllItems } from "./storage/store.js";
import type { UsageEntry, UsageSummary } from "./types.js";

// Usage telemetry: what agents actually routed, computed from the shared
// lookup log. A JIT_FIND that returned entries counts one find per returned
// entry (that is how often the agent was handed that entry); a JIT_RUN counts
// one run for its exact name. Entries the index holds but no lookup reached
// are the actionable half of the report: candidates to disable, re-describe,
// or delete.

const MAX_LISTED = 12;
const MAX_MISSED = 6;

export function buildUsageSummary(): UsageSummary {
  const records = readLookups(500); // newest first; the log's own window

  const counts = new Map<string, UsageEntry>();
  const touch = (name: string, ts: string, kind: "finds" | "runs"): void => {
    const current = counts.get(name) ?? {
      name,
      finds: 0,
      runs: 0,
      total: 0,
      last_called: null,
    };
    current[kind] += 1;
    current.total += 1;
    if (!current.last_called || ts > current.last_called) current.last_called = ts;
    counts.set(name, current);
  };

  let finds = 0;
  let runs = 0;
  let hits = 0;
  let misses = 0;
  const missed = new Map<string, { intent: string; count: number; last: string }>();

  for (const record of records) {
    const ts = record.ts || "";
    if (record.found) hits += 1;
    else misses += 1;

    if (record.tool === "JIT_RUN") {
      if (record.name) {
        runs += 1;
        touch(record.name, ts, "runs");
      }
      continue;
    }

    finds += 1;
    for (const name of record.results ?? []) touch(name, ts, "finds");
    if (!record.found && record.intent) {
      const key = record.intent.trim().toLowerCase();
      if (key) {
        const current = missed.get(key) ?? {
          intent: record.intent.trim(),
          count: 0,
          last: ts,
        };
        current.count += 1;
        if (ts > current.last) current.last = ts;
        missed.set(key, current);
      }
    }
  }

  const entries = [...counts.values()]
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, MAX_LISTED);

  const called = new Set(counts.keys());
  const neverCalled = getAllItems()
    .map((item) => item.name)
    .filter((name) => !called.has(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LISTED * 2);

  const missedIntents = [...missed.values()]
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, MAX_MISSED);

  const timestamps = records.map((record) => record.ts).filter(Boolean).sort();
  const totalLookups = records.length;

  return {
    window: totalLookups,
    total_lookups: totalLookups,
    finds,
    runs,
    hits,
    misses,
    hit_rate: totalLookups ? hits / totalLookups : 0,
    span: {
      first: timestamps[0] ?? null,
      last: timestamps[timestamps.length - 1] ?? null,
    },
    entries,
    never_called: neverCalled,
    missed_intents: missedIntents,
  };
}
