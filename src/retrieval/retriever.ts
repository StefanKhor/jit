import {
  DEFAULT_CONFIG,
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

interface ScoreSpread {
  mean: number;
  sd: number;
}

/**
 * How many embedded skills a query must be scored against before its own spread
 * is worth measuring. Below this the mean and deviation are sampling noise, so
 * the absolute cosine is the honest answer.
 */
const MIN_SPREAD_SAMPLE = 8;

const SPREAD_SAMPLE_TOLERANCE = 1e-6;

/**
 * Where the stock confidence threshold sits on the relative scale, in standard
 * deviations above the query's mean score.
 *
 * Measured on a 90-skill index: the correct match averaged 4.4 deviations out
 * and a wrong one 2.9. Gating at 2.5 raised the share of returns that were
 * correct from 89% to 93% without dropping a single correct match.
 */
const Z_AT_DEFAULT_THRESHOLD = 2.5;

/** Spread of the logistic that maps deviations onto the 0..1 scale. */
const Z_STEEPNESS = 1;

// Anchored so the threshold shipped in DEFAULT_CONFIG lands on
// Z_AT_DEFAULT_THRESHOLD, rather than that pair being pinned by two unrelated
// magic numbers.
const Z_MIDPOINT =
  Z_AT_DEFAULT_THRESHOLD -
  Z_STEEPNESS *
    Math.log(
      DEFAULT_CONFIG.confidence_threshold /
        (1 - DEFAULT_CONFIG.confidence_threshold),
    );

/**
 * Confidence as "how far this stands out", not "what the cosine was".
 *
 * A raw cosine cannot separate a right match from a wrong one: two unrelated
 * skills already score around 0.56, because every embedding shares a common
 * direction. On a 90-skill index the fixed 0.6 cutoff admitted 99% of lookups
 * and 40% of what it returned was the wrong skill. How far the winner stands
 * above the query's own scores does separate them, so that margin is what the
 * verdict rests on, squashed into the 0..1 range the threshold slider and the
 * dashboard's confidence bar already speak.
 */
function relativeConfidence(z: number): number {
  return 1 / (1 + Math.exp(-(z - Z_MIDPOINT) / Z_STEEPNESS));
}

/** Mean and spread of one query's cosine across every embedded skill. */
function scoreSpread(scores: number[]): ScoreSpread | null {
  if (scores.length < MIN_SPREAD_SAMPLE) return null;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance =
    scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  const sd = Math.sqrt(variance);
  // A flat field means every skill scored alike: nothing to stand out from.
  if (!Number.isFinite(sd) || sd < SPREAD_SAMPLE_TOLERANCE) return null;
  return { mean, sd };
}

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
  spread: ScoreSpread | null;
  warning?: string;
}> {
  const corpus = loadCorpus();
  if (
    !corpus ||
    corpus.items.length === 0 ||
    !corpus.items.some((item) => item.enabled)
  ) {
    return { candidates: [], cosine: new Map(), spread: null };
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
      spread: null,
      warning:
        "Embedding retrieval is required, but the index vectors do not match the active embedding provider/model. Rebuild the vector index in Settings.",
    };
  }

  if (!queryVector) {
    return {
      candidates: [],
      cosine: new Map(),
      spread: null,
      warning: `Embedding retrieval is required, but the model is unavailable: ${embeddingError}`,
    };
  }

  // Every enabled skill is scored, not just the ones returned: the winner is
  // judged against the whole field, so the field has to be measured before the
  // shortlist is taken.
  const scored = corpus.items
    .filter((item) => item.enabled && item.embedding)
    .map((item) => ({
      id: item.id,
      score: cosineSimilarity(
        queryVector as Float32Array,
        item.embedding as Float32Array,
      ),
    }));
  const spread = scoreSpread(scored.map((entry) => entry.score));
  scored.sort((a, b) => b.score - a.score);

  const cosine = new Map<string, number>();
  const vectorRanked: string[] = [];
  for (const hit of scored.slice(0, limit)) {
    cosine.set(hit.id, hit.score);
    vectorRanked.push(hit.id);
  }

  if (vectorRanked.length === 0) {
    return {
      candidates: [],
      cosine,
      spread,
      warning:
        "The index has no stored embedding vectors. Reindex the skills to build them.",
    };
  }

  const candidates: StoredItem[] = [];
  for (const id of vectorRanked) {
    const item = corpus.byId.get(id);
    if (item) candidates.push(item);
  }
  return { candidates, cosine, spread };
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
  const { candidates, cosine, spread } = ranked;
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

  // Trust the reranker (a real 0..1 relevance judgment) when it ran; otherwise
  // judge the winner by how far it stands above this query's own scores, capped
  // by the raw score it stands on. Too small an index to measure a spread, and
  // the raw cosine stands on its own.
  //
  // Taking the weaker of the two is what makes one number express a two-part
  // test: a match has to clear the threshold as a raw score *and* as a standing
  // above the field, and `min(raw, standing) >= threshold` says exactly that.
  // Either signal alone is fooled — a raw cosine returns the wrong skill about
  // 40% of the time on body-wording lookups, while standing alone lets a flat
  // index, where nothing really matches, read as a confident hit.
  const scoreOf = (id: string): number => {
    if (reranked) return rerankScores.get(id) || 0;
    const raw = cosine.get(id) || 0;
    if (!spread) return raw;
    const standing = relativeConfidence((raw - spread.mean) / spread.sd);
    return Math.min(raw, standing);
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
      "no match for %r (best=%s, confidence=%.3f, cosine=%.3f)",
      intent,
      best.id,
      confidence,
      cosine.get(best.id) || 0,
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
