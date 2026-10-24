import { useJit } from "../context";
import { fmt, pct } from "../format";
import type { ItemKind, Stats } from "../types";
import { AnimatedNumber, Empty } from "../components/ui";

function Composition({
  stats,
}: {
  stats: Stats;
}) {
  const total = stats.total || 0;
  const kinds = [
    { cls: "skills", label: "Skills", count: stats.skills || 0, color: "var(--accent)" },
    { cls: "tools", label: "Tools", count: stats.tools || 0, color: "var(--ink)" },
  ];
  const states = [
    { cls: "enabled", label: "Enabled", count: stats.enabled || 0, color: "var(--ok)" },
    { cls: "disabled", label: "Disabled", count: stats.disabled || 0, color: "var(--rule-strong)" },
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Index composition</h2>
        <span className="panel-note">
          {fmt(total)} {total === 1 ? "entry" : "entries"}
        </span>
      </div>
      {[
        {
          title: "By kind",
          note: total ? `${Math.round(pct(stats.skills || 0, total))}% skills` : "empty",
          items: kinds,
        },
        {
          title: "By state",
          note: total ? `${fmt(stats.enabled || 0)} of ${fmt(total)} enabled` : "empty",
          items: states,
        },
      ].map((group) => (
        <div className="comp" key={group.title}>
          <div className="comp-head">
            <span>{group.title}</span>
            <span>{group.note}</span>
          </div>
          <div className="comp-bar">
            {group.items
              .filter((item) => item.count > 0)
              .map((item) => (
                <span
                  key={item.cls}
                  className={`comp-seg ${item.cls}`}
                  style={{ width: `${pct(item.count, total)}%` }}
                />
              ))}
          </div>
          <div className="comp-legend">
            {group.items.map((item) => (
              <span key={item.cls}>
                <i className="swatch" style={{ background: item.color }} />
                {item.label}
                <b>{fmt(item.count)}</b>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Heaviest({ stats }: { stats: Stats }) {
  const items = stats.heaviest || [];
  if (!items.length) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Heaviest entries</h2>
          <span className="panel-note">tokens</span>
        </div>
        <Empty title="Nothing indexed.">
          Install or import entries to see their weight.
        </Empty>
      </div>
    );
  }
  const max = Math.max(...items.map((item) => item.tokens), 1);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Heaviest entries</h2>
        <span className="panel-note">tokens</span>
      </div>
      <div>
        {items.map((item, index) => (
          <div className="bar-row" key={`${item.kind}-${item.name}-${index}`}>
            <span className="bar-name" title={item.name}>
              {item.name}
            </span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${pct(item.tokens, max)}%` }}
              />
            </span>
            <span className="bar-num">{fmt(item.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Categories({ stats }: { stats: Stats }) {
  const categories = stats.categories || [];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Categories</h2>
        <span className="panel-note">
          {categories.length ? `${categories.length} declared` : "none declared"}
        </span>
      </div>
      <div className="cat-grid">
        {categories.length ? (
          categories.map((item) => (
            <div className="cat" key={item.name}>
              <span>{item.name}</span>
              <span className="cat-count">{fmt(item.count)}</span>
            </div>
          ))
        ) : (
          <div className="empty" style={{ gridColumn: "1/-1" }}>
            <p>
              No categories yet. Add <code>categories:</code> to skill
              frontmatter or index an MCP server.
            </p>
          </div>
        )}
      </div>
    </div>
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
    <div className="panel">
      <div className="panel-head">
        <h2>Retrieval quality</h2>
        <span className="panel-note">
          {total ? `${fmt(total)} queries logged` : "not measured yet"}
        </span>
      </div>
      {total === 0 ? (
        <p className="panel-copy" style={{ marginBottom: 0 }}>
          Recall is JIT's core promise and it is only worth trusting if it is
          measured. Run queries from Search; every JIT_FIND and dashboard search
          is logged here with its decision and score.
        </p>
      ) : (
        <>
          <div className="figures" style={{ marginTop: 0, borderTop: 0 }}>
            <figure>
              <figcaption>Miss rate</figcaption>
              <div className="figure-value accent">
                <AnimatedNumber value={missRate} decimals={1} />
                <span className="figure-unit">%</span>
              </div>
              <div className="figure-note">
                <span>{fmt(misses)}</span> of {fmt(total)} returned nothing
              </div>
            </figure>
            <figure>
              <figcaption>Hit rate</figcaption>
              <div className="figure-value">
                <AnimatedNumber value={100 - missRate} decimals={1} />
                <span className="figure-unit">%</span>
              </div>
              <div className="figure-note">
                threshold {threshold.toFixed(2)} · tune it in Search
              </div>
            </figure>
          </div>
          <div className="empty-actions">
            <button className="btn" onClick={() => ctx.setView("search")}>
              Inspect retrievals
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Overview() {
  const ctx = useJit();
  const stats = ctx.stats;
  const tokens = stats?.tokens;
  const total = stats?.total || 0;
  const reduction = Number(tokens?.reduction_pct || 0);
  const overhead = Math.max(0, Number(tokens?.jit || 0) - Number(tokens?.static || 0));
  const rawRatio = tokens?.static ? (tokens.jit / tokens.static) * 100 : 0;
  const fillRatio = Math.min(100, rawRatio);
  const breakEven = Number(tokens?.break_even || 0);
  const belowBreakEven = breakEven > 0 && total > 0 && total < breakEven;

  if (!stats) {
    return (
      <div id="view-overview">
        <div className="lede">
          <div className="kicker">The premise</div>
          <h1>
            Load one skill,
            <br />
            <em>not one hundred.</em>
          </h1>
          <p>
            JIT keeps skills and MCP tools in a local index. Your agent asks for
            what it needs; everything else stays out of the context window.
          </p>
        </div>
        <div className="search-pending">Reading the index…</div>
      </div>
    );
  }

  return (
    <div id="view-overview" className={total === 0 ? "is-empty" : ""}>
      <div className="lede">
        <div className="kicker">The premise</div>
        <h1>
          Load one skill,
          <br />
          <em>not one hundred.</em>
        </h1>
        <p>
          JIT keeps skills and MCP tools in a local index. Your agent asks for
          what it needs; everything else stays out of the context window.
        </p>
      </div>

      <div className="figures">
        <figure>
          <figcaption>Context per task</figcaption>
          <div className="figure-value">
            <AnimatedNumber value={tokens?.jit || 0} />
            <span className="figure-unit">tok</span>
          </div>
          <div className="figure-note">
            <span>{fmt(tokens?.static || 0)}</span> tokens if loaded statically
          </div>
        </figure>
        <figure>
          <figcaption>{reduction < 0 ? "Overhead" : "Reduction"}</figcaption>
          <div className="figure-value accent">
            <AnimatedNumber
              value={reduction < 0 ? Math.abs(reduction) : reduction}
              decimals={1}
            />
            <span className="figure-unit">%</span>
          </div>
          <div className="figure-note">
            <span>
              {fmt(reduction < 0 ? overhead : tokens?.saved || 0)}
            </span>{" "}
            {reduction < 0
              ? "tokens of overhead at this index size"
              : "tokens kept out of context"}
          </div>
        </figure>
      </div>

      {total === 0 ? (
        <div className="empty-hero">
          <div className="empty-title">The index is empty.</div>
          <p>
            JIT only indexes what you choose. Start with a skill from the
            marketplace, or import what you already use.
          </p>
          <div className="empty-actions">
            <button
              className="btn btn-solid"
              onClick={() => ctx.setView("marketplace")}
            >
              Browse marketplace
            </button>
            <button className="btn" onClick={() => ctx.openTransfer("in")}>
              Transfer skills
            </button>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Context budget</h2>
          <span className="panel-note">estimate · 4 chars per token</span>
        </div>
        <div className="ruler">
          <div className="ruler-track">
            <span className="ruler-fill" style={{ width: `${fillRatio}%` }} />
            <span
              className="ruler-tag"
              style={
                fillRatio > 78
                  ? { left: "auto", right: "8px", color: "#fff" }
                  : { left: `calc(${fillRatio}% + 9px)`, right: "auto" }
              }
            >
              {rawRatio.toFixed(1)}% of static
            </span>
          </div>
          <div className="ruler-scale">
            <span>0</span>
            <span>25</span>
            <span>50</span>
            <span>75</span>
            <span>100%</span>
          </div>
        </div>
        <div className="ruler-legend">
          <span>
            <i className="swatch accent" />
            JIT per task <b>{fmt(tokens?.jit || 0)} tok</b>
          </span>
          <span>
            <i className="swatch" />
            Static loading <b>{fmt(tokens?.static || 0)} tok</b>
          </span>
        </div>
        <p className="panel-copy" style={{ margin: "18px 0 0" }}>
          {breakEven > 0 ? (
            <>
              Break-even at <b>{fmt(breakEven)}</b> entries: below that, loading
              everything statically costs less per task than JIT's{" "}
              {fmt(tokens?.startup || 0)}-token tool schema.{" "}
              {belowBreakEven ? (
                <span style={{ color: "var(--warn)" }}>
                  This index has {fmt(total)} entries, so JIT is a net cost at
                  this size.
                </span>
              ) : null}
            </>
          ) : (
            "Add entries to estimate the break-even point."
          )}
        </p>
      </div>

      <Quality stats={stats} />

      <div className="columns">
        <Composition stats={stats} />
        <Heaviest stats={stats} />
      </div>

      <Categories stats={stats} />
    </div>
  );
}
