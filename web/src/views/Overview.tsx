import { useId, type ReactNode } from "react";

import { fmt, pct } from "../format";
import { useJit } from "../state/store";
import type { Stats, UsageSummary } from "../types";
import { Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { AnimatedNumber, Empty, Ring, Spinner } from "../ui/Display";
import { Panel, PanelBody, PanelHead } from "../ui/Panel";

/** The one-line thesis of the product, above the fold. */
function Hero() {
  return (
    <header className="motion-safe:animate-rise">
      <div className="kicker">Overview</div>
      <h1 className="display mt-4 text-[2.5rem] text-ink sm:text-[3.25rem] lg:text-[4rem]">
        One fixed tool.
        <br />
        <span className="bg-gradient-to-br from-ink to-ink-3/50 bg-clip-text text-transparent">
          Every skill on demand.
        </span>
      </h1>
      <p className="mt-6 max-w-lg text-sm leading-relaxed text-ink-2">
        A skill catalog rides in every session: each name and description
        re-read turn after turn, growing with every install. JIT collapses it
        into one fixed tool call that routes to the tested procedure — skill or
        MCP tool — when a task needs it, and logs every lookup so you can see
        what the agent actually used.
      </p>
    </header>
  );
}

/**
 * The comparison itself, drawn as one figure: the full circle is the plain
 * catalog's footprint and JIT is the thin arc carved out of it. A 40× ratio
 * renders as a near-empty ring — the emptiness is the argument.
 */
function HeroRing({
  share,
  lighter,
  label,
  children,
}: {
  /** JIT's share of the catalog, 0–1+ (values above 1 clamp to full). */
  share: number;
  lighter: boolean;
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const SIZE = 288;
  const THICKNESS = 11;
  const radius = 50 - THICKNESS / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.max(0, Math.min(1, share));

  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg
        viewBox="0 0 100 100"
        className="size-full -rotate-90"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-2)" />
            <stop offset="100%" stopColor="var(--color-accent)" />
          </linearGradient>
        </defs>
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="var(--color-bad)"
          strokeOpacity={0.4}
          strokeWidth={THICKNESS}
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={lighter ? `url(#${id})` : "var(--color-warn)"}
          strokeWidth={THICKNESS}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          style={{
            ["--draw-from" as string]: `${circumference}`,
            ["--draw-to" as string]: `${circumference - filled}`,
          }}
          className="motion-safe:animate-draw"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

/**
 * The initial load, at the scale it deserves: what the agent carries before
 * any task begins. A plain catalog holds every name and description in
 * context; JIT holds one fixed tool schema.
 *
 * The ring encodes the same fact geometrically — JIT's schema is a sliver of
 * the catalog it replaces — so the claim survives even if the numeral is skimmed.
 */
function InitialLoad({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const jit = Number(tokens?.jit || 0);
  const catalog = Number(tokens?.catalog || 0);
  const saved = Number(tokens?.saved || 0);
  const body = Number(tokens?.average_item || 0);
  const breakEven = Number(tokens?.break_even || 0);
  const total = stats.total || 0;

  // A ratio reads as a claim; a percentage reads as a rounding error.
  const multiple = jit > 0 ? catalog / jit : 0;
  const lighter = multiple >= 1;
  const overhead = Math.max(0, jit - catalog);
  const share = catalog > 0 ? Math.min(1, jit / catalog) : 0;
  const headline = lighter ? multiple : multiple ? 1 / multiple : 0;

  return (
    <Panel className="motion-safe:animate-rise">
      {/* A signal wash behind the figure — the one place the accent is allowed
          to be atmospheric rather than an edge. Drawn as a gradient rather than
          a blurred shape so the rounded corners clip it cleanly. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(58% 84% at 2% 0%, color-mix(in oklab, var(--color-accent) 12%, transparent), transparent 68%), radial-gradient(52% 70% at 66% 118%, color-mix(in oklab, var(--color-accent-3) 9%, transparent), transparent 70%)",
        }}
      />

      <PanelBody className="relative flex flex-col gap-9 py-8 lg:flex-row lg:items-center lg:gap-14 lg:py-11">
        <div className="flex shrink-0 flex-col items-center gap-6">
          <HeroRing
            share={share}
            lighter={lighter}
            label={
              lighter
                ? `JIT's initial load is ${Math.round(share * 1000) / 10}% of a plain catalog's`
                : `JIT's initial load is ${Math.round(share * 1000) / 10}% more than a plain catalog's`
            }
          >
            <span className="flex items-start">
              <AnimatedNumber
                value={headline}
                decimals={1}
                className="figure ink-gradient text-[3.6rem] md:text-[4.2rem]"
              />
              <span className="figure mt-1 text-[1.9rem] text-accent/70 md:text-[2.2rem]">
                ×
              </span>
            </span>
            <span className={`kicker mt-2 ${lighter ? "!text-accent/70" : "!text-warn/70"}`}>
              {lighter ? "smaller" : "larger"}
            </span>
          </HeroRing>
          <div className="flex items-center gap-5">
            <span className="flex items-center gap-2 text-xs text-ink-2">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${lighter ? "bg-bad" : "bg-info"}`}
              />
              Plain catalog
              <span className="num text-ink">{fmt(catalog)}</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-ink-2">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${lighter ? "bg-accent" : "bg-warn"}`}
              />
              JIT
              <span className="num text-ink">{fmt(jit)}</span>
            </span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="kicker">Initial load · before any task begins</div>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
            A plain catalog puts every one of this index's {fmt(total)}{" "}
            {total === 1 ? "entry" : "entries"} — every name and description —
            into context on load: <span className="num text-ink">{fmt(catalog)}</span>{" "}
            tokens. JIT's fixed tool schema costs{" "}
            <span className="num text-ink">{fmt(jit)}</span>, no matter how many
            entries sit behind it.
          </p>

          <p className="mt-7 border-t border-line pt-5 text-sm leading-relaxed">
            {lighter ? (
              <>
                <span className="num text-accent">{fmt(saved)}</span> tokens stay
                out of context before the first task runs — and the gap widens
                with each entry added, because the catalog grows and the schema
                does not.
              </>
            ) : (
              <>
                At this size, JIT carries <span className="num text-warn">{fmt(overhead)}</span>{" "}
                more tokens than a plain catalog — a net cost until the index
                passes <span className="num text-ink-2">{fmt(breakEven)}</span>{" "}
                entries.
              </>
            )}
          </p>

          <p className="mt-3 flex items-start gap-2.5 text-xs leading-relaxed text-ink-3">
            <span
              aria-hidden="true"
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent-2/70"
            />
            <span>
              Both approaches fetch the same{" "}
              <span className="num text-ink-2">~{fmt(body)}</span>-token body on
              demand, so the body is not part of this count.
            </span>
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

/** Quiet supporting figures, on one hairline-separated strip. */
function Supporting({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const perEntryCatalog = stats.total
    ? Math.floor((stats.catalog_tokens || 0) / stats.total)
    : 0;
  const figures = [
    {
      key: "indexed",
      label: "Indexed",
      value: <AnimatedNumber value={stats.total || 0} />,
      unit: "entries",
      hint: `${fmt(stats.enabled || 0)} enabled · ${fmt(stats.disabled || 0)} off`,
    },
    {
      key: "per-entry",
      label: "Catalog per entry",
      value: <AnimatedNumber value={perEntryCatalog} />,
      unit: "tok",
      hint: "name + description, paid every session",
    },
    {
      key: "body",
      label: "Average body",
      value: <AnimatedNumber value={tokens?.average_item || 0} />,
      unit: "tok",
      hint: "loaded only on a hit",
    },
    {
      key: "break",
      label: "Break-even",
      value: <AnimatedNumber value={tokens?.break_even || 0} />,
      unit: "entries",
      hint: "where JIT starts to win",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
      {figures.map((figure) => (
        <div
          key={figure.key}
          className="surface bg-panel/60 p-5 backdrop-blur-xl"
        >
          <div className="kicker">{figure.label}</div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="num display text-3xl leading-none text-ink">
              {figure.value}
            </span>
            <span className="text-xs text-ink-3">{figure.unit}</span>
          </div>
          <div className="mt-2.5 text-xs leading-relaxed text-ink-3">
            {figure.hint}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmbeddingCoverage({ stats }: { stats: Stats }) {
  const coverage = stats.embedding_coverage || {
    total: stats.total || 0,
    embedded: 0,
  };
  const total = Number(coverage.total || 0);
  const embedded = Math.min(total, Number(coverage.embedded || 0));
  const missing = Math.max(0, total - embedded);
  const ratio = total ? embedded / total : 0;
  const complete = total > 0 && missing === 0;

  return (
    <Panel>
      <PanelHead
        title="Embedding coverage"
        hint="vectors available for semantic retrieval"
      />
      <PanelBody className="flex flex-wrap items-center gap-7">
        <Ring
          value={ratio}
          size={132}
          thickness={9}
          tone={complete ? "ok" : missing ? "warn" : "accent"}
          label={`${embedded} of ${total} indexed skills have embedding vectors`}
        >
          <span className="num figure text-2xl text-ink">
            {Math.round(ratio * 100)}
            <span className="text-sm text-ink-3">%</span>
          </span>
          <span className="num mt-1 text-[10px] text-ink-3">
            {fmt(embedded)}/{fmt(total)}
          </span>
        </Ring>

        <div className="min-w-52 flex-1 space-y-3.5">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <span className="inline-flex items-center gap-2 text-ink-2">
              <span className="size-2 rounded-full bg-accent" />
              {fmt(embedded)} embedded
            </span>
            <span className="inline-flex items-center gap-2 text-ink-2">
              <span className="size-2 rounded-full bg-line-2" />
              {fmt(missing)} missing
            </span>
          </div>
          <p className="text-xs leading-relaxed text-ink-3">
            {missing
              ? `${fmt(missing)} skill${missing === 1 ? "" : "s"} ${missing === 1 ? "has" : "have"} no vector yet and cannot be returned by strict JIT_FIND until re-indexed with the embedding model available.`
              : total
                ? "Every indexed skill has a vector and is eligible for semantic retrieval."
                : "Index skills while the embedding model is available to build semantic vectors."}
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

/**
 * Cost per task against index size. A catalog grows without bound; JIT's tool
 * schema is flat. Where the two lines cross is the break-even — and the shaded
 * bands say which side of it the index is on.
 */
function BreakEven({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const schema = Number(tokens?.jit || 0);
  const total = stats.total || 0;
  const breakEven = Number(tokens?.break_even || 0);
  const perEntry = total ? Math.floor((stats.catalog_tokens || 0) / total) : 0;

  if (!schema || !perEntry) {
    return (
      <Panel>
        <PanelHead title="Break-even" hint="the index size where JIT starts to win" />
        <PanelBody>
          <p className="text-sm leading-relaxed text-ink-3">
            Add a few entries and this plots where a plain catalog outgrows JIT's
            fixed tool schema. Below that point, listing your skills is the lighter
            resting context.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  const maxN = Math.max(breakEven + 4, total + 4, 12);
  const catalogAtMax = maxN * perEntry;
  const maxY = Math.max(catalogAtMax, schema) * 1.12;
  const W = 560;
  const H = 236;
  const padL = 50;
  const padR = 16;
  const padT = 20;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (n: number) => padL + (n / maxN) * plotW;
  const y = (v: number) => H - padB - (v / maxY) * plotH;
  // The lines truly meet at schema / perEntry; the integer count is the rounded
  // headline figure.
  const cross = schema / perEntry;
  const catalogLine = `M ${x(0)} ${y(0)} L ${x(maxN)} ${y(catalogAtMax)}`;
  const schemaLine = `M ${x(0)} ${y(schema)} L ${x(maxN)} ${y(schema)}`;

  return (
    <Panel>
      <PanelHead
        title="Break-even"
        hint="cost per task as the index grows · the body is shared, so it is not counted"
      />
      <PanelBody className="space-y-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`Cost per task by index size. A plain catalog grows past JIT's ${fmt(schema)}-token schema at about ${fmt(breakEven)} entries.`}
        >
          <defs>
            <linearGradient id="be-catalog" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-info)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-info)" />
            </linearGradient>
            <linearGradient id="be-schema" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-accent-2)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="var(--color-accent)" />
            </linearGradient>
            <linearGradient id="be-win" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="be-lose" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-bad)" stopOpacity="0.12" />
              <stop offset="100%" stopColor="var(--color-bad)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <rect
            x={x(0)}
            y={y(maxY)}
            width={Math.max(0, x(cross) - x(0))}
            height={y(0) - y(maxY)}
            fill="url(#be-lose)"
          />
          <rect
            x={x(cross)}
            y={y(maxY)}
            width={Math.max(0, x(maxN) - x(cross))}
            height={y(0) - y(maxY)}
            fill="url(#be-win)"
          />

          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const v = maxY * t;
            return (
              <g key={t}>
                <line
                  x1={x(0)}
                  x2={x(maxN)}
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--color-line)"
                  strokeDasharray="2 5"
                />
                <text
                  x={padL - 8}
                  y={y(v) + 3}
                  textAnchor="end"
                  fontSize={9}
                  fill="var(--color-ink-3)"
                  className="num"
                >
                  {fmt(v)}
                </text>
              </g>
            );
          })}

          <line x1={x(0)} x2={x(maxN)} y1={y(0)} y2={y(0)} stroke="var(--color-line-2)" />

          <line
            x1={x(total)}
            x2={x(total)}
            y1={y(0)}
            y2={y(maxY)}
            stroke="var(--color-line-2)"
            strokeDasharray="3 3"
          />
          <line
            x1={x(cross)}
            x2={x(cross)}
            y1={y(0)}
            y2={y(maxY)}
            stroke="var(--color-ink-3)"
            strokeDasharray="3 3"
          />

          {/* Both lines draw themselves in, giving the crossing a moment. */}
          <path
            d={catalogLine}
            fill="none"
            stroke="url(#be-catalog)"
            strokeWidth={2}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            style={{
              ["--draw-from" as string]: "100",
              ["--draw-to" as string]: "0",
            }}
            className="motion-safe:animate-draw"
          />
          <path
            d={schemaLine}
            fill="none"
            stroke="url(#be-schema)"
            strokeWidth={2}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            style={{
              ["--draw-from" as string]: "100",
              ["--draw-to" as string]: "0",
            }}
            className="motion-safe:animate-draw"
          />

          <circle cx={x(cross)} cy={y(schema)} r={4} fill="var(--color-accent)" />
          <circle
            cx={x(cross)}
            cy={y(schema)}
            r={9}
            fill="none"
            stroke="var(--color-accent)"
            strokeOpacity={0.3}
          />
          <circle
            cx={x(total)}
            cy={y(total * perEntry)}
            r={4}
            fill="var(--color-info)"
            stroke="var(--color-panel)"
            strokeWidth={1.5}
          />

          <text x={x(0)} y={H - 9} textAnchor="start" fontSize={9} fill="var(--color-ink-3)">
            0
          </text>
          <text
            x={x(total)}
            y={H - 9}
            textAnchor="middle"
            fontSize={9}
            fill="var(--color-ink-2)"
            className="num"
          >
            you · {fmt(total)}
          </text>
          <text x={x(maxN)} y={H - 9} textAnchor="end" fontSize={9} fill="var(--color-ink-3)">
            {fmt(maxN)} entries
          </text>
          <text
            x={x(cross)}
            y={y(maxY) - 6}
            textAnchor="middle"
            fontSize={9}
            fill="var(--color-accent)"
            className="num"
          >
            break-even · {fmt(breakEven)}
          </text>
        </svg>

        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-xs">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-info" />
            <span className="text-ink-3">Catalog in context</span>
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-accent" />
            <span className="text-ink-3">JIT tool schema</span>
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-info" />
            <span className="text-ink-3">this index</span>
          </span>
        </div>

        <p className="text-xs leading-relaxed text-ink-2">
          {total >= breakEven ? (
            <>
              At {fmt(total)} entries the catalog already outweighs JIT's{" "}
              <span className="num text-ink">{fmt(schema)}</span>-token schema — JIT is
              the smaller resting context, and the gap widens with every entry added.
            </>
          ) : (
            <>
              A catalog grows with every skill you add; JIT's{" "}
              <span className="num text-ink">{fmt(schema)}</span>-token schema does not.
              The two cross at {fmt(breakEven)} entries, and past that JIT wins by more
              with each one.
            </>
          )}
        </p>
      </PanelBody>
    </Panel>
  );
}

/**
 * Usage telemetry from the lookup log: which entries agents actually routed
 * to, which indexed entries never get called (candidates to disable,
 * re-describe, or remove), and what agents asked for that the index could not
 * answer (candidates to install).
 */
function Usage({ usage }: { usage: UsageSummary | null }) {
  const ctx = useJit();

  const windowEmpty = !usage || usage.window === 0;
  const entries = usage?.entries ?? [];
  const max = entries.length ? Math.max(...entries.map((entry) => entry.total), 1) : 1;
  const neverCalled = usage?.never_called ?? [];
  const missed = usage?.missed_intents ?? [];
  const span =
    usage?.span.first && usage.span.last
      ? usage.span.first.slice(0, 10) === usage.span.last.slice(0, 10)
        ? usage.span.first.slice(0, 10)
        : `${usage.span.first.slice(0, 10)} → ${usage.span.last.slice(0, 10)}`
      : null;

  const summary = [
    {
      key: "lookups",
      label: "Lookups",
      value: <AnimatedNumber value={usage?.window ?? 0} />,
      unit: "",
      hint: span ? `logged ${span}` : "from the shared lookup log",
    },
    {
      key: "hit-rate",
      label: "Hit rate",
      value: <AnimatedNumber value={usage ? Math.round(usage.hit_rate * 100) : 0} />,
      unit: "%",
      hint: `${fmt(usage?.hits ?? 0)} answered · ${fmt(usage?.misses ?? 0)} abstained`,
    },
    {
      key: "finds",
      label: "JIT_FIND",
      value: <AnimatedNumber value={usage?.finds ?? 0} />,
      unit: "",
      hint: "searches by intent",
    },
  ];

  return (
    <Panel>
      <PanelHead
        title="Usage"
        hint="what agents actually routed · from the lookup log"
      />
      {windowEmpty ? (
        <PanelBody className="space-y-4">
          <Empty title="No agent lookups logged yet.">
            Connect an agent over MCP and every JIT_FIND lands here —
            which entries get called, how often, and what the index never
            answered.
          </Empty>
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => ctx.setView("lookups")}>
              Open Lookups
            </Button>
          </div>
        </PanelBody>
      ) : (
        <PanelBody className="space-y-6">
          <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
            {summary.map((figure) => (
              <div key={figure.key} className="surface bg-panel/60 p-4">
                <div className="kicker">{figure.label}</div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="num display text-2xl leading-none text-ink">
                    {figure.value}
                  </span>
                  <span className="text-xs text-ink-3">{figure.unit}</span>
                </div>
                <div className="mt-2 text-xs text-ink-3">{figure.hint}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-xs font-medium text-ink-2">
                  Most routed
                </span>
                <span className="num text-[11px] text-ink-3">
                  lookup calls
                </span>
              </div>
              {entries.length === 0 ? (
                <p className="mt-3 text-xs leading-relaxed text-ink-3">
                  Lookups happened, but none returned an entry — every query
                  abstained. Check the Lookups page for what the agents asked.
                </p>
              ) : (
                <div className="mt-3 divide-y divide-line/60">
                  {entries.map((entry, index) => (
                    <div
                      key={`${entry.name}-${index}`}
                      className="px-1 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="truncate text-sm text-ink" title={entry.name}>
                          {entry.name}
                        </span>
                        <span className="num shrink-0 text-xs text-ink-2">
                          {fmt(entry.total)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-accent/40 to-accent"
                            style={{ width: `${pct(entry.total, max)}%` }}
                          />
                        </div>
                        <span className="num shrink-0 text-[10px] text-ink-3">
                          {entry.finds} find{entry.finds === 1 ? "" : "s"}
                          {entry.runs > 0
                            ? ` · ${entry.runs} historical load${entry.runs === 1 ? "" : "s"}`
                            : null}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-6">
              <div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-xs font-medium text-ink-2">
                    Never called
                  </span>
                  <span className="num text-[11px] text-ink-3">
                    indexed, never routed
                  </span>
                </div>
                {neverCalled.length === 0 ? (
                  <p className="mt-3 text-xs leading-relaxed text-ink-3">
                    Every indexed entry has been routed at least once.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {neverCalled.map((name) => (
                      <span
                        key={name}
                        className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-3"
                        title="Indexed but never returned to an agent — consider disabling, re-describing, or removing it."
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {missed.length > 0 ? (
                <div className="border-t border-line pt-5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-xs font-medium text-ink-2">
                      Asked for, not answered
                    </span>
                    <span className="num text-[11px] text-ink-3">
                      repeated asks
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {missed.map((item) => (
                      <span
                        key={item.intent}
                        className="rounded-full border border-warn/40 bg-warn/5 px-2.5 py-1 text-xs text-ink-2"
                        title="The agent searched for this and the gate abstained — a signal for what to install next."
                      >
                        {item.intent} <span className="num">×{item.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </PanelBody>
      )}
    </Panel>
  );
}

export function Overview() {
  const ctx = useJit();
  const stats = ctx.stats;

  if (!stats) {
    return (
      <div className="space-y-10">
        <Hero />
        <Panel>
          <PanelBody className="flex items-center gap-3 text-sm text-ink-2">
            <Spinner />
            Reading the index…
          </PanelBody>
        </Panel>
      </div>
    );
  }

  const total = stats.total || 0;

  return (
    <div className="space-y-8">
      <Hero />

      <InitialLoad stats={stats} />
      <Supporting stats={stats} />

      {total === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <PanelBody className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="text-sm font-medium text-ink">The index is empty.</div>
            <p className="max-w-md text-sm leading-relaxed text-ink-2">
              JIT only indexes what you choose. Import the skills you already
              use.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => void ctx.openTransfer("in")}>
                Transfer skills
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <BreakEven stats={stats} />
        </div>
        <div className="lg:col-span-2">
          <EmbeddingCoverage stats={stats} />
        </div>
      </div>

      <Usage usage={ctx.usage} />

      <Meta className="pt-1">
        index {fmt(total)} entries · {fmt(stats.catalog_tokens || 0)} catalog tokens ·{" "}
        {fmt(stats.body_tokens || 0)} body tokens · largest {fmt(stats.largest || 0)}
      </Meta>
    </div>
  );
}
