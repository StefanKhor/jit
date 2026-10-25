import {
  embeddingSignature,
  EMBEDDING_SIGNATURE_KEY,
  TOP_K_RETRIEVE,
  loadConfig,
} from "../config.js";
import { cosineSimilarity, embedQuery } from "../embedding.js";
import { logger } from "../logger.js";
import {
  dataVersion,
  getAllItems,
  getMeta,
  initDb,
  logRetrieval,
} from "../storage/db.js";
import type {
  NearMiss,
  SearchCandidate,
  SearchResult,
  StoredItem,
} from "../types.js";
import { BM25Index, bm25Text } from "./bm25.js";
import { rerankCandidates } from "./rerank.js";

interface Corpus {
  version: string;
  items: StoredItem[];
  bm25: BM25Index | null;
  byId: Map<string, StoredItem>;
}

let cache: Corpus | null = null;

// Raw BM25 scores are unbounded and scale with the corpus's idf, so a fixed
// curve would score a two-entry index differently from a two-thousand-entry one.
// Normalize against the corpus's mean idf instead; the resulting confidence is
// roughly "how many of the query's terms this entry explains". Lexical values
// contribute to fusion, but are never used alone when vector embeddings are
// unavailable.
const LEXICAL_SCALE = 1.4;
const MIN_LEXICAL_SCALE = 0.05;

export function lexicalConfidence(score: number, scale = LEXICAL_SCALE): number {
  if (!(score > 0)) return 0;
  const denominator = score + Math.max(scale, MIN_LEXICAL_SCALE);
  return score / denominator;
}

function loadCorpus(): Corpus | null {
  const db = initDb();
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
  lexical: Map<string, number>;
  vectorUsed: boolean;
  warning?: string;
}> {
  const corpus = loadCorpus();
  if (!corpus || corpus.items.length === 0) {
    return {
      candidates: [],
      cosine: new Map(),
      lexical: new Map(),
      vectorUsed: false,
    };
  }

  const enabled = new Set(
    corpus.items.filter((item) => item.enabled).map((item) => item.id),
  );
  if (enabled.size === 0) {
    return {
      candidates: [],
      cosine: new Map(),
      lexical: new Map(),
      vectorUsed: false,
    };
  }

  const bm25Hits = corpus.bm25
    ? corpus.bm25.search(intent, TOP_K_RETRIEVE * 2)
    : [];
  const lexicalScale = LEXICAL_SCALE * (corpus.bm25?.meanIdf || 0);
  const lexical = new Map<string, number>();
  const bm25Ranked: string[] = [];
  for (const hit of bm25Hits) {
    const id = corpus.items[hit.index]?.id;
    if (!id || !enabled.has(id)) continue;
    lexical.set(id, lexicalConfidence(hit.score, lexicalScale));
    if (bm25Ranked.length < TOP_K_RETRIEVE) bm25Ranked.push(id);
  }

  let queryVector: Float32Array | null = null;
  let embeddingError = "";
  try {
    queryVector = await embedQuery(intent);
  } catch (error) {
    embeddingError = error instanceof Error ? error.message : String(error);
    // embedding.ts already warned once when the model became unavailable.
    logger.debug(
      "query embedding failed; vector retrieval is unavailable: %s",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (getMeta(initDb(), EMBEDDING_SIGNATURE_KEY) !== embeddingSignature()) {
    return {
      candidates: [],
      cosine: new Map(),
      lexical: new Map(),
      vectorUsed: false,
      warning:
        "Embedding retrieval is required, but the index vectors do not match the active embedding provider/model. Rebuild the vector index in Settings.",
    };
  }

  if (!queryVector) {
    return {
      candidates: [],
      cosine: new Map(),
      lexical: new Map(),
      vectorUsed: false,
      warning: `Embedding retrieval is required, but the model is unavailable: ${embeddingError}`,
    };
  }

  const cosine = new Map<string, number>();
  const vectorRanked: string[] = [];
  if (queryVector) {
    const scored = corpus.items
      .filter((item) => item.enabled && item.embedding)
      .map((item) => ({
        id: item.id,
        score: cosineSimilarity(
          queryVector as Float32Array,
          item.embedding as Float32Array,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K_RETRIEVE);
    for (const hit of scored) {
      cosine.set(hit.id, hit.score);
      vectorRanked.push(hit.id);
    }
  }

  if (vectorRanked.length === 0) {
    return {
      candidates: [],
      cosine,
      lexical,
      vectorUsed: false,
      warning:
        "The index has no stored embedding vectors. Reindex the skills; keyword-only retrieval is disabled.",
    };
  }

  const lexicalForFusion = bm25Ranked.filter((id) => cosine.has(id));
  const merged = rrf([lexicalForFusion, vectorRanked]).slice(0, limit);
  const candidates: Array<StoredItem & { rrf: number }> = [];
  for (const hit of merged) {
    const item = corpus.byId.get(hit.id);
    if (item) candidates.push({ ...item, rrf: hit.score });
  }
  return { candidates, cosine, lexical, vectorUsed: vectorRanked.length > 0 };
}

export interface Evaluation {
  result: SearchResult | null;
  candidates: SearchCandidate[];
  nearMisses: NearMiss[];
  reranked: boolean;
  keywordOnly: boolean;
  threshold: number;
  warning?: string;
  rankingWarning?: string;
}

const EMPTY: Evaluation = {
  result: null,
  candidates: [],
  nearMisses: [],
  reranked: false,
  keywordOnly: false,
  threshold: 0,
};

export async function evaluate(
  intent: string,
  topN = 5,
): Promise<Evaluation> {
  const settings = loadConfig();
  const threshold = Number(settings.confidence_threshold);
  const empty: Evaluation = { ...EMPTY, threshold };
  if (!intent || !intent.trim()) return empty;

  const ranked = await rank(intent, TOP_K_RETRIEVE);
  const { candidates, cosine, lexical, vectorUsed } = ranked;
  if (candidates.length === 0) {
    return { ...empty, warning: ranked.warning };
  }

  // Reranking is the decision layer: whenever an endpoint is configured it
  // runs on every lookup, and any skip is reported, never silent.
  const rerankOutcome = await rerankCandidates(intent, candidates, settings);
  const rerankScores = rerankOutcome.scores;
  const rankingWarning = rerankOutcome.error || undefined;
  if (rerankScores.size > 0) {
    candidates.sort(
      (a, b) => (rerankScores.get(b.id) || 0) - (rerankScores.get(a.id) || 0),
    );
  }

  const reranked = rerankScores.size > 0;
  const keywordOnly = !vectorUsed && !reranked;

  // Trust the reranker (a real 0..1 relevance judgment) when it ran;
  // otherwise use cosine. Candidates always have a vector score.
  const scoreOf = (id: string): number => {
    if (reranked) return rerankScores.get(id) || 0;
    return cosine.get(id) || 0;
  };

  const debug: SearchCandidate[] = candidates.slice(0, topN).map((item) => {
    const score = scoreOf(item.id);
    const rerankScore = rerankScores.get(item.id);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      kind: item.kind,
      cosine: Number((cosine.get(item.id) || 0).toFixed(4)),
      rrf: Number(item.rrf.toFixed(5)),
      rerank:
        rerankScore === undefined ? null : Number(rerankScore.toFixed(4)),
      lexical: Number((lexical.get(item.id) || 0).toFixed(4)),
      score: Number(score.toFixed(4)),
      passes_threshold: score >= threshold,
    };
  });

  const nearMisses: NearMiss[] = [...debug]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      kind: candidate.kind,
      score: candidate.score,
    }));

  const best = candidates[0];
  if (!best) {
    return { ...empty, candidates: debug, nearMisses, rankingWarning };
  }
  const confidence = scoreOf(best.id);
  if (confidence < threshold) {
    logger.debug(
      "no match for %r (best=%s, confidence=%.3f)",
      intent,
      best.id,
      confidence,
    );
    return {
      result: null,
      candidates: debug,
      nearMisses,
      reranked,
      keywordOnly,
      threshold,
      rankingWarning,
    };
  }

  const result: SearchResult = {
    id: best.id,
    name: best.name,
    kind: best.kind,
    description: best.description,
    content: best.body,
    confidence: Number(confidence.toFixed(4)),
    reranked,
  };
  if (keywordOnly) result.keyword_only = true;
  if (best.source) {
    result.source = best.source;
    result.trust = "third-party";
  } else {
    result.trust = "first-party";
  }
  if (best.kind === "tool") {
    result.server = best.server || best.id.split("__", 1)[0];
    result.tool_id = best.id;
  }
  // Multi-skill tasks are real: hand back the runners-up as one-liners so
  // the agent can load a second domain with another JIT_FIND call.
  const related = relatedSkills(debug, best.id);
  if (related.length > 0) result.related = related;
  return {
    result,
    candidates: debug,
    nearMisses,
    reranked,
    keywordOnly,
    threshold,
    rankingWarning,
  };
}

/**
 * Runner-up names for a confident hit. Multi-skill tasks are real: a deploy
 * may also need CI and monitoring. Names only — the agent loads a related
 * skill with another JIT_FIND call, which still applies the confidence
 * threshold.
 */
export function relatedSkills(
  candidates: SearchCandidate[],
  winnerId: string,
  limit = 2,
): string[] {
  return candidates
    .filter((candidate) => candidate.id !== winnerId && candidate.score > 0)
    .slice(0, limit)
    .map((candidate) => candidate.name);
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

// Persist one retrieval for the dashboard's recall view. Telemetry only; a
// failure here must never break retrieval.
export function recordRetrieval(
  evaluation: Evaluation,
  intent: string,
  source: string,
  elapsedMs: number,
): void {
  try {
    const top = evaluation.candidates[0];
    logRetrieval(initDb(), {
      source,
      intent,
      bestId: top?.id || "",
      bestName: top?.name || "",
      score: top?.score || 0,
      cosine: top?.cosine || 0,
      rerank: top ? top.rerank : null,
      lexical: top?.lexical || 0,
      candidates: evaluation.candidates.length,
      decision: evaluation.result ? "hit" : "miss",
      keywordOnly: evaluation.keywordOnly,
      elapsedMs: Number(elapsedMs.toFixed(1)),
    });
  } catch (error) {
    logger.debug(
      "could not record retrieval: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function invalidateRetrievalCache(): void {
  cache = null;
}
