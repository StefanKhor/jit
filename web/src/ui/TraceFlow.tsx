import type { RetrievalTrace } from "../types";
import { Panel, PanelBody, PanelHead } from "./Panel";

/**
 * The step-by-step account of a retrieval: embed, vector search, rerank,
 * gate, result. Pure debugging aid — every number comes from the server's
 * trace of a real run, nothing is re-derived here. Rendered on the Search
 * page for manual lookups and on the Lookups page for agent-invoked ones.
 */
export function TraceFlow({
  trace,
  candidates,
}: {
  trace?: RetrievalTrace;
  candidates?: { id: string; name: string }[];
}) {
  if (!trace) return null;
  const pool = candidates ?? [];
  const nameOf = (id: string) =>
    pool.find((candidate) => candidate.id === id)?.name ?? id;

  type Line = { text: string; tone?: "ok" | "warn" | "bad" | "dim" };
  interface Step {
    title: string;
    ok: boolean;
    lines: Line[];
    chips?: { label: string; accent?: boolean }[];
  }

  const steps: Step[] = [
    {
      title: "Embed the intent",
      ok: trace.embed != null,
      lines: trace.embed
        ? [
            {
              text:
                `${trace.embed.provider} · ${trace.embed.model}` +
                ` · ${trace.embed.dims} dims · ${trace.embed.ms} ms`,
            },
          ]
        : [
            {
              text: "query embedding failed — retrieval stopped here",
              tone: "bad",
            },
          ],
    },
    {
      title: "Vector search",
      ok: !trace.vector.warning,
      lines: [
        {
          text:
            `scored ${trace.vector.pool} embedded entries` +
            ` · kept top ${trace.vector.kept} of ${trace.vector.top_k}`,
        },
        ...(trace.vector.spread
          ? [
              {
                text:
                  `spread mean ${trace.vector.spread.mean.toFixed(2)} ± ` +
                  `${trace.vector.spread.sd.toFixed(2)} sd — the field this` +
                  " query's winner had to stand out from",
                tone: "dim" as const,
              },
            ]
          : [
              {
                text: "small index — raw cosine only, no spread measured",
                tone: "dim" as const,
              },
            ]),
        ...(trace.vector.warning
          ? [{ text: trace.vector.warning, tone: "bad" as const }]
          : []),
      ],
    },
    {
      title: "Rerank",
      ok: trace.rerank.error ? false : trace.rerank.ran || !trace.rerank.configured,
      lines: trace.rerank.configured
        ? [
            { text: `${trace.rerank.model} @ ${trace.rerank.base}` },
            {
              text:
                `sent ${trace.rerank.sent} candidates → picked ` +
                `${trace.rerank.selected.length} · ${trace.rerank.ms} ms`,
            },
            ...(trace.rerank.error
              ? [
                  {
                    text: `failed, fell back to cosine: ${trace.rerank.error}`,
                    tone: "bad" as const,
                  },
                ]
              : []),
          ]
        : [{ text: "not configured — cosine decides alone", tone: "dim" as const }],
      chips: trace.rerank.selected.length
        ? trace.rerank.selected.map((id, index) => ({
            label: `${index + 1}. ${nameOf(id)}`,
            accent: true,
          }))
        : undefined,
    },
    {
      title: "Gate",
      ok: trace.gate.passed > 0,
      lines: [
        {
          text:
            (trace.gate.mode === "rerank"
              ? "reranker verdict — the threshold does not apply"
              : `cosine confidence · threshold ${trace.gate.threshold.toFixed(2)}`) +
            ` · ${trace.gate.passed} passed`,
        },
      ],
    },
    {
      title: "Result",
      ok: trace.final.length > 0,
      lines: trace.final.length
        ? []
        : [{ text: "nothing returned rather than a guess", tone: "warn" as const }],
      chips: trace.final.map((entry) => ({
        label: entry.via === "rerank" ? `${entry.name} · rerank` : entry.name,
        accent: true,
      })),
    },
  ];

  return (
    <Panel>
      <PanelHead title="How this answer was built" hint="retrieval trace" />
      <PanelBody>
        <ol className="relative space-y-5 border-l border-line pl-6">
          {steps.map((step, index) => (
            <li key={step.title} className="relative">
              <span
                className={
                  "num absolute -left-[31px] flex size-5 items-center justify-center rounded-full border bg-panel text-[10px] " +
                  (step.ok
                    ? "border-line text-ink-3"
                    : "border-bad/40 text-bad")
                }
              >
                {index + 1}
              </span>
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-2">
                  {step.title}
                </p>
                {step.lines.map((line) => (
                  <p
                    key={line.text}
                    className={
                      "text-xs leading-relaxed " +
                      (line.tone === "bad"
                        ? "text-bad"
                        : line.tone === "warn"
                          ? "text-warn"
                          : line.tone === "dim"
                            ? "text-ink-3"
                            : "text-ink-2")
                    }
                  >
                    {line.text}
                  </p>
                ))}
                {step.chips?.length ? (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {step.chips.map((chip) => (
                      <span
                        key={chip.label}
                        className={
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] " +
                          (chip.accent
                            ? "border-accent/35 bg-accent/10 text-ink"
                            : "border-line bg-inset/60 text-ink-2")
                        }
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </PanelBody>
    </Panel>
  );
}
