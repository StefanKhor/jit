import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import { EMBEDDING_DIM, EMBEDDING_MODEL, MODEL_CACHE_DIR } from "./config.js";
import { logger } from "./logger.js";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// JIT_DISABLE_EMBEDDINGS=1 skips model loading. Retrieval requires embeddings,
// so queries return an explicit unavailable warning instead of a lexical result.
const EMBEDDINGS_DISABLED = /^(1|true|yes|on)$/i.test(
  process.env.JIT_DISABLE_EMBEDDINGS || "",
);

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
// When the model cannot load (offline, missing runtime, first-run download
// blocked) every call would otherwise pay the full load timeout again. Remember
// the failure and refuse quickly for a cooldown so strict retrieval fails fast
// instead of hanging on every query.
let lastFailureAt = 0;
const RETRY_AFTER_MS = 300_000;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (EMBEDDINGS_DISABLED) {
    return Promise.reject(
      new Error("embeddings are disabled by JIT_DISABLE_EMBEDDINGS"),
    );
  }
  if (extractorPromise) return extractorPromise;
  if (lastFailureAt && Date.now() - lastFailureAt < RETRY_AFTER_MS) {
    return Promise.reject(
      new Error(`embedding model ${EMBEDDING_MODEL} is unavailable (last load failed)`),
    );
  }
  logger.info("loading embedding model %s", EMBEDDING_MODEL);
  extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: "fp32",
  }).catch((error: unknown) => {
    extractorPromise = null;
    lastFailureAt = Date.now();
    logger.warn(
      "embedding model %s could not be loaded; remote-backed retrieval is unavailable for %ds: %s",
      EMBEDDING_MODEL,
      Math.round(RETRY_AFTER_MS / 1000),
      error instanceof Error ? error.message : String(error),
    );
    throw new Error(
      `could not load embedding model ${EMBEDDING_MODEL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return extractorPromise;
}

// Allow a later attempt (for example after the model finishes downloading)
// without restarting the process.
export function resetEmbeddingModel(): void {
  extractorPromise = null;
  lastFailureAt = 0;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, {
    pooling: "cls",
    normalize: true,
  });
  const data = output.data as Float32Array;
  const dims = output.dims as number[];
  const dim = dims[dims.length - 1] || 0;
  if (!dim || data.length % dim !== 0) {
    throw new Error("embedding model returned an unexpected tensor shape");
  }
  if (dim !== EMBEDDING_DIM) {
    throw new Error(
      `embedding model returned ${dim} dimensions; expected ${EMBEDDING_DIM}`,
    );
  }
  const count = data.length / dim;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    vectors.push(data.slice(index * dim, (index + 1) * dim));
  }
  return vectors;
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error("embedding model returned no vector");
  return vector;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return dot;
}

export async function warmupEmbeddingModel(): Promise<void> {
  await embedTexts(["warmup"]);
}
