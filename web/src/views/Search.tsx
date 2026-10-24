import { useState, type FormEvent } from "react";

import { useJit } from "../context";
import type { SearchResponse } from "../types";
import { Empty } from "../components/ui";

export function Search() {
  const ctx = useJit();
  const [intent, setIntent] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
          Describe a task in plain language. JIT returns the single best entry,
          or nothing.
        </Empty>
      ) : (data.candidates || []).length === 0 ? (
        <Empty title="The index is empty.">
          Add a skill or index an MCP server first.
        </Empty>
      ) : (
        <SearchOutput data={data} />
      )}
    </div>
  );
}

function SearchOutput({ data }: { data: SearchResponse }) {
  const candidates = data.candidates || [];
  const result = data.result;
  const tick = Math.min(100, Math.max(0, Number(data.threshold || 0) * 100));

  return (
    <div id="search-output">
      <div className="search-meta">
        <span>{Number(data.elapsed_ms || 0).toFixed(1)} ms</span>
        <span>threshold {Number(data.threshold || 0).toFixed(2)}</span>
        <span>
          {data.reranked ? "reranked · Nemotron Nano" : "local hybrid search"}
        </span>
      </div>

      {result ? (
        <article className="result">
          <div className="result-top">
            <span className="tag">{result.kind}</span>
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
          <div className="empty-title">No entry cleared the threshold.</div>
          <p>
            Best candidate: <b>{candidates[0]?.name}</b> at{" "}
            {Math.max(
              Number(candidates[0]?.cosine || 0),
              Number(candidates[0]?.rerank || 0),
            ).toFixed(2)}
            {"."} The agent would fall back to its own tools.
          </p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Ranked candidates</h2>
          <span className="panel-note">cosine · rerank · rrf</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Kind</th>
                <th className="num">Cosine</th>
                <th className="num">Rerank</th>
                <th className="num">RRF</th>
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
                  <td className="num">{Number(candidate.cosine).toFixed(3)}</td>
                  <td className="num">
                    {candidate.rerank == null
                      ? "—"
                      : Number(candidate.rerank).toFixed(2)}
                  </td>
                  <td className="num">{Number(candidate.rrf).toFixed(4)}</td>
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
