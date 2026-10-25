import OpenAI from "openai";

import { logger } from "../logger.js";
import type { Config, StoredItem } from "../types.js";

function isLocalEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

export async function rerankCandidates(
  intent: string,
  candidates: StoredItem[],
  settings: Config,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const hasCredentials =
    Boolean(settings.rerank_api_key) || isLocalEndpoint(settings.rerank_api_base);
  if (
    !settings.rerank_enabled ||
    !settings.rerank_api_base ||
    !settings.rerank_model ||
    !hasCredentials ||
    candidates.length === 0
  ) {
    return scores;
  }

  try {
    const client = new OpenAI({
      baseURL: settings.rerank_api_base,
      // OpenAI-compatible local endpoints such as Ollama do not need a key,
      // but the SDK requires a non-empty string.
      apiKey: settings.rerank_api_key || "local-no-key",
      timeout: 20_000,
    });
    const listing = candidates
      .map(
        (candidate, index) =>
          `${index + 1}. [${candidate.name}] ${candidate.description} (when: ${candidate.when_to_use})`,
      )
      .join("\n");
    const response = await client.chat.completions.create({
      model: settings.rerank_model,
      messages: [
        {
          role: "user",
          content:
            `User intent: "${intent}"\n\n` +
            `Candidate entries:\n${listing}\n\n` +
            "Score each candidate 0-3 for relevance to the intent. " +
            "Return ONLY a JSON array of numbers, e.g. [3, 1, 0, 2]. " +
            "No explanation.",
        },
      ],
      temperature: 0,
      max_tokens: 64,
    });
    const text = (response.choices[0]?.message?.content || "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return scores;
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== candidates.length) {
      return scores;
    }
    candidates.forEach((candidate, index) => {
      const value = Math.min(Math.max(Number(parsed[index]) || 0, 0), 3);
      scores.set(candidate.id, value / 3);
    });
  } catch (error) {
    logger.warn(
      "OpenAI-compatible rerank failed, falling back to cosine: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
  return scores;
}
