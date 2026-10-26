import OpenAI from "openai";
import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import { getEmbeddingSettings, MODEL_CACHE_DIR } from "./config.js";
import { logger } from "./logger.js";
import { isLocalEndpoint } from "./net.js";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

const EMBEDDINGS_DISABLED = /^(1|true|yes|on)$/i.test(
  process.env.JIT_DISABLE_EMBEDDINGS || "",
);

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let extractorModel = "";
let lastFailureAt = 0;
const RETRY_AFTER_MS = 300_000;

function getExtractor(model: string): Promise<FeatureExtractionPipeline> {
  if (extractorModel !== model) {
    extractorPromise = null;
    extractorModel = model;
    lastFailureAt = 0;
  }
  if (EMBEDDINGS_DISABLED) {
    return Promise.reject(
      new Error("embeddings are disabled by JIT_DISABLE_EMBEDDINGS"),
    );
  }
  if (extractorPromise) return extractorPromise;
  if (lastFailureAt && Date.now() - lastFailureAt < RETRY_AFTER_MS) {
    return Promise.reject(
      new Error(`embedding model ${model} is unavailable (last load failed)`),
    );
  }
  logger.info("loading local embedding model %s", model);
  extractorPromise = pipeline("feature-extraction", model, {
    dtype: "fp32",
  }).catch((error: unknown) => {
    extractorPromise = null;
    lastFailureAt = Date.now();
    logger.warn(
      "local embedding model %s could not be loaded; retrieval is unavailable for %ds: %s",
      model,
      Math.round(RETRY_AFTER_MS / 1000),
      error instanceof Error ? error.message : String(error),
    );
    throw new Error(
      `could not load local embedding model ${model}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return extractorPromise;
}

function normalizedVector(values: ArrayLike<number>, dimensions: number): Float32Array {
  if (values.length !== dimensions) {
    throw new Error(
      `embedding provider returned ${values.length} dimensions; expected ${dimensions}`,
    );
  }
  const vector = Float32Array.from(values);
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("embedding provider returned a non-finite value");
    }
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (!norm) throw new Error("embedding provider returned a zero vector");
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] || 0) / norm;
  }
  return vector;
}

async function embedLocally(texts: string[]): Promise<Float32Array[]> {
  const settings = getEmbeddingSettings();
  const extractor = await getExtractor(settings.model);
  const output = await extractor(texts, { pooling: "cls", normalize: true });
  const data = output.data as Float32Array;
  const dims = output.dims as number[];
  const dimensions = dims[dims.length - 1] || 0;
  if (!dimensions || data.length !== texts.length * dimensions) {
    throw new Error("local embedding model returned an unexpected tensor shape");
  }
  if (dimensions !== settings.dimensions) {
    throw new Error(
      `local embedding model returned ${dimensions} dimensions; expected ${settings.dimensions}`,
    );
  }
  const vectors: Float32Array[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const start = index * dimensions;
    vectors.push(normalizedVector(data.subarray(start, start + dimensions), dimensions));
  }
  return vectors;
}

async function embedWithApi(texts: string[]): Promise<Float32Array[]> {
  if (EMBEDDINGS_DISABLED) {
    throw new Error("embeddings are disabled by JIT_DISABLE_EMBEDDINGS");
  }
  const settings = getEmbeddingSettings();
  if (!settings.apiBase || !settings.model) {
    throw new Error("configure an embeddings API base and model in Settings");
  }
  let localEndpoint = false;
  try {
    new URL(settings.apiBase); // reject a malformed base before reporting auth
    localEndpoint = isLocalEndpoint(settings.apiBase);
  } catch {
    throw new Error("embeddings API base is not a valid URL");
  }
  if (!settings.apiKey && !localEndpoint) {
    throw new Error("a remote embeddings endpoint requires an API key");
  }

  const client = new OpenAI({
    baseURL: settings.apiBase,
    apiKey: settings.apiKey || "local-no-key",
    timeout: 45_000,
  });
  const response = await client.embeddings.create({
    model: settings.model,
    input: texts,
    dimensions: settings.dimensions,
  });
  if (response.data.length !== texts.length) {
    throw new Error("embeddings API returned an unexpected number of vectors");
  }
  const ordered = [...response.data].sort((a, b) => a.index - b.index);
  return ordered.map((entry) => normalizedVector(entry.embedding, settings.dimensions));
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const settings = getEmbeddingSettings();
  return settings.provider === "openai-compatible"
    ? embedWithApi(texts)
    : embedLocally(texts);
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error("embedding provider returned no vector");
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
