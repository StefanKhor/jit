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

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    logger.info("loading embedding model %s", EMBEDDING_MODEL);
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "fp32",
    }).catch((error: unknown) => {
      extractorPromise = null;
      throw new Error(
        `could not load embedding model ${EMBEDDING_MODEL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  return extractorPromise;
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
