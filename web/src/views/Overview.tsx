import { fmt, pct } from "../format";
import { useJit } from "../state/store";
import type { Stats } from "../types";
import { Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { AnimatedNumber, Empty, Spinner, Stat } from "../ui/Display";
import { Panel, PanelBody, PanelHead } from "../ui/Panel";

/** The one-line thesis of the product, above the fold. */
function Hero() {
  return (
    <header className="motion-safe:animate-rise">
      <div className="kicker">Overview</div>
      <h1 className="display mt-4 text-[2.5rem] text-ink sm:text-[3.25rem] lg:text-[4rem]">
        Load one skill,
        <br />
        <span className="text-ink-3">not one hundred.</span>
      </h1>
      <p className="mt-6 max-w-lg text-sm leading-relaxed text-ink-2">
        Every agent keeps a list of what it could do — names and descriptions,
        sitting in the context window. JIT keeps a single fixed tool schema
        instead, and fetches a skill's body only when a task needs it.
      </p>
    </header>
  );
}

/** The three headline figures, separated by true hairlines. */
function Figures({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const jit = Number(tokens?.jit || 0);
  const catalog = Number(tokens?.catalog || 0);
  // How many times lighter JIT is at rest — a ratio reads as a claim, where a
  // percentage reads as a rounding error.
  const multiple = jit > 0 ? catalog / jit : 0;
  const lighter = multiple >= 1;
  const overhead = Math.max(0, jit - catalog);
  const breakEven = Number(tokens?.break_even || 0);
  const total = stats.total || 0;
  const belowBreakEven = breakEven > 0 && total > 0 && total < breakEven;

  const cells = [
    {
      key: "indexed",
      label: "Indexed",
      value: <AnimatedNumber value={stats.total || 0} />,
      unit: "entries",
      hint: `${fmt(stats.enabled || 0)} enabled`,
    },
    {
      key: "rest",
      label: "Context at rest",
      value: <AnimatedNumber value={jit} />,
      unit: "tok",
      hint: `${fmt(catalog)} for a plain catalog`,
    },
    {
      key: "reduction",
      label: lighter ? "Context saved" : "Overhead",
      value: (
        <AnimatedNumber
          value={lighter ? multiple : multiple ? 1 / multiple : 0}
          decimals={1}
        />
      ),
      unit: "×",
      hint: `${fmt(lighter ? tokens?.saved || 0 : overhead)} tokens ${
        lighter ? "kept out of context" : "over a catalog"
      }`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
        {cells.map((cell) => (
          <div key={cell.key} className="bg-panel p-5 md:p-6">
            <Stat
              size="lg"
              label={cell.label}
              value={cell.value}
              unit={cell.unit}
              hint={cell.hint}
            />
          </div>
        ))}
      </div>
      {belowBreakEven ? (
        <p className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-3">
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />
          <span>
            Below the <span className="num text-ink-2">{fmt(breakEven)}</span>-entry
            break-even. JIT's{" "}
            <span className="num text-ink-2">{fmt(jit)}</span>-token tool schema is
            smaller than a catalog only once there are more entries than that — at{" "}
            {fmt(total)} {total === 1 ? "entry" : "entries"} a plain catalog (
            <span className="num text-ink-2">{fmt(catalog)}</span> tok) is the lighter
            resting context. JIT wins at {fmt(breakEven)} entries or more.
          </span>
        </p>
      ) : null}
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
  const percentage = Math.round(ratio * 100);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const embeddedLength = circumference * ratio;

  return (
    <Panel>
      <PanelHead
        title="Embedding coverage"
        hint="vectors available for semantic retrieval"
      />
      <PanelBody className="flex flex-wrap items-center gap-6">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${embedded} of ${total} indexed skills have embedding vectors`}
          className="size-28 shrink-0"
        >
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            className="text-line-2"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${embeddedLength} ${circumference}`}
            transform="rotate(-90 50 50)"
            className="text-accent"
          />
          <text
            x="50"
            y="47"
            textAnchor="middle"
            className="num fill-ink text-[18px] font-semibold"
          >
            {percentage}%
          </text>
          <text
            x="50"
            y="62"
            textAnchor="middle"
            className="num fill-ink-3 text-[7px]"
          >
            {fmt(embedded)} / {fmt(total)} skills
          </text>
        </svg>

        <div className="min-w-52 flex-1 space-y-3">
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
 * The comparison that carries the whole product: what each approach keeps in
 * the context window before any task runs. The body a task loads is identical
 * on both sides, so it is shown as shared rather than counted.
 */
function StandingContext({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const jit = Number(tokens?.jit || 0);
  const catalog = Number(tokens?.catalog || 0);
  const body = Number(tokens?.average_item || 0);
  const scale = Math.max(jit, catalog, 1);
  const delta = jit - catalog;
  const rows = [
    {
      key: "catalog",
      label: "Plain skills",
      note: "every name + description",
      value: catalog,
      bar: "bg-info",
    },
    {
      key: "jit",
      label: "JIT",
      note: "one fixed tool schema",
      value: jit,
      bar: "bg-accent",
    },
  ];

  return (
    <Panel>
      <PanelHead title="Context at rest" hint="before an agent asks for anything" />
      <PanelBody className="space-y-6">
        <div className="space-y-4">
          {rows.map((row) => (
            <div key={row.key}>
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="text-sm text-ink">{row.label}</span>
                  <span className="hidden truncate text-xs text-ink-3 sm:inline">
                    {row.note}
                  </span>
                </span>
                <span className="num shrink-0 text-sm text-ink">
                  {fmt(row.value)}
                  <span className="ml-1 text-[11px] text-ink-3">tok</span>
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                <div
                  className={`h-full rounded-full ${row.bar}`}
                  style={{ width: `${pct(row.value, scale)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-line bg-inset/60 p-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-xs text-ink-2">The skill body</span>
            <span className="num text-xs text-ink-3">
              ~{fmt(body)} tok · on demand
            </span>
          </div>
          <div
            aria-hidden="true"
            className="mt-2.5 h-2 rounded-full border border-dashed border-line-2"
          />
          <p className="mt-2.5 text-xs leading-relaxed text-ink-3">
            Fetched only when a task needs it — by both approaches. It is identical
            on each side, so it is not part of the comparison.
          </p>
        </div>

        <p className="border-t border-line pt-5 text-sm leading-relaxed">
          {delta > 0 ? (
            <>
              At rest, JIT carries <span className="num text-warn">{fmt(delta)}</span>{" "}
              more tokens than a plain catalog — a net cost until the catalog grows
              past it.
            </>
          ) : (
            <>
              At rest, JIT carries{" "}
              <span className="num text-accent">{fmt(-delta)}</span> fewer tokens than
              a plain catalog.
            </>
          )}
        </p>
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
          <rect
            x={x(0)}
            y={y(maxY)}
            width={Math.max(0, x(cross) - x(0))}
            height={y(0) - y(maxY)}
            fill="var(--color-bad)"
            fillOpacity={0.045}
          />
          <rect
            x={x(cross)}
            y={y(maxY)}
            width={Math.max(0, x(maxN) - x(cross))}
            height={y(0) - y(maxY)}
            fill="var(--color-accent)"
            fillOpacity={0.05}
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

          <line
            x1={x(0)}
            y1={y(0)}
            x2={x(maxN)}
            y2={y(catalogAtMax)}
            stroke="var(--color-info)"
            strokeWidth={2}
          />
          <line
            x1={x(0)}
            y1={y(schema)}
            x2={x(maxN)}
            y2={y(schema)}
            stroke="var(--color-accent)"
            strokeWidth={2}
          />

          <circle cx={x(cross)} cy={y(schema)} r={4} fill="var(--color-accent)" />
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

function Composition({ stats }: { stats: Stats }) {
  const total = stats.total || 0;
  const groups = [
    {
      title: "By state",
      note: total ? `${fmt(stats.enabled || 0)} of ${fmt(total)} enabled` : "empty",
      items: [
        { key: "enabled", label: "Enabled", count: stats.enabled || 0, seg: "bg-ok" },
        { key: "disabled", label: "Disabled", count: stats.disabled || 0, seg: "bg-line-2" },
      ],
    },
  ];

  return (
    <Panel>
      <PanelHead
        title="Index composition"
        hint={`${fmt(total)} ${total === 1 ? "entry" : "entries"}`}
      />
      <PanelBody className="space-y-7">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-ink-2">{group.title}</span>
              <span className="num text-[11px] text-ink-3">{group.note}</span>
            </div>
            <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-line">
              {group.items
                .filter((item) => item.count > 0)
                .map((item) => (
                  <span
                    key={item.key}
                    className={item.seg}
                    style={{ width: `${pct(item.count, total)}%` }}
                  />
                ))}
            </div>
            <div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2 text-xs">
              {group.items.map((item) => (
                <span key={item.key} className="flex items-center gap-2">
                  <span aria-hidden="true" className={`size-2 rounded-full ${item.seg}`} />
                  <span className="text-ink-3">{item.label}</span>
                  <span className="num font-medium text-ink">{fmt(item.count)}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}

function Heaviest({ stats }: { stats: Stats }) {
  const items = stats.heaviest || [];
  const max = items.length ? Math.max(...items.map((item) => item.tokens), 1) : 1;

  return (
    <Panel>
      <PanelHead title="Heaviest entries" hint="full SKILL.md body · fetched on demand" />
      {items.length === 0 ? (
        <Empty title="Nothing indexed.">
          Install or import entries to see their weight.
        </Empty>
      ) : (
        <div className="divide-y divide-line/60">
          {items.map((item, index) => (
            <div key={`${item.name}-${index}`} className="px-5 py-3.5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-ink" title={item.name}>
                    {item.name}
                  </span>
                </span>
                <span className="num shrink-0 text-xs text-ink-2">
                  {fmt(item.tokens)}
                </span>
              </div>
              <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent/70"
                  style={{ width: `${pct(item.tokens, max)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
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
    <div className="space-y-10">
      <Hero />

      <Figures stats={stats} />
      <EmbeddingCoverage stats={stats} />

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
          <StandingContext stats={stats} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Heaviest stats={stats} />
        <Composition stats={stats} />
      </div>

      <Meta className="pt-1">
        index {fmt(total)} entries · {fmt(stats.catalog_tokens || 0)} catalog tokens ·{" "}
        {fmt(stats.body_tokens || 0)} body tokens · largest {fmt(stats.largest || 0)}
      </Meta>
    </div>
  );
}
