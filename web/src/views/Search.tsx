import { useEffect, useState, type FormEvent } from "react";

import { useJit } from "../state/store";
import type { SearchResponse } from "../types";
import { Meta, StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Empty, Spinner, Stat } from "../ui/Display";
import { Input } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { Slider } from "../ui/Slider";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";

export function Search() {
  const ctx = useJit();
  const [intent, setIntent] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [threshold, setThreshold] = useState<number>(
    () => Number(ctx.config?.confidence_threshold ?? 0.6),
  );

  useEffect(() => {
    if (ctx.config) {
      setThreshold(Number(ctx.config.confidence_threshold ?? 0.6));
    }
  }, [ctx.config]);

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

  return (
    <div className="space-y-8">
      <PageHead
        kicker="05 — Retrieval"
        title="Ask the index."
        description="Describe a task in plain language. JIT returns the single best entry, or nothing at all — never a guess — with a quiet table of what it weighed."
      />

      <Panel>
        <PanelBody className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="kicker">Confidence threshold</span>
            <span className="num text-sm text-ink">{threshold.toFixed(2)}</span>
          </div>
          <Slider
            id="threshold"
            aria-label="Confidence threshold"
            value={threshold}
            min={0.2}
            max={0.95}
            step={0.05}
            onValueChange={(value) => void saveThreshold(value)}
          />
          <p className="text-xs leading-relaxed text-ink-3">
            Below this, JIT returns nothing rather than guessing. Lower it for
            recall, raise it for precision.
          </p>
        </PanelBody>
      </Panel>

      <form className="flex gap-2" onSubmit={submit}>
        <Input
          type="text"
          aria-label="Search intent"
          placeholder="create a Linear issue for the login bug"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>

      {loading ? (
        <Panel role="status" aria-live="polite">
          <PanelBody className="flex items-center gap-3 text-sm text-ink-2">
            <Spinner />
            Searching the index…
          </PanelBody>
        </Panel>
      ) : error ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty title="Search failed.">{error}</Empty>
        </Panel>
      ) : !data ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty title="Nothing asked yet.">
            Describe a task in plain language. JIT returns the best entry, or
            nothing with a short list of what was close.
          </Empty>
        </Panel>
      ) : data.warning ? (
        <Panel className="border-warn/30 bg-warn/5">
          <PanelHead title="Embedding search unavailable" hint="no fallback used" />
          <PanelBody>
            <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
              {data.warning}
            </p>
          </PanelBody>
        </Panel>
      ) : (data.candidates || []).length === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty title="The index is empty.">
            Add a skill first.
          </Empty>
        </Panel>
      ) : (
        <SearchOutput data={data} />
      )}
    </div>
  );
}

function SearchOutput({ data }: { data: SearchResponse }) {
  const candidates = data.candidates || [];
  const result = data.result;
  const nearMisses = data.near_misses || [];
  const tick = Math.min(100, Math.max(0, Number(data.threshold || 0) * 100));
  const threshold = Number(data.threshold || 0);
  const closest = candidates[0] ?? null;
  const mode = data.reranked
    ? "reranked · OpenAI-compatible model"
    : data.ranking_warning
      ? "cosine only · rerank unavailable"
      : "vector search";

  return (
    <div id="search-output" role="status" aria-live="polite" className="space-y-8">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-3">
        <span>
          <span className="num">{Number(data.elapsed_ms || 0).toFixed(1)}</span>{" "}
          ms
        </span>
        <span>
          threshold <span className="num">{threshold.toFixed(2)}</span>
        </span>
        <span>{mode}</span>
      </div>

      {result ? (
        <Panel className="border-line-2">
          <PanelHead
            title="Best match"
            hint={mode}
          />
          <PanelBody className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <div className="min-w-0">
                <h2
                  className="display truncate text-2xl text-ink md:text-3xl"
                  title={result.name}
                >
                  {result.name}
                </h2>
                <Meta className="mt-2.5">{result.id}</Meta>
              </div>
              <Stat
                label="Confidence"
                value={Number(result.confidence).toFixed(2)}
                hint={`threshold ${threshold.toFixed(2)}`}
              />
            </div>

            <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
              {result.description}
            </p>

            <div>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(Number(result.confidence) || 0) * 100}%` }}
                />
                <span
                  aria-hidden="true"
                  className="absolute top-0 h-full w-px bg-ink-2"
                  style={{ left: `${tick}%` }}
                />
              </div>
              <div className="num mt-2 flex justify-between text-[10px] text-ink-3">
                <span>0</span>
                <span>1</span>
              </div>
            </div>

            <details className="border-t border-line pt-4">
              <summary className="cursor-pointer text-xs text-ink-3">
                Skill body
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink-2">
                {result.content}
              </pre>
            </details>
          </PanelBody>
        </Panel>
      ) : (
        <Panel>
          <PanelHead
            title="Nothing cleared the threshold."
            hint={`threshold ${threshold.toFixed(2)}`}
          />
          <PanelBody className="space-y-4">
            <p className="max-w-2xl text-sm leading-relaxed text-ink-2">
              JIT returned nothing rather than a guess, so the agent falls back
              to its own tools.
            </p>
            {closest ? (
              <p className="text-xs text-ink-3">
                Closest entry{" "}
                <span className="text-ink-2">{closest.name}</span> scored{" "}
                <span className="num text-ink-2">
                  {Number(closest.score || 0).toFixed(2)}
                </span>
                .
              </p>
            ) : null}
            {nearMisses.length ? (
              <ul className="divide-y divide-line/60 border-t border-line pt-1">
                {nearMisses.map((miss) => (
                  <li key={miss.id} className="flex items-baseline gap-3 py-2.5">
                    <span
                      className="min-w-0 truncate text-sm text-ink"
                      title={miss.name}
                    >
                      {miss.name}
                    </span>
                    <span className="num shrink-0 text-xs text-ink-3">
                      {Number(miss.score).toFixed(2)}
                    </span>
                    <span
                      className="hidden min-w-0 flex-1 truncate text-xs text-ink-3 sm:block"
                      title={miss.description}
                    >
                      {miss.description}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </PanelBody>
        </Panel>
      )}

      <Panel>
        <PanelHead
          title="Ranked candidates"
          hint="score · cosine · rerank"
        />
        <TableWrap>
          <Table className="table-fixed">
            <thead>
              <tr>
                <Th>Entry</Th>
                <Th className="num w-20 text-right">Score</Th>
                <Th className="num hidden w-20 text-right md:table-cell">
                  Cosine
                </Th>
                <Th className="num hidden w-20 text-right md:table-cell">
                  Rerank
                </Th>
                <Th className="w-24">Threshold</Th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate, index) => (
                <Tr key={candidate.id}>
                  <Td className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="num shrink-0 text-[11px] text-ink-3">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="truncate text-ink" title={candidate.name}>
                        {candidate.name}
                      </span>
                    </div>
                  </Td>
                  <Td className="num text-right">
                    <span className="font-medium text-ink">
                      {Number(candidate.score).toFixed(3)}
                    </span>
                  </Td>
                  <Td className="num hidden text-right text-ink-2 md:table-cell">
                    {Number(candidate.cosine).toFixed(3)}
                  </Td>
                  <Td className="num hidden text-right text-ink-2 md:table-cell">
                    {candidate.rerank == null
                      ? "—"
                      : Number(candidate.rerank).toFixed(2)}
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                      <StatusDot
                        tone={candidate.passes_threshold ? "ok" : "neutral"}
                      />
                      {candidate.passes_threshold ? "pass" : "below"}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Panel>
    </div>
  );
}


