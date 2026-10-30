import { useCallback, useEffect, useState } from "react";

import { useJit } from "../state/store";
import type { LookupRecord } from "../types";
import { StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Empty, Spinner } from "../ui/Display";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { TraceFlow } from "../ui/TraceFlow";

/**
 * What agents actually asked JIT. Every lookup from any process —
 * the stdio MCP server and the dashboard share one log file — lands here with
 * its verdict and, for JIT_FIND, the full step-by-step retrieval trace, so an
 * agent's lookup can be debugged exactly like a manual Search.
 */
export function Lookups() {
  const ctx = useJit();
  const [lookups, setLookups] = useState<LookupRecord[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await ctx.api<{ lookups: LookupRecord[] }>("/api/lookups");
      setLookups(result.lookups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <PageHead
        kicker="Observability"
        title="Lookups"
        description="Agent lookups, newest first. Expand a JIT_FIND entry to see the same step-by-step retrieval trace as the Search page."
        actions={
          <Button type="button" disabled={lookups === null && !error} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      {error ? (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}

      {lookups === null && !error ? (
        <Spinner />
      ) : lookups !== null && lookups.length === 0 ? (
        <Empty title="No lookups logged yet">
          <p>
            Connect an agent to <code>jit serve</code> and its JIT_FIND
            calls will appear here as they happen.
          </p>
        </Empty>
      ) : lookups ? (
        <Panel>
          <PanelHead
            title={`${lookups.length} recent lookup${lookups.length === 1 ? "" : "s"}`}
            hint="newest first"
          />
          <PanelBody>
            <ul className="space-y-1.5">
              {lookups.map((lookup) => {
                const key = `${lookup.ts}|${lookup.tool}|${lookup.intent ?? lookup.name ?? ""}`;
                const open = expanded === key;
                return (
                  <li key={key} className="rounded-lg border border-line bg-inset/40">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left"
                      onClick={() => setExpanded(open ? null : key)}
                    >
                      <StatusDot tone={lookup.found ? "ok" : "bad"} />
                      <span className="num text-[11px] text-ink-3">
                        {new Date(lookup.ts).toLocaleTimeString()}
                      </span>
                      <span className="font-mono text-xs text-ink">
                        {lookup.tool}
                        {lookup.tool === "JIT_RUN" ? " (legacy)" : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-2">
                        {lookup.intent ?? lookup.name}
                      </span>
                      <span className="text-xs text-ink-3">
                        {lookup.found
                          ? (lookup.results ?? []).join(", ") || "found"
                          : lookup.warning
                            ? "unavailable"
                            : "miss"}
                        {" · "}
                        {lookup.ms} ms
                      </span>
                      <span
                        className={
                          "text-ink-3 transition-transform " + (open ? "rotate-90" : "")
                        }
                        aria-hidden
                      >
                        ›
                      </span>
                    </button>
                    {open ? (
                      <div className="space-y-3 border-t border-line px-3 py-3">
                        {lookup.near_misses?.length ? (
                          <p className="text-xs text-ink-3">
                            near misses: {lookup.near_misses.join(", ")}
                          </p>
                        ) : null}
                        {lookup.close_matches?.length ? (
                          <p className="text-xs text-ink-3">
                            close matches: {lookup.close_matches.join(", ")}
                          </p>
                        ) : null}
                        {lookup.warning ? (
                          <p className="text-xs text-warn">{lookup.warning}</p>
                        ) : null}
                        {lookup.trace ? (
                          <TraceFlow trace={lookup.trace} />
                        ) : lookup.tool === "JIT_RUN" ? (
                          <p className="text-xs text-ink-3">
                            Historical exact-name load from the removed JIT_RUN
                            tool. No vector search or reranking was performed.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  );
}
