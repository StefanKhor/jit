// Retrieval quality harness. The weakest part of JIT is that nobody can verify
// retrieval, so this measures recall@1, recall@3, MRR, and a threshold sweep
// against a labeled query set.
//
// Default: seed a throwaway index from eval/fixture.jsonl and run
// eval/queries.jsonl, so `npm run eval` works with no setup and no network.
//
// Against a real index:
//   npm run eval -- --home ~/.jit --queries path/to/queries.jsonl
//
// Queries file: JSONL of {"query": "...", "expected": "id" | ["id", ...]}.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, "utf8");
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    rows.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return rows;
}

const queriesPath = path.resolve(
  arg("--queries", path.join(ROOT, "eval", "queries.jsonl")),
);
const homeArg = arg("--home", "");
const home = homeArg
  ? path.resolve(homeArg.replace(/^~(?=$|[/\\])/, homedir()))
  : mkdtempSync(path.join(tmpdir(), "jit-eval-"));
process.env.JIT_HOME = home;

const { indexItems } = await import("../src/indexer.js");
const { evaluate } = await import("../src/retrieval/retriever.js");
const { getStats } = await import("../src/storage/db.js");

if (!homeArg) {
  const fixturePath = path.join(ROOT, "eval", "fixture.jsonl");
  if (!existsSync(fixturePath)) {
    console.error(`fixture not found: ${fixturePath}`);
    process.exit(1);
  }
  const items = readJsonl(fixturePath).map((row) => ({
    id: String(row.id),
    name: String(row.name || row.id),
    description: String(row.description || ""),
    when_to_use: String(row.when_to_use || row.description || ""),
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    body: String(row.body || ""),
    path: "",
    kind: "skill" as const,
  }));
  const seeded = await indexItems(items, "skill");
  console.log(
    `seeded ${items.length} fixture entries (${seeded.added} added, ${seeded.skipped} skipped, ${seeded.errors.length} errors)`,
  );
} else {
  const stats = getStats((await import("../src/storage/db.js")).initDb());
  console.log(`evaluating index at ${home} (${stats.total} entries)`);
}

const queries = readJsonl(queriesPath).map((row) => ({
  query: String(row.query || ""),
  expected: Array.isArray(row.expected)
    ? row.expected.map(String)
    : [String(row.expected || "")].filter(Boolean),
}));

interface Row {
  query: string;
  expected: string[];
  ranked: string[];
  scores: number[];
  keywordOnly: boolean;
}

const rows: Row[] = [];
for (const entry of queries) {
  const evaluation = await evaluate(entry.query, 5);
  rows.push({
    query: entry.query,
    expected: entry.expected,
    ranked: evaluation.candidates.map((candidate) => candidate.id),
    scores: evaluation.candidates.map((candidate) => candidate.score),
    keywordOnly: evaluation.keywordOnly,
  });
}

function rankOf(row: Row): number {
  for (let index = 0; index < row.ranked.length; index += 1) {
    if (row.expected.includes(row.ranked[index] as string)) return index + 1;
  }
  return 0;
}

function metricsAt(threshold: number): {
  hits: number;
  correct: number;
  precision: number;
  recall: number;
  f1: number;
} {
  let hits = 0;
  let correct = 0;
  for (const row of rows) {
    const top = row.ranked[0];
    const score = row.scores[0] ?? 0;
    if (top && score >= threshold) {
      hits += 1;
      if (row.expected.includes(top)) correct += 1;
    }
  }
  const total = rows.length || 1;
  const precision = hits ? correct / hits : 0;
  const recall = correct / total;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { hits, correct, precision, recall, f1 };
}

const recall1 = rows.filter((row) => rankOf(row) === 1).length / (rows.length || 1);
const recall3 = rows.filter((row) => {
  const rank = rankOf(row);
  return rank >= 1 && rank <= 3;
}).length / (rows.length || 1);
const mrr =
  rows.reduce((sum, row) => {
    const rank = rankOf(row);
    return sum + (rank ? 1 / rank : 0);
  }, 0) / (rows.length || 1);

const effectiveThreshold = (await import("../src/config.js")).loadConfig()
  .confidence_threshold;
const atDefault = metricsAt(effectiveThreshold);

console.log("");
console.log(`queries:        ${rows.length}`);
console.log(`keyword-only:   ${rows.filter((row) => row.keywordOnly).length} (no embeddings/reranker available)`);
console.log(`recall@1:       ${(recall1 * 100).toFixed(1)}%`);
console.log(`recall@3:       ${(recall3 * 100).toFixed(1)}%`);
console.log(`MRR:            ${mrr.toFixed(3)}`);
console.log("");
console.log(`at threshold ${effectiveThreshold.toFixed(2)} (configured):`);
console.log(`  returned:     ${atDefault.hits}   correct: ${atDefault.correct}`);
console.log(`  precision:    ${(atDefault.precision * 100).toFixed(1)}%`);
console.log(`  recall:       ${(atDefault.recall * 100).toFixed(1)}%`);
console.log("");
console.log("threshold sweep (recall = correct answer returned / all queries):");
console.log("  threshold   returned   correct   precision   recall     f1");
for (const threshold of [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9]) {
  const m = metricsAt(threshold);
  console.log(
    `  ${threshold.toFixed(2).padEnd(10)}${String(m.hits).padEnd(11)}${String(m.correct).padEnd(10)}` +
      `${(m.precision * 100).toFixed(1).padStart(8)}%   ${(m.recall * 100).toFixed(1).padStart(6)}%   ${m.f1.toFixed(3)}`,
  );
}

const missed = rows.filter((row) => rankOf(row) === 0);
if (missed.length) {
  console.log("");
  console.log(`not in top 5 (${missed.length}):`);
  for (const row of missed) {
    console.log(`  "${row.query}" -> expected ${row.expected.join(", ")}, got ${row.ranked.slice(0, 3).join(", ") || "nothing"}`);
  }
}
process.exit(0);
