import {
  DEFAULT_CONFIG,
  embeddingSignature,
  getEmbeddingSettings,
  TOP_K_RETRIEVE,
  loadConfig,
} from "../config.js";
import { cosineSimilarity, embedQuery } from "../embedding.js";
import { logger } from "../logger.js";
import {
  dataVersion,
  getAllItems,
  getEmbeddingSignature,
  getItem,
} from "../storage/store.js";
import type {
  NearMiss,
  RetrievalTrace,
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
  // Metadata and vectors only. Bodies are read from their files for the one or
  // two skills that are actually returned, never for the whole catalog.
  const items = getAllItems(false);
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
  // Retrieval-trace fields: whether the query embedding succeeded, how long it
  // took, and how many enabled entries actually carried a vector to score.
  embedded: boolean;
  embedMs: number;
  pool: number;
}> {
  const corpus = loadCorpus();
  if (
    !corpus ||
    corpus.items.length === 0 ||
    !corpus.items.some((item) => item.enabled)
  ) {
    return {
      candidates: [],
      cosine: new Map(),
      spread: null,
      embedded: false,
      embedMs: 0,
      pool: 0,
    };
  }

  let queryVector: Float32Array | null = null;
  let embeddingError = "";
  const embedStarted = performance.now();
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
  const embedMs = performance.now() - embedStarted;
  // What the vector step would have to score against, whether or not the
  // embedding succeeded — the trace reports the pool either way.
  const pool = corpus.items.filter((item) => item.enabled && item.embedding)
    .length;

  if (getEmbeddingSignature() !== embeddingSignature()) {
    return {
      candidates: [],
      cosine: new Map(),
      spread: null,
      embedded: true,
      embedMs,
      pool,
      warning:
        "Embedding retrieval is required, but the index vectors do not match the active embedding provider/model. Rebuild the vector index in Settings.",
    };
  }

  if (!queryVector) {
    return {
      candidates: [],
      cosine: new Map(),
      spread: null,
      embedded: false,
      embedMs,
      pool,
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
      embedded: true,
      embedMs,
      pool,
      warning:
        "The index has no stored embedding vectors. Reindex the skills to build them.",
    };
  }

  const candidates: StoredItem[] = [];
  for (const id of vectorRanked) {
    const item = corpus.byId.get(id);
    if (item) candidates.push(item);
  }
  return { candidates, cosine, spread, embedded: true, embedMs, pool };
}

export interface Evaluation {
  // The skills the agent should use, most relevant first. One entry when the
  // decision came from cosine; up to MAX_SELECTIONS when a reranker chose.
  // Empty means nothing cleared the bar.
  results: SearchResult[];
  candidates: SearchCandidate[];
  nearMisses: NearMiss[];
  reranked: boolean;
  threshold: number;
  warning?: string;
  rankingWarning?: string;
  // Step-by-step account of this retrieval, for the dashboard's flow view.
  // Never forwarded to agents: JIT_FIND maps its own minimal payload.
  trace?: RetrievalTrace;
}

const EMPTY: Evaluation = {
  results: [],
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
  const embedSettings = getEmbeddingSettings();
  const embedStep: RetrievalTrace["embed"] = ranked.embedded
    ? {
        provider: embedSettings.provider,
        model: embedSettings.model,
        dims: embedSettings.dimensions,
        ms: Number(ranked.embedMs.toFixed(1)),
      }
    : null;
  if (candidates.length === 0) {
    // Nothing survived the vector step (or it never ran): the trace ends
    // there, with the reason in the warning.
    const stopTrace: RetrievalTrace = {
      embed: embedStep,
      vector: {
        pool: ranked.pool,
        top_k: TOP_K_RETRIEVE,
        kept: 0,
        spread: null,
        ...(ranked.warning ? { warning: ranked.warning } : {}),
      },
      rerank: {
        configured: false,
        ran: false,
        base: settings.rerank_api_base,
        model: settings.rerank_model,
        sent: 0,
        selected: [],
        ms: 0,
      },
      gate: { mode: "cosine", threshold, spread_used: false, passed: 0 },
      final: [],
    };
    return { ...empty, warning: ranked.warning, trace: stopTrace };
  }

  // Reranking is the decision layer: whenever an endpoint is configured it
  // runs on every lookup, and any skip is reported, never silent.
  const rerankOutcome = await rerankCandidates(intent, candidates, settings);
  const rankingWarning = rerankOutcome.error || undefined;
  // When the reranker ran, its verdict is the answer — including "none of these
  // fit", which is a real answer, not a reason to fall back. Only a rerank that
  // failed to decide (`error`) drops through to cosine, and it says so.
  const reranked = rerankOutcome.error === null;
  const selectedOrder = new Map(
    rerankOutcome.selected.map((id, index) => [id, index]),
  );

  // A reranked verdict is categorical, so the table lists what it picked first,
  // in its own order, then whatever is left by cosine.
  if (reranked) {
    candidates.sort((a, b) => {
      const left = selectedOrder.get(a.id);
      const right = selectedOrder.get(b.id);
      if (left !== undefined || right !== undefined) {
        return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
      }
      return (cosine.get(b.id) || 0) - (cosine.get(a.id) || 0);
    });
  }

  // How far the winner stands above this query's own scores, capped by the raw
  // score it stands on. Taking the weaker of the two is what makes one number
  // express a two-part test: a match has to clear the threshold as a raw score
  // *and* as a standing above the field, and `min(raw, standing) >= threshold`
  // says exactly that. Either signal alone is fooled — a raw cosine returns the
  // wrong skill about 40% of the time on body-wording lookups, while standing
  // alone lets a flat index, where nothing really matches, read as a confident
  // hit. Only cosine needs it; a reranked choice carries its own verdict.
  const cosineConfidence = (id: string): number => {
    const raw = cosine.get(id) || 0;
    if (!spread) return raw;
    return Math.min(raw, relativeConfidence((raw - spread.mean) / spread.sd));
  };

  const debug: SearchCandidate[] = candidates.slice(0, topN).map((item) => {
    const picked = reranked ? selectedOrder.has(item.id) : false;
    // With a reranker the choice is categorical and there is no number to show,
    // so the score the decision used is simply 1 or 0.
    const score = reranked ? (picked ? 1 : 0) : cosineConfidence(item.id);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      cosine: Number((cosine.get(item.id) || 0).toFixed(4)),
      picked,
      score: Number(score.toFixed(4)),
      passes_threshold: reranked ? picked : score >= threshold,
    };
  });

  // The corpus carries metadata and vectors, not bodies: a skill's text is
  // read from its file only for the entries actually handed back.
  const contentOf = (id: string): string => getItem(id)?.body ?? "";

  const results: SearchResult[] = reranked
    ? rerankOutcome.selected
        .map((id) => candidates.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is StoredItem => Boolean(candidate))
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          content: contentOf(candidate.id),
          path: candidate.path,
          reranked: true,
        }))
    : cosineResult(candidates, threshold, cosineConfidence, debug, contentOf);

  // What was closest, by vector distance, so a miss still shows the field it was
  // judged against. On the cosine path that is the same score the gate used.
  const nearMisses: NearMiss[] = [...candidates]
    .map((item) => ({
      item,
      score: reranked ? cosine.get(item.id) || 0 : cosineConfidence(item.id),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item, score }) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      score: Number(score.toFixed(4)),
    }));

  if (results.length === 0) {
    logger.debug(
      "no match for %r (best=%s, cosine=%.3f)",
      intent,
      candidates[0]?.id ?? "(none)",
      cosine.get(candidates[0]?.id ?? "") || 0,
    );
  }

  const trace: RetrievalTrace = {
    embed: embedStep,
    vector: {
      pool: ranked.pool,
      top_k: TOP_K_RETRIEVE,
      kept: candidates.length,
      spread: spread
        ? {
            mean: Number(spread.mean.toFixed(4)),
            sd: Number(spread.sd.toFixed(4)),
          }
        : null,
    },
    rerank: {
      configured: rerankOutcome.configured,
      ran: reranked,
      base: settings.rerank_api_base,
      model: settings.rerank_model,
      sent: rerankOutcome.sent,
      selected: rerankOutcome.selected,
      ms: Number(rerankOutcome.ms.toFixed(1)),
      ...(rerankOutcome.error ? { error: rerankOutcome.error } : {}),
    },
    gate: {
      mode: reranked ? "rerank" : "cosine",
      threshold,
      spread_used: Boolean(spread),
      passed: reranked
        ? rerankOutcome.selected.length
        : debug.filter((entry) => entry.passes_threshold).length,
    },
    final: results.map((result) => ({
      id: result.id,
      name: result.name,
      via: result.reranked ? "rerank" : "cosine",
    })),
  };

  return {
    results,
    candidates: debug,
    nearMisses,
    reranked,
    threshold,
    rankingWarning,
    trace,
  };
}

/**
 * The cosine-only verdict: the single best entry, if it clears the threshold on
 * both the raw and the relative scale. Related names ride along here because
 * without a reranker this is the only signal that more than one skill may
 * apply; a reranked answer returns extra bodies instead and needs no hint.
 */
function cosineResult(
  candidates: StoredItem[],
  threshold: number,
  confidenceOf: (id: string) => number,
  debug: SearchCandidate[],
  contentOf: (id: string) => string,
): SearchResult[] {
  const best = candidates[0];
  if (!best) return [];
  const confidence = confidenceOf(best.id);
  if (confidence < threshold) return [];
  const result: SearchResult = {
    id: best.id,
    name: best.name,
    description: best.description,
    content: contentOf(best.id),
    path: best.path,
    confidence: Number(confidence.toFixed(4)),
    reranked: false,
  };
  // Multi-skill tasks are real: hand back the runners-up as one-liners so
  // the agent can load a second domain with another JIT_FIND call.
  const related = relatedSkills(debug, best.id);
  if (related.length > 0) result.related = related;
  return [result];
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
