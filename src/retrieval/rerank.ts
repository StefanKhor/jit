import OpenAI from "openai";

import { MAX_SELECTIONS } from "../config.js";
import { logger } from "../logger.js";
import { isLocalEndpoint } from "../net.js";
import type { Config, StoredItem } from "../types.js";

export interface RerankOutcome {
  // Candidate ids the reranker chose, most relevant first. An empty list is a
  // verdict — "none of these fit" — and not a failure; only `error` means the
  // reranker did not decide and the caller must fall back to cosine.
  selected: string[];
  // Why reranking did not run, when it did not. Reranking is the decision
  // layer: whenever an endpoint is configured it always runs, and any skip
  // is reported to the caller instead of silently falling back to cosine.
  error: string | null;
  // Retrieval-trace fields: whether an endpoint was fully configured, how
  // many candidates were sent, and how long the call took.
  configured: boolean;
  sent: number;
  ms: number;
}

export async function rerankCandidates(
  intent: string,
  candidates: StoredItem[],
  settings: Config,
): Promise<RerankOutcome> {
  const selected: string[] = [];
  const started = performance.now();
  const hasCredentials =
    Boolean(settings.rerank_api_key) || isLocalEndpoint(settings.rerank_api_base);
  if (!settings.rerank_api_base || !settings.rerank_model || !hasCredentials) {
    return {
      selected,
      error:
        "rerank not configured — ranking by cosine only; set rerank_api_base and rerank_model",
      configured: false,
      sent: candidates.length,
      ms: 0,
    };
  }
  if (candidates.length === 0) {
    return { selected, error: null, configured: true, sent: 0, ms: 0 };
  }

  try {
    const client = new OpenAI({
      baseURL: settings.rerank_api_base,
      // OpenAI-compatible local endpoints such as Ollama do not need a key,
      // but the SDK requires a non-empty string.
      apiKey: settings.rerank_api_key || "local-no-key",
      timeout: 20_000,
      // No stacked SDK retries on top of the timeout: the reranker already
      // has a cosine fallback, and a stalled endpoint must not hold lookups.
      maxRetries: 0,
    });
    const listing = candidates
      .map(
        (candidate, index) =>
          `${index + 1}. [${candidate.name}] ${candidate.description}`,
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
            "Choose the entries that should be used for the intent. " +
            "Return ONLY a JSON array of their numbers, most relevant " +
            `first, at most ${MAX_SELECTIONS}. Return [] if none of them ` +
            "fit. No explanation.",
        },
      ],
      temperature: 0,
      // Enough headroom for a thinking model to finish its reasoning and
      // still emit the JSON array. A too-small budget is exactly the
      // "sometimes works, sometimes empty" failure: the model thinks a
      // variable amount, and an overrun means no answer at all.
      max_tokens: 2048,
    });
    const choice = response.choices[0];
    const finishReason = choice?.finish_reason ?? "unknown";
    const message = choice?.message as Record<string, unknown> | undefined;
    // Reasoning models answer in `content`, but some OpenAI-compatible
    // servers put the visible text in `reasoning_content` instead.
    const raw = String(
      message?.content ?? message?.reasoning_content ?? "",
    );
    // Thinking models wrap their reasoning in <think> blocks; the JSON can
    // carry no brackets of its own there, so strip them before slicing.
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const snippet = text.replace(/\s+/g, " ").slice(0, 120) || "(empty response)";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) {
      return {
        selected,
        error:
          `rerank response unparseable (finish_reason: ${finishReason}) — ` +
          `raw: ${snippet}` +
          (finishReason === "length"
            ? " — the model hit the token limit while thinking and never answered"
            : ""),
        configured: true,
        sent: candidates.length,
        ms: performance.now() - started,
      };
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        selected,
        error:
          `rerank response unparseable (finish_reason: ${finishReason}) — ` +
          `raw: ${snippet}`,
        configured: true,
        sent: candidates.length,
        ms: performance.now() - started,
      };
    }
    // Numbers are 1-based positions into the listing. Anything out of range is
    // dropped rather than trusted, and the ceiling is enforced here as well as
    // in the prompt.
    const chosen = new Set<string>();
    for (const entry of parsed) {
      const index = Number(entry);
      const candidate = Number.isInteger(index) ? candidates[index - 1] : undefined;
      if (!candidate || chosen.has(candidate.id)) continue;
      chosen.add(candidate.id);
      selected.push(candidate.id);
      if (selected.length >= MAX_SELECTIONS) break;
    }
    logger.info(
      "reranked %d candidates to %d selections with %s at %s",
      candidates.length,
      selected.length,
      settings.rerank_model,
      settings.rerank_api_base,
    );
    return {
      selected,
      error: null,
      configured: true,
      sent: candidates.length,
      ms: performance.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      "OpenAI-compatible rerank failed, falling back to cosine: %s",
      message,
    );
    return {
      selected,
      error: message,
      configured: true,
      sent: candidates.length,
      ms: performance.now() - started,
    };
  }
}
