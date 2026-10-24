import { useEffect, useState, type FormEvent } from "react";

import { useJit } from "../context";
import { fmt } from "../format";
import type { MarketplaceItem } from "../types";
import { Empty } from "../components/ui";

type Filter = "all" | "skill" | "mcp";

export function Marketplace() {
  const ctx = useJit();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [catalogUrl, setCatalogUrl] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!ctx.marketLoaded) void ctx.loadMarketplace();
  }, [ctx.marketLoaded]);

  const data = ctx.marketplace || { items: [], source: "", warning: "" };
  const items = data.items || [];
  const counts = { all: items.length, skill: 0, mcp: 0 };
  for (const item of items) counts[item.kind] += 1;

  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (filter !== "all" && item.kind !== filter) return false;
    if (!needle) return true;
    return `${item.name} ${item.category} ${item.description}`
      .toLowerCase()
      .includes(needle);
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await ctx.loadMarketplace(true);
    } finally {
      setRefreshing(false);
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
        User-defined catalogs only. Add a catalog URL below; nothing is
        installed until you choose it.
      </p>

      <form className="add-row" onSubmit={addCatalog}>
        <input
          type="url"
          placeholder="https://example.com/catalog.json"
          spellCheck={false}
          autoComplete="off"
          value={catalogUrl}
          onChange={(event) => setCatalogUrl(event.target.value)}
        />
        <button className="btn btn-solid" type="submit" disabled={adding}>
          {adding ? "Adding…" : "Add catalog"}
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
        {data.source === "remote"
          ? "Remote catalog"
          : "No catalog configured"}
        {data.warning ? ` · ${data.warning}` : ""}
      </p>

      {filtered.length === 0 ? (
        <Empty
          title={items.length ? "Nothing matches." : "The catalog is empty."}
        >
          {items.length
            ? "Try a different filter, or refresh the catalog."
            : "No marketplace catalogs configured. Add one in Settings."}
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
