import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api } from "../api";
import { useJit } from "../context";
import { fmt } from "../format";
import type {
  MarketplaceItem,
  MarketplaceTopResponse,
} from "../types";
import { Empty } from "../components/ui";

type Filter = "all" | "skill" | "mcp";
type TopView = "all-time" | "trending";

export function Marketplace() {
  const ctx = useJit();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [catalogUrl, setCatalogUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Browsing the directory: a search, and its own ranking.
  const [needle, setNeedle] = useState("");
  const [found, setFound] = useState<{ query: string; items: MarketplaceItem[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [topView, setTopView] = useState<TopView>("all-time");
  const [top, setTop] = useState<MarketplaceTopResponse | null>(null);
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState("");

  useEffect(() => {
    if (!ctx.marketLoaded) void ctx.loadMarketplace();
  }, [ctx.marketLoaded]);

  const loadTop = useCallback(
    async (which: TopView, page = 1, append = false): Promise<void> => {
      setTopLoading(true);
      setTopError("");
      try {
        const data = await api<MarketplaceTopResponse>(
          `/api/marketplace/top?view=${which}&page=${page}`,
        );
        setTop((current) =>
          append && current && current.view === data.view
            ? { ...data, items: [...current.items, ...data.items] }
            : data,
        );
      } catch (error) {
        setTopError(error instanceof Error ? error.message : String(error));
      } finally {
        setTopLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadTop(topView);
  }, [topView, loadTop]);

  const data = ctx.marketplace || { items: [], source: "", warning: "" };
  const items = data.items || [];
  const counts = { all: items.length, skill: 0, mcp: 0 };
  for (const item of items) counts[item.kind] += 1;

  const filterNeedle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (filter !== "all" && item.kind !== filter) return false;
    if (!filterNeedle) return true;
    return `${item.name} ${item.category} ${item.description}`
      .toLowerCase()
      .includes(filterNeedle);
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await ctx.loadMarketplace(true);
    } finally {
      setRefreshing(false);
    }
  };

  const searchDirectory = async (event: FormEvent) => {
    event.preventDefault();
    const value = needle.trim();
    if (value.length < 2) {
      setSearchError("Type at least two characters.");
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const result = await api<{ items: MarketplaceItem[]; warning: string }>(
        `/api/marketplace/search?q=${encodeURIComponent(value)}`,
      );
      setFound({ query: value, items: result.items || [] });
      if (result.warning) setSearchError(result.warning);
    } catch (error) {
      setFound(null);
      setSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  };

  const addCatalog = async (event: FormEvent) => {
    event.preventDefault();
    const value = catalogUrl.trim();
    if (!value) return;
    const current = Array.isArray(ctx.config?.marketplace_urls)
      ? ctx.config.marketplace_urls
      : [];
    if (current.includes(value)) {
      setCatalogUrl("");
      await ctx.loadMarketplace(true);
      return;
    }
    setAdding(true);
    try {
      await ctx.saveConfig({ marketplace_urls: [...current, value] });
      setCatalogUrl("");
      await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setAdding(false);
    }
  };

  const uninstall = async (item: MarketplaceItem) => {
    const isMcp = item.kind === "mcp";
    const ok = await ctx.confirmAction(
      isMcp ? "Remove this MCP server?" : "Uninstall this skill?",
      isMcp
        ? `JIT will stop managing "${item.name}" and remove its indexed tools. The external server and its own config are untouched.`
        : `"${item.name}" is a JIT-owned copy at ${ctx.config?.index_dir || "~/.jit"}/skills/${item.id}/SKILL.md. This deletes the copy and removes it from the index. Your original local file, if any, is untouched.`,
      isMcp ? "Remove" : "Uninstall",
    );
    if (!ok) return;
    try {
      const result = await ctx.api<{ tools_removed?: number }>(
        "/api/marketplace/uninstall",
        { method: "POST", body: JSON.stringify({ id: item.id }) },
      );
      ctx.toast(
        isMcp
          ? `Removed ${item.name} · ${fmt(result.tools_removed || 0)} tools.`
          : `Uninstalled ${item.name}.`,
      );
      await ctx.refreshAll();
      await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="kicker">03 — Marketplace</div>
          <h2 className="section-title">Install what you need.</h2>
        </div>
        <div className="section-actions">
          <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh catalog"}
          </button>
        </div>
      </div>

        <p className="section-copy">
          Two ways in. Browse the open <code>skills.sh</code> directory by search
          or by its own ranking, and install any entry straight from there; or
          point JIT at a source of your own — a catalog JSON URL, a GitHub
          repository (<code>owner/repo</code>, or a repo link), or a skills.sh
          link. Repository sources are resolved by the open <code>skills</code>{" "}
          CLI, which JIT runs and imports into its own store. Every entry is
          marked third-party and scanned for risky patterns before it installs,
          and nothing installs until you choose it.
        </p>

      <form className="add-row" onSubmit={addCatalog}>
        <input
          type="text"
          placeholder="https://example.com/catalog.json, owner/repo, or a skills.sh link"
          spellCheck={false}
          autoComplete="off"
          value={catalogUrl}
          onChange={(event) => setCatalogUrl(event.target.value)}
        />
        <button className="btn btn-solid" type="submit" disabled={adding}>
          {adding ? "Adding…" : "Add source"}
        </button>
      </form>

      <div className="market-toolbar">
        <div className="market-filters">
          {(["all", "skill", "mcp"] as const).map((kind) => (
            <button
              key={kind}
              className={`filter${filter === kind ? " is-active" : ""}`}
              onClick={() => setFilter(kind)}
            >
              {kind === "all" ? "All" : kind === "skill" ? "Skills" : "MCP"}{" "}
              <span>{counts[kind]}</span>
            </button>
          ))}
        </div>
        <input
          className="market-search"
          type="search"
          placeholder="Filter by name or category"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <p className={`market-note${data.warning ? " is-warn" : ""}`}>
        {data.source === "remote" ? "Configured sources" : "No sources configured"}
        {data.warning ? ` · ${data.warning}` : ""}
      </p>

      {filtered.length === 0 ? (
        <Empty
          title={items.length ? "Nothing matches." : "No sources configured yet."}
        >
          {items.length
            ? "Try a different filter, or refresh the catalog."
            : "Install anything from the skills.sh directory below, or add a catalog URL or repository above."}
        </Empty>
      ) : (
        <div className="market-grid">
          {filtered.map((item) => (
            <MarketCard
              key={item.id}
              item={item}
              onInstall={() => ctx.openMarket(item)}
              onUninstall={() => void uninstall(item)}
            />
          ))}
        </div>
      )}

      <div className="discover-head">
        <div className="kicker">Browse the skills.sh directory</div>
        <span className="market-note">
          Search and rankings come from{" "}
          <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">
            skills.sh
          </a>
        </span>
      </div>

      <form className="add-row" onSubmit={searchDirectory}>
        <input
          type="search"
          placeholder="Search skills.sh — for example: react, playwright, pdf"
          spellCheck={false}
          autoComplete="off"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
        <button className="btn btn-solid" type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {searchError ? <p className="market-note is-warn">{searchError}</p> : null}

      {found ? (
        found.items.length ? (
          <div className="discover-list">
            {found.items.map((item) => (
              <DiscoverRow
                key={item.id}
                item={item}
                onInstall={() => ctx.openMarket(item)}
                onManage={() => ctx.setView("skills")}
              />
            ))}
          </div>
        ) : (
          <p className="market-note">Nothing matched “{found.query}”.</p>
        )
      ) : null}

      <div className="market-toolbar">
        <div className="market-filters">
          <button
            className={`filter${topView === "all-time" ? " is-active" : ""}`}
            onClick={() => setTopView("all-time")}
          >
            Top skills
          </button>
          <button
            className={`filter${topView === "trending" ? " is-active" : ""}`}
            onClick={() => setTopView("trending")}
          >
            Trending
          </button>
        </div>
        <span className="market-note">
          {topView === "all-time" ? "Most installed" : "Gaining installs now"}
          {top ? ` · ${fmt(top.total)} listed` : ""}
        </span>
      </div>

      {topError ? <p className="market-note is-warn">{topError}</p> : null}

      {top && top.items.length ? (
        <>
          <div className="discover-list">
            {top.items.map((item, index) => (
              <DiscoverRow
                key={item.id}
                item={item}
                rank={(top.page - 1) * 200 + index + 1}
                onInstall={() => ctx.openMarket(item)}
                onManage={() => ctx.setView("skills")}
              />
            ))}
          </div>
          {top.has_more ? (
            <div className="discover-more">
              <button
                className="btn"
                disabled={topLoading}
                onClick={() => void loadTop(topView, top.page + 1, true)}
              >
                {topLoading ? "Loading…" : "Show more"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="market-note">
          {topLoading ? "Loading the ranking…" : "The ranking is unavailable."}
        </p>
      )}
    </div>
  );
}

function DiscoverRow({
  item,
  rank,
  onInstall,
  onManage,
}: {
  item: MarketplaceItem;
  rank?: number;
  onInstall: () => void;
  onManage: () => void;
}) {
  return (
    <div className="discover-row">
      {rank != null ? <span className="discover-rank">{rank}</span> : null}
      <div className="discover-main">
        <span className="discover-name">{item.name}</span>
        <span className="discover-source">{item.origin}</span>
      </div>
      {item.installs ? (
        <span className="discover-installs">{fmt(item.installs)} installs</span>
      ) : null}
      {item.installed ? (
        <>
          <span className="market-installed">
            <i className="dot ok" />
            Installed
          </span>
          <button className="btn" onClick={onManage}>
            Manage
          </button>
        </>
      ) : (
        <button className="btn btn-solid" onClick={onInstall}>
          Install
        </button>
      )}
    </div>
  );
}

function MarketCard({
  item,
  onInstall,
  onUninstall,
}: {
  item: MarketplaceItem;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const installed = Boolean(item.installed);
  const kind = item.kind === "mcp" ? "MCP" : "Skill";
  const sourceLink =
    item.source && /^https?:\/\//.test(item.source) ? (
      <a
        className="btn-mini"
        href={item.source}
        target="_blank"
        rel="noopener noreferrer"
      >
        Source ↗
      </a>
    ) : null;

  return (
    <article className={`market-card${installed ? " is-installed" : ""}`}>
      <div className="market-top">
        <span className="tag">{kind}</span>
        <span className="market-cat">{item.category}</span>
      </div>
      <h3 className="market-name">{item.name}</h3>
      <p className="market-desc">{item.description}</p>
      <div className="market-meta">
        <span>{item.author || "Unknown"}</span>
        <span>{item.license || "See source"}</span>
        <span>Third-party</span>
        {item.origin ? (
          <span className="market-origin">{item.origin}</span>
        ) : null}
        {item.checksum_present === false ? (
          <span className="market-warn">unpinned</span>
        ) : null}
        {item.requires ? <span>{item.requires}</span> : null}
      </div>
      <div className="market-actions">
        {installed ? (
          <>
            <span className="market-installed">
              <i className="dot ok" />
              Installed
            </span>
            {sourceLink}
            <button className="btn-mini danger" onClick={onUninstall}>
              {item.kind === "skill" ? "Uninstall" : "Remove"}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-solid" onClick={onInstall}>
              Install
            </button>
            {sourceLink}
          </>
        )}
      </div>
    </article>
  );
}
