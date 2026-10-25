import { fmt, pct } from "../format";
import { useJit } from "../state/store";
import type { Stats } from "../types";
import { Badge, Meta } from "../ui/Badge";
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
        JIT keeps skills and MCP tools in a local index. Your agent asks for what
        it needs; everything else stays out of the context window.
      </p>
    </header>
  );
}

/** The four headline figures, separated by true hairlines. */
function Figures({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const reduction = Number(tokens?.reduction_pct || 0);
  const overhead = Math.max(
    0,
    Number(tokens?.jit || 0) - Number(tokens?.static || 0),
  );
  const retrieval = stats.retrieval;
  const measured = Number(retrieval?.total || 0) > 0;
  const missRate = Number(retrieval?.miss_rate || 0);
  const breakEven = Number(tokens?.break_even || 0);
  const total = stats.total || 0;
  const belowBreakEven = breakEven > 0 && total > 0 && total < breakEven;

  const cells = [
    {
      key: "indexed",
      label: "Indexed",
      value: <AnimatedNumber value={stats.total || 0} />,
      unit: "entries",
      hint: `${fmt(stats.skills || 0)} skills · ${fmt(stats.tools || 0)} tools`,
    },
    {
      key: "context",
      label: "Context per task",
      value: <AnimatedNumber value={tokens?.jit || 0} />,
      unit: "tok",
      hint: `${fmt(tokens?.static || 0)} if loaded statically`,
    },
    {
      key: "reduction",
      label: reduction < 0 ? "Overhead" : "Reduction",
      value: (
        <AnimatedNumber
          value={reduction < 0 ? Math.abs(reduction) : reduction}
          decimals={1}
        />
      ),
      unit: "%",
      hint: `${fmt(reduction < 0 ? overhead : tokens?.saved || 0)} tokens ${
        reduction < 0 ? "of overhead" : "kept out of context"
      }`,
    },
    {
      key: "recall",
      label: "Recall",
      value: measured ? (
        <AnimatedNumber value={100 - missRate} decimals={1} />
      ) : (
        "—"
      ),
      unit: measured ? "%" : undefined,
      hint: measured
        ? `${fmt(retrieval?.misses || 0)} of ${fmt(retrieval?.total || 0)} missed`
        : "not measured yet",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
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
            <span className="num text-ink-2">{fmt(tokens?.startup || 0)}</span>-token
            tool schema is a fixed cost, so at {fmt(total)}{" "}
            {total === 1 ? "entry" : "entries"} loading everything statically (
            <span className="num text-ink-2">{fmt(tokens?.static || 0)}</span> tok) is
            cheaper per task. JIT wins at {fmt(breakEven)} entries or more.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function Composition({ stats }: { stats: Stats }) {
  const total = stats.total || 0;
  const groups = [
    {
      title: "By kind",
      note: total ? `${Math.round(pct(stats.skills || 0, total))}% skills` : "empty",
      items: [
        { key: "skills", label: "Skills", count: stats.skills || 0, seg: "bg-accent" },
        { key: "tools", label: "Tools", count: stats.tools || 0, seg: "bg-ink-2/60" },
      ],
    },
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
      <PanelHead title="Heaviest entries" hint="body tokens" />
      {items.length === 0 ? (
        <Empty title="Nothing indexed.">
          Install or import entries to see their weight.
        </Empty>
      ) : (
        <div className="divide-y divide-line/60">
          {items.map((item, index) => (
            <div key={`${item.kind}-${item.name}-${index}`} className="px-5 py-3.5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-ink" title={item.name}>
                    {item.name}
                  </span>
                  <Badge tone={item.kind === "skill" ? "accent" : "neutral"}>
                    {item.kind}
                  </Badge>
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

function Categories({ stats }: { stats: Stats }) {
  const categories = stats.categories || [];
  return (
    <Panel>
      <PanelHead
        title="Categories"
        hint={categories.length ? `${categories.length} declared` : "none declared"}
      />
      {categories.length ? (
        <PanelBody className="flex flex-wrap gap-2">
          {categories.map((item) => (
            <span
              key={item.name}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-inset px-3 py-1 text-xs"
            >
              <span className="text-ink-2">{item.name}</span>
              <span className="num text-ink-3">{fmt(item.count)}</span>
            </span>
          ))}
        </PanelBody>
      ) : (
        <PanelBody>
          <p className="text-sm leading-relaxed text-ink-3">
            No categories yet. Add{" "}
            <code className="num rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-2">
              categories:
            </code>{" "}
            to skill frontmatter, or index an MCP server.
          </p>
        </PanelBody>
      )}
    </Panel>
  );
}

function Quality({ stats }: { stats: Stats }) {
  const ctx = useJit();
  const retrieval = stats.retrieval;
  const total = retrieval?.total || 0;
  const misses = retrieval?.misses || 0;
  const missRate = Number(retrieval?.miss_rate || 0);
  const threshold = Number(ctx.config?.confidence_threshold ?? 0.6);

  return (
    <Panel>
      <PanelHead
        title="Retrieval quality"
        hint={total ? `${fmt(total)} queries logged` : "not measured yet"}
        actions={
          total ? (
            <Button size="sm" onClick={() => ctx.setView("search")}>
              Inspect
            </Button>
          ) : null
        }
      />
      {total === 0 ? (
        <PanelBody>
          <p className="max-w-md text-sm leading-relaxed text-ink-2">
            Recall is JIT's core promise and is only worth trusting once it is
            measured. Run queries from Search — every JIT_FIND and dashboard
            search is logged with its decision and score.
          </p>
        </PanelBody>
      ) : (
        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
          <div className="bg-panel p-5">
            <Stat
              label="Miss rate"
              value={<AnimatedNumber value={missRate} decimals={1} />}
              unit="%"
              hint={`${fmt(misses)} of ${fmt(total)} returned nothing`}
            />
          </div>
          <div className="bg-panel p-5">
            <Stat
              label="Hit rate"
              value={<AnimatedNumber value={100 - missRate} decimals={1} />}
              unit="%"
              hint={`threshold ${threshold.toFixed(2)}`}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function Budget({ stats }: { stats: Stats }) {
  const tokens = stats.tokens;
  const rawRatio = tokens?.static ? (tokens.jit / tokens.static) * 100 : 0;
  const fillRatio = Math.min(100, rawRatio);
  const breakEven = Number(tokens?.break_even || 0);
  const total = stats.total || 0;
  const belowBreakEven = breakEven > 0 && total > 0 && total < breakEven;

  return (
    <Panel>
      <PanelHead title="Context budget" hint="estimate · 4 characters per token" />
      <PanelBody className="space-y-5">
        <div>
          <div className="flex items-baseline justify-between gap-4 text-xs">
            <span className="text-ink-2">One JIT call against loading everything</span>
            <span className="num text-ink">{rawRatio.toFixed(1)}% of static</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${fillRatio}%` }}
            />
          </div>
          <div className="num mt-2 flex justify-between text-[10px] text-ink-3">
            <span>0</span>
            <span>25</span>
            <span>50</span>
            <span>75</span>
            <span>100%</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-7 gap-y-2 border-t border-line pt-5 text-xs">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
            <span className="text-ink-3">JIT per task</span>
            <span className="num font-medium text-ink">
              {fmt(tokens?.jit || 0)} tok
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-line-2" />
            <span className="text-ink-3">Static loading</span>
            <span className="num font-medium text-ink">
              {fmt(tokens?.static || 0)} tok
            </span>
          </span>
        </div>

        <p className="border-t border-line pt-5 text-xs leading-relaxed text-ink-3">
          {breakEven > 0 ? (
            <>
              Break-even at <span className="num text-ink-2">{fmt(breakEven)}</span>{" "}
              entries: below that, loading everything statically costs less per task
              than JIT's{" "}
              <span className="num text-ink-2">{fmt(tokens?.startup || 0)}</span>
              -token tool schema.{" "}
              {belowBreakEven ? (
                <span className="text-warn">
                  This index has {fmt(total)} entries, so JIT is a net cost at this
                  size.
                </span>
              ) : null}
            </>
          ) : (
            "Add entries to estimate the break-even point."
          )}
        </p>
      </PanelBody>
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

      {total === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <PanelBody className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="text-sm font-medium text-ink">The index is empty.</div>
            <p className="max-w-md text-sm leading-relaxed text-ink-2">
              JIT only indexes what you choose. Start with a skill from the
              marketplace, or import what you already use.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => ctx.setView("marketplace")}>
                Browse marketplace
              </Button>
              <Button onClick={() => void ctx.openTransfer("in")}>
                Transfer skills
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <Budget stats={stats} />
        <div className="lg:col-span-2">
          <Quality stats={stats} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Composition stats={stats} />
        <Heaviest stats={stats} />
      </div>

      <Categories stats={stats} />

      <Meta className="pt-1">
        index {fmt(total)} entries · {fmt(stats.catalog_tokens || 0)} catalog tokens ·{" "}
        {fmt(stats.body_tokens || 0)} body tokens · largest {fmt(stats.largest || 0)}
      </Meta>
    </div>
  );
}
