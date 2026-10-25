import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { api } from "../api";
import { fmt } from "../format";
import { useJit } from "../state/store";
import type { MarketplaceItem, MarketplaceTopResponse } from "../types";
import { Badge, Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Empty } from "../ui/Display";
import { Checkbox, Input } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import {
  SelectAll,
  SelectionBar,
  useSelection,
  type Selection,
} from "../ui/Selection";
import { Segmented } from "../ui/Segmented";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";

type Filter = "all" | "skill" | "mcp";
type TopView = "all-time" | "trending";
type Section = "catalog" | "discover";
type InstalledFilter = "all" | "installed" | "not-installed";

const PAGE_SIZES = [25, 50, 100, 200] as const;

function discoveryKey(item: MarketplaceItem): string {
  return `${String(item.install.skills_source || item.author || "")}/${String(
    item.install.skills_name || item.id,
  )}`.toLowerCase();
}

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
  const [topPage, setTopPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>("all");
  const [topLoading, setTopLoading] = useState(false);
  const [topError, setTopError] = useState("");

  useEffect(() => {
    if (!ctx.marketLoaded) void ctx.loadMarketplace();
  }, [ctx.marketLoaded]);

  const loadTop = useCallback(
    async (which: TopView, page = 1, perPage = 100): Promise<void> => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20_000);
      setTopLoading(true);
      setTopError("");
      setTop(null);
      try {
        const data = await api<MarketplaceTopResponse>(
          `/api/marketplace/top?view=${which}&page=${page}&per_page=${perPage}`,
          { signal: controller.signal },
        );
        setTop(data);
      } catch (error) {
        setTopError(
          controller.signal.aborted
            ? "The ranking request timed out. Check that the JIT server can reach skills.sh, then retry."
            : error instanceof Error
              ? error.message
              : String(error),
        );
      } finally {
        window.clearTimeout(timeout);
        setTopLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadTop(topView, topPage, pageSize);
  }, [topView, topPage, pageSize, loadTop]);

  const runSearch = useCallback(async (value: string): Promise<void> => {
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
  }, []);

  // Refresh install state when the single-item review dialog closes.
  const marketOpen = Boolean(ctx.dialogs.market);
  const wasMarketOpen = useRef(false);
  useEffect(() => {
    if (wasMarketOpen.current && !marketOpen) {
      void loadTop(topView, topPage, pageSize);
      if (found) void runSearch(found.query);
    }
    wasMarketOpen.current = marketOpen;
  }, [marketOpen, found, topView, topPage, pageSize, loadTop, runSearch]);

  const topItems = top?.items || [];
  const visibleTopItems = topItems.filter((item) =>
    installedFilter === "all"
      ? true
      : installedFilter === "installed"
        ? Boolean(item.installed)
        : !item.installed,
  );
  const installedCount = topItems.filter((item) => item.installed).length;
  const topSelectable = visibleTopItems.filter((item) => !item.installed);
  const foundSelectable = (found?.items || []).filter((item) => !item.installed);
  const topSelection = useSelection(topSelectable.map(discoveryKey));
  const foundSelection = useSelection(foundSelectable.map(discoveryKey));

  const openBulk = (selection: Selection, items: MarketplaceItem[]) => {
    const seenIds = new Set<string>();
    const chosen: MarketplaceItem[] = [];
    let duplicateCount = 0;
    for (const item of items) {
      if (!selection.has(discoveryKey(item))) continue;
      if (seenIds.has(item.id)) {
        duplicateCount += 1;
        continue;
      }
      seenIds.add(item.id);
      chosen.push(item);
    }
    if (duplicateCount) {
      ctx.toast(
        `Skipped ${duplicateCount} duplicate skill name${duplicateCount === 1 ? "" : "s"}; JIT stores skills by name.`,
        "error",
      );
    }
    if (chosen.length) {
      ctx.openMarketBulk(chosen);
      selection.clear();
    }
  };

  const bulkOpen = Boolean(ctx.dialogs.marketBulk);
  const wasBulkOpen = useRef(false);
  useEffect(() => {
    if (wasBulkOpen.current && !bulkOpen) {
      void loadTop(topView, topPage, pageSize);
      if (found) void runSearch(found.query);
    }
    wasBulkOpen.current = bulkOpen;
  }, [bulkOpen, found, topView, topPage, pageSize, loadTop, runSearch]);

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

  const searchDirectory = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(needle.trim());
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
      await Promise.all([
        ctx.refreshAll(),
        ctx.loadMarketplace(true),
        loadTop(topView, topPage, pageSize),
        found ? runSearch(found.query) : Promise.resolve(),
      ]);
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
            third-party and scanned by NVIDIA SkillSpector for potential
            vulnerabilities before it installs, and nothing installs until you
            choose it.
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
                  <>
                    {foundSelectable.length ? (
                      <DiscoveryBar
                        selection={foundSelection}
                        items={foundSelectable}
                        label="Select all uninstalled search results"
                        onInstall={() => openBulk(foundSelection, found.items)}
                      />
                    ) : null}
                    <div className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
                      {found.items.map((item) => (
                        <DiscoverRow
                          key={discoveryKey(item)}
                          item={item}
                          select={
                            item.installed
                              ? undefined
                              : {
                                  checked: foundSelection.has(discoveryKey(item)),
                                  onToggle: (on) =>
                                    foundSelection.toggle(discoveryKey(item), on),
                                }
                          }
                          onInstall={() => ctx.openMarket(item)}
                          onUninstall={() => void uninstall(item)}
                        />
                      ))}
                    </div>
                  </>
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
                onChange={(view) => {
                  setTopView(view);
                  setTopPage(1);
                }}
                options={[
                  { value: "all-time", label: "Top skills" },
                  { value: "trending", label: "Trending" },
                ]}
              />
              <span className="text-xs text-ink-3">
                {topView === "all-time" ? "8-week activity · installs" : "Trending"}
                {top ? ` · ${fmt(top.total)} listed` : ""}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
              <Segmented
                label="Filter by install state on this page"
                value={installedFilter}
                onChange={setInstalledFilter}
                options={[
                  { value: "all", label: "All", count: topItems.length },
                  { value: "installed", label: "Installed", count: installedCount },
                  {
                    value: "not-installed",
                    label: "Not installed",
                    count: topItems.length - installedCount,
                  },
                ]}
              />
              <label className="flex items-center gap-2 text-xs text-ink-3">
                Rows per page
                <select
                  className="h-8 rounded-lg border border-line-2 bg-inset px-2 text-ink focus:outline-none focus:ring-2 focus:ring-accent/15"
                  aria-label="Rows per page"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setTopPage(1);
                  }}
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {top && top.items.length ? (
              <>
                {topSelectable.length ? (
                  <div className="border-b border-line bg-inset/30 px-5 py-2">
                    <DiscoveryBar
                      selection={topSelection}
                      items={topSelectable}
                      label="Select all uninstalled skills on this page"
                      onInstall={() => openBulk(topSelection, visibleTopItems)}
                    />
                  </div>
                ) : null}
                <div className="hidden grid-cols-[1rem_2rem_minmax(0,1fr)_7rem_7rem_6rem] gap-3 border-b border-line bg-inset/30 px-5 py-2 text-[10px] font-medium uppercase tracking-wide text-ink-3 sm:grid">
                  <span />
                  <span>#</span>
                  <span>Skill</span>
                  <span className="text-right">8W Activity</span>
                  <span className="text-right">Installs</span>
                  <span className="text-right">JIT</span>
                </div>
                {visibleTopItems.length ? (
                  <div className="divide-y divide-line/60">
                    {visibleTopItems.map((item) => (
                      <DiscoverRow
                        key={discoveryKey(item)}
                        item={item}
                        rank={
                          (top.page - 1) * top.page_size +
                          top.items.indexOf(item) +
                          1
                        }
                        select={
                          item.installed
                            ? undefined
                            : {
                                checked: topSelection.has(discoveryKey(item)),
                                onToggle: (on) =>
                                  topSelection.toggle(discoveryKey(item), on),
                              }
                        }
                        onInstall={() => ctx.openMarket(item)}
                        onUninstall={() => void uninstall(item)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="px-5 py-6 text-xs text-ink-3">
                    {installedFilter === "all"
                      ? "No skills on this page."
                      : `No ${installedFilter === "installed" ? "installed" : "uninstalled"} skills on this page.`}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                  <span className="text-xs text-ink-3">
                    Page {top.page} of {Math.max(1, Math.ceil(top.total / top.page_size))}
                    {top.total
                      ? ` · ${fmt((top.page - 1) * top.page_size + 1)}–${fmt(
                          Math.min(top.page * top.page_size, top.total),
                        )} of ${fmt(top.total)}`
                      : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={topLoading || top.page <= 1}
                      onClick={() => setTopPage((page) => Math.max(1, page - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={topLoading || !top.has_more}
                      onClick={() => setTopPage((page) => page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3 px-5 py-6">
                <p className="text-xs text-ink-3">
                  {topLoading ? "Loading the ranking…" : "The ranking is unavailable."}
                </p>
                {!topLoading && topError ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadTop(topView, topPage, pageSize)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            )}
            {topError ? (
              <p className="border-t border-line px-5 py-3 text-xs text-warn">
                {topError}
              </p>
            ) : null}
          </Panel>
        </TabPanel>
      </Tabs>
    </div>
  );
}

function DiscoveryBar({
  selection,
  items,
  label,
  onInstall,
}: {
  selection: Selection;
  items: MarketplaceItem[];
  label: string;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
        <label className="flex cursor-pointer items-center gap-2">
          <SelectAll selection={selection} label={label} />
          Select all on this page
        </label>
        <span className="num text-ink-3">
          {fmt(selection.count)} selected · {fmt(items.length)} available
        </span>
      </div>
      {selection.count ? (
        <SelectionBar count={selection.count} onClear={selection.clear}>
          <Button size="sm" variant="accent" onClick={onInstall}>
            Review & install
          </Button>
        </SelectionBar>
      ) : null}
    </div>
  );
}

function WeeklyActivity({ values }: { values: number[] }) {
  if (!values.length) {
    return <span className="text-xs text-ink-3">—</span>;
  }
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = 2 + (index / Math.max(1, values.length - 1)) * 92;
      const y = 21 - (value / max) * 16;
      return `${x},${y}`;
    })
    .join(" ");
  const label = `Weekly installs: ${values.map((value) => fmt(value)).join(", ")}`;
  return (
    <svg
      viewBox="0 0 96 24"
      role="img"
      aria-label={label}
      className="h-8 w-24 overflow-visible text-ink-3"
    >
      <title>{label}</title>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function skillsShHref(item: MarketplaceItem): string | null {
  const source = String(item.install.skills_source || "").trim();
  const skill = String(item.install.skills_name || "").trim();
  if (!source || !skill) return null;
  const segments = [...source.split("/"), skill].filter(Boolean);
  return `https://skills.sh/${segments.map(encodeURIComponent).join("/")}`;
}

function DiscoverRow({
  item,
  rank,
  select,
  onInstall,
  onUninstall,
}: {
  item: MarketplaceItem;
  rank?: number;
  select?: { checked: boolean; onToggle: (on: boolean) => void };
  onInstall: () => void;
  onUninstall: () => void;
}) {
  return (
    <div
      className={cx(
        "grid items-center gap-3 px-5 py-2.5 transition-colors hover:bg-raised/40",
        rank == null
          ? "grid-cols-[1rem_minmax(0,1fr)_auto] sm:grid-cols-[1rem_minmax(0,1fr)_7rem_7rem_6rem]"
          : "grid-cols-[1rem_auto_minmax(0,1fr)_auto] sm:grid-cols-[1rem_2rem_minmax(0,1fr)_7rem_7rem_6rem]",
      )}
    >
      {select ? (
        <Checkbox
          checked={select.checked}
          aria-label={`Select ${item.name}`}
          onChange={(event) => select.onToggle(event.target.checked)}
        />
      ) : (
        <span className="size-4" />
      )}
      {rank != null ? (
        <span className="num w-7 shrink-0 text-right text-xs text-ink-3">
          {rank}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {skillsShHref(item) ? (
          <a
            className="inline-flex max-w-full items-center gap-1 truncate text-sm text-ink underline decoration-line-2 underline-offset-2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            href={skillsShHref(item) || undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={`${item.name} on skills.sh`}
          >
            <span className="truncate">{item.name}</span>
            <span aria-hidden="true" className="shrink-0 text-[10px] text-ink-3">
              ↗
            </span>
            <span className="sr-only"> (opens skills.sh in a new tab)</span>
          </a>
        ) : (
          <div className="truncate text-sm text-ink" title={item.name}>
            {item.name}
          </div>
        )}
        <Meta>{item.origin}</Meta>
        <span className="num mt-1 block text-[10px] text-ink-3 sm:hidden">
          {fmt(item.installs || 0)} installs
        </span>
      </div>
      <div className="hidden justify-end sm:flex">
        <WeeklyActivity values={item.weekly_installs || []} />
      </div>
      <span className="num hidden text-right text-xs text-ink-2 sm:block">
        {fmt(item.installs || 0)}
      </span>
      <div className="flex justify-end">
        {item.installed ? (
          <Button size="sm" variant="danger" onClick={onUninstall}>
            Uninstall
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onInstall}>
            Install
          </Button>
        )}
      </div>
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
