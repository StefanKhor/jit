import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api } from "../api";
import { fmt } from "../format";
import { useJit } from "../state/store";
import type { MarketplaceItem, MarketplaceTopResponse } from "../types";
import { Badge, Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Display";
import { Input } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { Segmented } from "../ui/Segmented";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";

type Filter = "all" | "skill" | "mcp";
type TopView = "all-time" | "trending";
type Section = "catalog" | "discover";

export function Marketplace() {
  const ctx = useJit();
  const [section, setSection] = useState<Section>("catalog");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [catalogUrl, setCatalogUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Browsing the directory: a search, and its own ranking.
  const [needle, setNeedle] = useState("");
  const [found, setFound] = useState<{
    query: string;
    items: MarketplaceItem[];
  } | null>(null);
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
    <div className="space-y-6">
      <PageHead
        kicker="03 — Marketplace"
        title="Install what you need."
        description={
          <>
            Two ways in. Browse the open <code className="num">skills.sh</code>{" "}
            directory by search or by its own ranking, and install any entry
            straight from there; or point JIT at a source of your own — a catalog
            JSON URL, a GitHub repository (<code className="num">owner/repo</code>
            , or a repo link), or a skills.sh link. Every entry is marked
            third-party and scanned for risky patterns before it installs, and
            nothing installs until you choose it.
          </>
        }
        actions={
          <Button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh catalog"}
          </Button>
        }
      />

      <Tabs
        value={section}
        onValueChange={(value) =>
          setSection(value === "discover" ? "discover" : "catalog")
        }
      >
        <TabList label="Marketplace sections">
          <Tab value="catalog">
            Catalog
            {items.length ? (
              <span className="num text-[10px] text-ink-3">
                {fmt(items.length)}
              </span>
            ) : null}
          </Tab>
          <Tab value="discover">Discover</Tab>
        </TabList>

        <TabPanel value="catalog" className="mt-6 space-y-6">
          <Panel>
            <PanelHead
              title="Sources"
              hint={
                data.source === "remote"
                  ? "Configured sources"
                  : "No sources configured"
              }
              actions={data.warning ? <Badge tone="warn">warning</Badge> : null}
            />
            <PanelBody className="space-y-3">
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={addCatalog}>
                <Input
                  type="text"
                  className="flex-1"
                  aria-label="Marketplace source"
                  placeholder="https://example.com/catalog.json, owner/repo, or a skills.sh link"
                  spellCheck={false}
                  autoComplete="off"
                  value={catalogUrl}
                  onChange={(event) => setCatalogUrl(event.target.value)}
                />
                <Button type="submit" variant="primary" disabled={adding}>
                  {adding ? "Adding…" : "Add source"}
                </Button>
              </form>
              {data.warning ? (
                <p className="text-xs leading-relaxed text-warn">{data.warning}</p>
              ) : null}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Catalog" hint={`${fmt(items.length)} entries`} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
              <Segmented
                label="Filter by kind"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "skill", label: "Skills", count: counts.skill },
                  { value: "mcp", label: "MCP", count: counts.mcp },
                ]}
              />
              <Input
                type="search"
                className="w-full sm:w-64"
                aria-label="Filter catalog"
                placeholder="Filter by name or category"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {filtered.length === 0 ? (
              <Empty
                title={
                  items.length ? "Nothing matches." : "No sources configured yet."
                }
              >
                {items.length
                  ? "Try a different filter, or refresh the catalog."
                  : "Install anything from the skills.sh directory in Discover, or add a catalog URL or repository above."}
              </Empty>
            ) : (
              <PanelBody className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((item) => (
                  <MarketCard
                    key={item.id}
                    item={item}
                    onInstall={() => ctx.openMarket(item)}
                    onUninstall={() => void uninstall(item)}
                  />
                ))}
              </PanelBody>
            )}
          </Panel>
        </TabPanel>

        <TabPanel value="discover" className="mt-6">
          <Panel>
            <PanelHead
              title="Browse the skills.sh directory"
              hint={
                <>
                  Search and rankings come from{" "}
                  <a
                    className="text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink"
                    href="https://skills.sh"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    skills.sh
                  </a>
                </>
              }
            />

            <div className="space-y-3 border-b border-line px-5 py-4">
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={searchDirectory}
              >
                <Input
                  type="search"
                  className="flex-1"
                  aria-label="Search skills.sh"
                  placeholder="Search skills.sh — for example: react, playwright, pdf"
                  spellCheck={false}
                  autoComplete="off"
                  value={needle}
                  onChange={(event) => setNeedle(event.target.value)}
                />
                <Button type="submit" variant="primary" disabled={searching}>
                  {searching ? "Searching…" : "Search"}
                </Button>
              </form>

              {searchError ? (
                <p className="text-xs leading-relaxed text-warn">{searchError}</p>
              ) : null}

              {found ? (
                found.items.length ? (
                  <div className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
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
                  <p className="px-1 text-xs text-ink-3">
                    Nothing matched “{found.query}”.
                  </p>
                )
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
              <Segmented
                label="Ranking"
                value={topView}
                onChange={setTopView}
                options={[
                  { value: "all-time", label: "Top skills" },
                  { value: "trending", label: "Trending" },
                ]}
              />
              <span className="text-xs text-ink-3">
                {topView === "all-time" ? "Most installed" : "Gaining installs now"}
                {top ? ` · ${fmt(top.total)} listed` : ""}
              </span>
            </div>

            {topError ? (
              <p className="border-b border-line px-5 py-3 text-xs text-warn">
                {topError}
              </p>
            ) : null}

            {top && top.items.length ? (
              <>
                <div className="divide-y divide-line/60">
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
                  <div className="border-t border-line px-5 py-3">
                    <Button
                      size="sm"
                      disabled={topLoading}
                      onClick={() => void loadTop(topView, top.page + 1, true)}
                    >
                      {topLoading ? "Loading…" : "Show more"}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="px-5 py-6 text-xs text-ink-3">
                {topLoading ? "Loading the ranking…" : "The ranking is unavailable."}
              </p>
            )}
          </Panel>
        </TabPanel>
      </Tabs>
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
    <div className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-raised/40">
      {rank != null ? (
        <span className="num w-7 shrink-0 text-right text-xs text-ink-3">
          {rank}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink" title={item.name}>
          {item.name}
        </div>
        <Meta>{item.origin}</Meta>
      </div>
      {item.installs ? (
        <span className="num hidden shrink-0 text-xs text-ink-3 sm:block">
          {fmt(item.installs)} installs
        </span>
      ) : null}
      {item.installed ? (
        <>
          <Badge tone="ok">Installed</Badge>
          <Button size="sm" onClick={onManage}>
            Manage
          </Button>
        </>
      ) : (
        <Button size="sm" variant="primary" onClick={onInstall}>
          Install
        </Button>
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
  const sourceLink =
    item.source && /^https?:\/\//.test(item.source) ? (
      <a
        className="text-xs text-ink-3 underline decoration-line-2 underline-offset-2 hover:text-ink-2"
        href={item.source}
        target="_blank"
        rel="noopener noreferrer"
      >
        Source ↗
      </a>
    ) : null;

  return (
    <article
      className={[
        "flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-colors",
        installed
          ? "border-line-2 bg-raised/40"
          : "border-line bg-inset/50 hover:border-line-2",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={item.kind === "mcp" ? "neutral" : "accent"}>
            {item.kind === "mcp" ? "MCP" : "Skill"}
          </Badge>
          {item.category ? (
            <span className="truncate text-[11px] text-ink-3" title={item.category}>
              {item.category}
            </span>
          ) : null}
        </div>
        {installed ? <Badge tone="ok">Installed</Badge> : null}
      </div>

      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium text-ink" title={item.name}>
          {item.name}
        </h3>
        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-2">
          {item.description}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-3">
        <span className="truncate">{item.author || "Unknown"}</span>
        <span className="text-ink-3/50">·</span>
        <span>{item.license || "See source"}</span>
        <span className="text-ink-3/50">·</span>
        <span>Third-party</span>
        {item.checksum_present === false ? (
          <Badge tone="warn">unpinned</Badge>
        ) : null}
        {item.requires ? <span>{item.requires}</span> : null}
      </div>

      {item.origin ? <Meta>{item.origin}</Meta> : null}

      <div className="mt-auto flex items-center gap-3 pt-1">
        {installed ? (
          <Button size="sm" variant="danger" onClick={onUninstall}>
            {item.kind === "skill" ? "Uninstall" : "Remove"}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onInstall}>
            Install
          </Button>
        )}
        {sourceLink}
      </div>
    </article>
  );
}
