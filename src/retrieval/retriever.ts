import {
  embeddingSignature,
  TOP_K_RETRIEVE,
  loadConfig,
} from "../config.js";
import { cosineSimilarity, embedQuery } from "../embedding.js";
import { logger } from "../logger.js";
import {
  dataVersion,
  getAllItems,
  getEmbeddingSignature,
} from "../storage/store.js";
import type {
  NearMiss,
  SearchCandidate,
  SearchResult,
  StoredItem,
} from "../types.js";
import { rerankCandidates } from "./rerank.js";

interface Corpus {
  version: string;
  items: StoredItem[];
  byId: Map<string, StoredItem>;
}

let cache: Corpus | null = null;

function loadCorpus(): Corpus | null {
  const version = dataVersion();
  if (cache && cache.version === version) return cache;
  const items = getAllItems();
  const corpus: Corpus = {
    version,
    items,
    byId: new Map(items.map((item) => [item.id, item])),
  };
  cache = corpus;
  return corpus;
}

async function rank(
  intent: string,
  limit = TOP_K_RETRIEVE,
): Promise<{
  candidates: StoredItem[];
  cosine: Map<string, number>;
  warning?: string;
}> {
  const corpus = loadCorpus();
  if (
    !corpus ||
    corpus.items.length === 0 ||
    !corpus.items.some((item) => item.enabled)
  ) {
    return { candidates: [], cosine: new Map() };
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

  if (getEmbeddingSignature() !== embeddingSignature()) {
    return {
      candidates: [],
      cosine: new Map(),
      warning:
        "Embedding retrieval is required, but the index vectors do not match the active embedding provider/model. Rebuild the vector index in Settings.",
    };
  }

  if (!queryVector) {
    return {
      candidates: [],
      cosine: new Map(),
      warning: `Embedding retrieval is required, but the model is unavailable: ${embeddingError}`,
    };
  }

  const cosine = new Map<string, number>();
  const vectorRanked: string[] = [];
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
    .slice(0, limit);
  for (const hit of scored) {
    cosine.set(hit.id, hit.score);
    vectorRanked.push(hit.id);
  }

  if (vectorRanked.length === 0) {
    return {
      candidates: [],
      cosine,
      warning:
        "The index has no stored embedding vectors. Reindex the skills to build them.",
    };
  }

  const candidates: StoredItem[] = [];
  for (const id of vectorRanked) {
    const item = corpus.byId.get(id);
    if (item) candidates.push(item);
  }
  return { candidates, cosine };
}

export interface Evaluation {
  result: SearchResult | null;
  candidates: SearchCandidate[];
  nearMisses: NearMiss[];
  reranked: boolean;
  threshold: number;
  warning?: string;
  rankingWarning?: string;
}

const EMPTY: Evaluation = {
  result: null,
  candidates: [],
  nearMisses: [],
  reranked: false,
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
  const { candidates, cosine } = ranked;
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
      cosine: Number((cosine.get(item.id) || 0).toFixed(4)),
      rerank:
        rerankScore === undefined ? null : Number(rerankScore.toFixed(4)),
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
      threshold,
      rankingWarning,
    };
  }

  const result: SearchResult = {
    id: best.id,
    name: best.name,
    description: best.description,
    content: best.body,
    confidence: Number(confidence.toFixed(4)),
    reranked,
  };
  // Multi-skill tasks are real: hand back the runners-up as one-liners so
  // the agent can load a second domain with another JIT_FIND call.
  const related = relatedSkills(debug, best.id);
  if (related.length > 0) result.related = related;
  return {
    result,
    candidates: debug,
    nearMisses,
    reranked,
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
