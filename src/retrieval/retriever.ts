import { CONFIDENCE_THRESHOLD, TOP_K_RETRIEVE } from "../config.js";
import { loadConfig } from "../config.js";
import { cosineSimilarity, embedQuery } from "../embedding.js";
import { logger } from "../logger.js";
import {
  dataVersion,
  getAllItems,
  initDb,
} from "../storage/db.js";
import type { SearchCandidate, SearchResult, StoredItem } from "../types.js";
import { BM25Index, bm25Text } from "./bm25.js";
import { nanoRerank } from "./rerank.js";

interface Corpus {
  version: string;
  items: StoredItem[];
  bm25: BM25Index | null;
  byId: Map<string, StoredItem>;
}

let cache: Corpus | null = null;

function loadCorpus(): Corpus | null {
  const db = initDb();
  try {
    const version = dataVersion(db);
    if (cache && cache.version === version) return cache;
    const items = getAllItems(db);
    const corpus: Corpus = {
      version,
      items,
      bm25: items.length ? new BM25Index(items.map(bm25Text)) : null,
      byId: new Map(items.map((item) => [item.id, item])),
    };
    cache = corpus;
    return corpus;
  } finally {
    db.close();
  }
}

function rrf(
  rankedLists: string[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranked of rankedLists) {
    ranked.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}

async function rank(
  intent: string,
  limit = TOP_K_RETRIEVE,
): Promise<{
  candidates: Array<StoredItem & { rrf: number }>;
  cosine: Map<string, number>;
}> {
  const corpus = loadCorpus();
  if (!corpus || corpus.items.length === 0) {
    return { candidates: [], cosine: new Map() };
  }

  const enabled = new Set(
    corpus.items.filter((item) => item.enabled).map((item) => item.id),
  );
  if (enabled.size === 0) return { candidates: [], cosine: new Map() };

  const bm25Hits = corpus.bm25
    ? corpus.bm25.search(intent, TOP_K_RETRIEVE * 2)
    : [];
  const bm25Ranked = bm25Hits
    .map((hit) => corpus.items[hit.index]?.id)
    .filter((id): id is string => Boolean(id && enabled.has(id)))
    .slice(0, TOP_K_RETRIEVE);

  let queryVector: Float32Array | null = null;
  try {
    queryVector = await embedQuery(intent);
  } catch (error) {
    logger.warn(
      "query embedding failed; using BM25 only: %s",
      error instanceof Error ? error.message : String(error),
    );
  }

  const cosine = new Map<string, number>();
  const vectorRanked: string[] = [];
  if (queryVector) {
    const scored = corpus.items
      .filter((item) => item.enabled && item.embedding)
      .map((item) => ({
        id: item.id,
        score: cosineSimilarity(queryVector as Float32Array, item.embedding as Float32Array),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K_RETRIEVE);
    for (const hit of scored) {
      cosine.set(hit.id, hit.score);
      vectorRanked.push(hit.id);
    }
  }

  const merged = rrf([bm25Ranked, vectorRanked]).slice(0, limit);
  const candidates: Array<StoredItem & { rrf: number }> = [];
  for (const hit of merged) {
    const item = corpus.byId.get(hit.id);
    if (item) candidates.push({ ...item, rrf: hit.score });
  }
  return { candidates, cosine };
}

export interface Evaluation {
  result: SearchResult | null;
  candidates: SearchCandidate[];
  reranked: boolean;
}

export async function evaluate(
  intent: string,
  topN = 5,
): Promise<Evaluation> {
  const empty: Evaluation = { result: null, candidates: [], reranked: false };
  if (!intent || !intent.trim()) return empty;

  const { candidates, cosine } = await rank(intent);
  if (candidates.length === 0) return empty;

  const settings = loadConfig();
  let rerankScores = new Map<string, number>();
  if (settings.nebius_api_key && settings.rerank_enabled) {
    rerankScores = await nanoRerank(intent, candidates, settings);
    if (rerankScores.size > 0) {
      candidates.sort(
        (a, b) => (rerankScores.get(b.id) || 0) - (rerankScores.get(a.id) || 0),
      );
    }
  }

  const debug: SearchCandidate[] = candidates.slice(0, topN).map((item) => {
    const cosineScore = cosine.get(item.id) || 0;
    const rerankScore = rerankScores.get(item.id);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      kind: item.kind,
      cosine: Number(cosineScore.toFixed(4)),
      rrf: Number(item.rrf.toFixed(5)),
      rerank:
        rerankScore === undefined ? null : Number(rerankScore.toFixed(4)),
      passes_threshold:
        Math.max(cosineScore, rerankScore || 0) >= CONFIDENCE_THRESHOLD,
    };
  });

  const best = candidates[0];
  if (!best) return empty;
  const confidence = Math.max(
    cosine.get(best.id) || 0,
    rerankScores.get(best.id) || 0,
  );
  if (confidence < CONFIDENCE_THRESHOLD) {
    logger.debug(
      "no match for %r (best=%s, confidence=%.3f)",
      intent,
      best.id,
      confidence,
    );
    return {
      result: null,
      candidates: debug,
      reranked: rerankScores.size > 0,
    };
  }

  const result: SearchResult = {
    id: best.id,
    name: best.name,
    kind: best.kind,
    description: best.description,
    content: best.body,
    confidence: Number(confidence.toFixed(4)),
    reranked: rerankScores.size > 0,
  };
  if (best.kind === "tool") {
    result.server = best.server || best.id.split("__", 1)[0];
    result.tool_id = best.id;
  }
  return {
    result,
    candidates: debug,
    reranked: rerankScores.size > 0,
  };
}

export async function retrieve(intent: string): Promise<SearchResult | null> {
  return (await evaluate(intent, 1)).result;
}

export async function searchDebug(
  intent: string,
  topN = 5,
): Promise<SearchCandidate[]> {
  return (await evaluate(intent, topN)).candidates;
}

export function invalidateRetrievalCache(): void {
  cache = null;
}
