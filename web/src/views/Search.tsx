import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useJit } from "../context";
import type { RetrievalStats, SearchResponse } from "../types";
import { Empty } from "../components/ui";

export function Search() {
  const ctx = useJit();
  const [intent, setIntent] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<RetrievalStats | null>(null);
  const [threshold, setThreshold] = useState<number>(
    () => Number(ctx.config?.confidence_threshold ?? 0.6),
  );

  useEffect(() => {
    if (ctx.config) {
      setThreshold(Number(ctx.config.confidence_threshold ?? 0.6));
    }
  }, [ctx.config]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await ctx.api<RetrievalStats>("/api/retrieval?limit=25"));
    } catch {
      // Telemetry is best-effort; a failure should not disrupt search.
    }
  }, [ctx]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = intent.trim();
    if (!value || loading) return;
    setLoading(true);
    setError("");
    setData(null);
    try {
      setData(
        await ctx.api<SearchResponse>("/api/search", {
          method: "POST",
          body: JSON.stringify({ intent: value }),
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      void loadHistory();
    }
  };

  const saveThreshold = async (value: number) => {
    setThreshold(value);
    try {
      await ctx.saveConfig({ confidence_threshold: value });
    } catch (caught) {
      ctx.toast(
        caught instanceof Error ? caught.message : String(caught),
        "error",
      );
    }
  };

  const clearHistory = async () => {
    const ok = await ctx.confirmAction(
      "Clear retrieval history?",
      "The recall and miss data on this page will be reset.",
      "Clear",
    );
    if (!ok) return;
    try {
      await ctx.api("/api/retrieval/clear", { method: "POST" });
      void loadHistory();
      ctx.toast("Retrieval history cleared.");
    } catch (caught) {
      ctx.toast(
        caught instanceof Error ? caught.message : String(caught),
        "error",
      );
    }
  };

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="kicker">05 — Retrieval</div>
          <h2 className="section-title">Ask the index.</h2>
        </div>
      </div>

      <div className="slider-row">
        <label htmlFor="threshold">Confidence threshold</label>
        <input
          id="threshold"
          type="range"
          min={0.2}
          max={0.95}
          step={0.05}
          value={threshold}
          onChange={(event) => void saveThreshold(Number(event.target.value))}
        />
        <span className="slider-value">{threshold.toFixed(2)}</span>
        <span className="slider-note">
          Below this, JIT returns nothing rather than guessing. Lower it for
          recall, raise it for precision.
        </span>
      </div>

      <form className="search-row" onSubmit={submit}>
        <input
          type="text"
          placeholder="create a Linear issue for the login bug"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
        />
        <button className="btn btn-solid" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {loading ? (
        <div className="search-pending">Searching the index…</div>
      ) : error ? (
        <div className="no-result">
          <div className="empty-title">Search failed.</div>
          <p>{error}</p>
        </div>
      ) : !data ? (
        <Empty title="Nothing asked yet.">
          Describe a task in plain language. JIT returns the best entry, or
          nothing with a short list of what was close.
        </Empty>
      ) : (data.candidates || []).length === 0 ? (
        <Empty title="The index is empty.">
          Add a skill or index an MCP server first.
        </Empty>
      ) : (
        <SearchOutput data={data} />
      )}

      <RetrievalHistory
        history={history}
        onClear={history?.total ? clearHistory : undefined}
      />
    </div>
  );
}

function TrustBadge({ result }: { result: NonNullable<SearchResponse["result"]> }) {
  return (
    <span className="badge-row">
      <span className="tag">{result.kind}</span>
      {result.trust === "third-party" ? (
        <span className="badge badge-third" title={result.source || ""}>
          third-party
        </span>
      ) : null}
      {result.keyword_only ? (
        <span className="badge badge-keyword" title="No embeddings or reranker available; ranked by keywords only.">
          keyword-only
        </span>
      ) : null}
    </span>
  );
}

function SearchOutput({ data }: { data: SearchResponse }) {
  const candidates = data.candidates || [];
  const result = data.result;
  const nearMisses = data.near_misses || [];
  const tick = Math.min(100, Math.max(0, Number(data.threshold || 0) * 100));

  return (
    <div id="search-output">
      <div className="search-meta">
        <span>{Number(data.elapsed_ms || 0).toFixed(1)} ms</span>
        <span>threshold {Number(data.threshold || 0).toFixed(2)}</span>
        <span>
          {data.keyword_only
            ? "keyword-only fallback"
            : data.reranked
              ? "reranked · Nemotron Nano"
              : "local hybrid search"}
        </span>
      </div>

      {result ? (
        <article className="result">
          <div className="result-top">
            <TrustBadge result={result} />
            <span className="result-id">{result.id}</span>
          </div>
          <h3 className="result-name">{result.name}</h3>
          <p className="result-desc">{result.description}</p>
          <div className="gauge">
            <div className="gauge-track">
              <div
                className="gauge-fill"
                style={{ width: `${(Number(result.confidence) || 0) * 100}%` }}
              />
              <span className="gauge-tick" style={{ left: `${tick}%` }} />
            </div>
            <div className="gauge-labels">
              <span>0</span>
              <span>confidence {Number(result.confidence).toFixed(2)}</span>
              <span>1</span>
            </div>
          </div>
          {result.kind === "tool" ? (
            <div className="tool-hint">
              Call it with{" "}
              <code>JIT_CALL("{result.tool_id}", {"{ … }"})</code>
            </div>
          ) : null}
          <details className="body-details">
            <summary>
              {result.kind === "tool" ? "Input schema" : "Skill body"}
            </summary>
            <pre>{result.content}</pre>
          </details>
        </article>
      ) : (
        <div className="no-result">
          <div className="empty-title">Nothing cleared the threshold.</div>
          <p>
            JIT returned nothing rather than a guess, so the agent falls back to
            its own tools.
            {candidates[0]
              ? ` The closest entry, ${candidates[0].name}, scored ${Number(
                  candidates[0].score || 0,
                ).toFixed(2)}.`
              : ""}
          </p>
          {nearMisses.length ? (
            <ul className="miss-list">
              {nearMisses.map((miss) => (
                <li key={miss.id} className="miss-item">
                  <span className="tag">{miss.kind}</span>
                  <span className="miss-name">{miss.name}</span>
                  <span className="miss-score">{Number(miss.score).toFixed(2)}</span>
                  <span className="miss-desc">{miss.description}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Ranked candidates</h2>
          <span className="panel-note">score · cosine · rerank · lexical</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Kind</th>
                <th className="num">Score</th>
                <th className="num">Cosine</th>
                <th className="num">Rerank</th>
                <th className="num">Lexical</th>
                <th>Threshold</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate, index) => (
                <tr key={candidate.id}>
                  <td>
                    <span
                      className="mono"
                      style={{ color: "var(--ink-3)", marginRight: "10px" }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {candidate.name}
                  </td>
                  <td>
                    <span className="tag">{candidate.kind}</span>
                  </td>
                  <td className="num">
                    <b>{Number(candidate.score).toFixed(3)}</b>
                  </td>
                  <td className="num">{Number(candidate.cosine).toFixed(3)}</td>
                  <td className="num">
                    {candidate.rerank == null
                      ? "—"
                      : Number(candidate.rerank).toFixed(2)}
                  </td>
                  <td className="num">{Number(candidate.lexical).toFixed(3)}</td>
                  <td>
                    <span className="state">
                      <i
                        className={`dot ${candidate.passes_threshold ? "ok" : ""}`}
                      />
                      {candidate.passes_threshold ? "pass" : "below"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RetrievalHistory({
  history,
  onClear,
}: {
  history: RetrievalStats | null;
  onClear?: () => void;
}) {
  const recent = history?.recent || [];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Retrieval history</h2>
        <span className="panel-note">
          {history && history.total
            ? `${history.total} logged · ${history.miss_rate}% missed`
            : "no queries logged yet"}
          {onClear ? (
            <button className="btn-mini" onClick={onClear}>
              Clear
            </button>
          ) : null}
        </span>
      </div>
      {recent.length === 0 ? (
        <Empty title="No queries yet.">
          Every JIT_FIND call and dashboard search is logged here so misses are
          visible instead of silent.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>Intent</th>
                <th className="num">Best score</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{entry.ts.slice(11, 19)}</td>
                  <td>{entry.source}</td>
                  <td>{entry.intent}</td>
                  <td className="num">{Number(entry.score).toFixed(3)}</td>
                  <td>
                    <span className="state">
                      <i
                        className={`dot ${entry.decision === "hit" ? "ok" : "warn"}`}
                      />
                      {entry.decision === "hit" ? "hit" : "miss"}
                      {entry.keyword_only ? " · kw" : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
