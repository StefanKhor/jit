import { useEffect, useState, type ReactNode } from "react";

import { fmt, NAV_VIEWS, viewLabels } from "../format";
import { useJit } from "../state/store";
import type { View } from "../types";
import { StatusDot } from "../ui/Badge";
import { Kbd, Wordmark } from "../ui/Display";
import { cx } from "../ui/cx";

const NAV: View[] = NAV_VIEWS;

function clockText(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * The frame: a fixed console rail on the left — wordmark, sections, and a live
 * readout — with a slim signal bar over the content. No numbering, no icons.
 */
export function Shell({ children }: { children: ReactNode }) {
  const ctx = useJit();
  const [clock, setClock] = useState(clockText());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(clockText()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const version = ctx.health?.version || "1.0.0";
  // Live counts where they exist — the rail doubles as a readout.
  const counts: Partial<Record<View, number>> = {
    skills: ctx.stats?.total ?? 0,
    mcp: ctx.mcpServers.length,
  };

  return (
    <div className="min-h-full">
      {/* The console rail — primary navigation, fixed to the viewport. */}
      <aside
        aria-label="Console"
        className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-line bg-panel/60 backdrop-blur-xl md:flex"
      >
        <button
          type="button"
          onClick={() => ctx.setView("overview")}
          aria-label="JIT — overview"
          className="flex h-16 shrink-0 items-center border-b border-line px-6"
        >
          <Wordmark className="text-[13px]" />
        </button>

        <nav
          className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
          aria-label="Sections"
        >
          {NAV.map((view) => {
            const active = ctx.view === view;
            const count = counts[view];
            return (
              <button
                key={view}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => ctx.setView(view)}
                className={cx(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-raised text-ink"
                    : "text-ink-3 hover:bg-raised/50 hover:text-ink-2",
                )}
              >
                {/* The live marker: one accent bar, glowing, only when selected. */}
                <span
                  aria-hidden="true"
                  className={cx(
                    "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-all",
                    active
                      ? "bg-accent shadow-[0_0_10px_var(--color-accent)]"
                      : "bg-transparent",
                  )}
                />
                <span className="truncate">{viewLabels[view]}</span>
                {count ? (
                  <span
                    className={cx(
                      "num ml-auto text-[10px]",
                      active ? "text-ink-3" : "text-ink-3/70",
                    )}
                  >
                    {fmt(count)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="shrink-0 space-y-3 border-t border-line p-4">
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <StatusDot tone={ctx.online ? "ok" : "bad"} pulse={ctx.online} />
            <span>{ctx.online ? "local" : "offline"}</span>
            <span className="num ml-auto text-[11px]">{clock}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-ink-3">
            <span className="num">v{version}</span>
            {ctx.config?.auth_enabled ? (
              <button
                type="button"
                onClick={ctx.logout}
                className="transition-colors hover:text-ink"
              >
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      {/* Content column, offset by the rail on wide screens. */}
      <div className="flex min-h-full flex-col md:pl-[236px]">
        <header className="sticky top-0 z-30 border-b border-line bg-canvas/70 backdrop-blur-xl">
          <div className="flex h-14 items-center gap-3 px-5 md:px-8">
            <button
              type="button"
              onClick={() => ctx.setView("overview")}
              aria-label="JIT — overview"
              className="flex items-center md:hidden"
            >
              <Wordmark className="text-[13px]" />
            </button>

            {/* A mono path, not a second title — the page still speaks for itself. */}
            <span className="hidden items-center gap-2 md:flex">
              <span className="kicker">jit</span>
              <span aria-hidden="true" className="text-ink-3">
                /
              </span>
              <span className="num text-[11px] tracking-wide text-ink-2">
                {viewLabels[ctx.view].toLowerCase()}
              </span>
            </span>

            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => ctx.setView("search")}
                className="hidden items-center gap-2 rounded-lg border border-line bg-inset/60 py-1.5 pl-3 pr-2 text-xs text-ink-3 transition-colors hover:border-line-2 hover:text-ink-2 sm:flex"
              >
                <span>Search</span>
                <Kbd>/</Kbd>
              </button>

              <span className="hidden items-center gap-2 text-xs text-ink-3 lg:flex">
                <StatusDot tone={ctx.online ? "ok" : "bad"} pulse={ctx.online} />
                {ctx.online ? "local" : "offline"}
              </span>

              <span className="num hidden text-[11px] text-ink-3 lg:inline">
                {clock}
              </span>

              {ctx.config?.auth_enabled ? (
                <button
                  type="button"
                  onClick={ctx.logout}
                  className="text-xs text-ink-3 transition-colors hover:text-ink"
                >
                  Sign out
                </button>
              ) : null}
            </div>
          </div>

          {/* Sections on narrow screens, where the rail is hidden. */}
          <nav
            className="flex gap-1 overflow-x-auto px-4 pb-2.5 md:hidden"
            aria-label="Sections"
          >
            {NAV.map((view) => {
              const active = ctx.view === view;
              return (
                <button
                  key={view}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => ctx.setView(view)}
                  className={cx(
                    "shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors",
                    active ? "bg-raised text-ink" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  {viewLabels[view]}
                </button>
              );
            })}
          </nav>

          {/* A slow glint travelling the header rule — the one moving light. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden"
          >
            <span className="block h-px w-1/3 bg-gradient-to-r from-transparent via-accent/70 to-transparent motion-safe:animate-sheen" />
          </span>
        </header>

        <main
          key={ctx.view}
          className="mx-auto w-full max-w-[1320px] flex-1 px-5 py-8 motion-safe:animate-view md:px-8 md:py-12"
        >
          {children}
        </main>

        <footer className="mx-auto flex w-full max-w-[1320px] items-center justify-between gap-4 px-5 pb-8 pt-4 text-[11px] text-ink-3 md:px-8">
          <span className="num">
            {ctx.stats ? `${fmt(ctx.stats.total)} indexed` : "index pending"}
          </span>
          <span className="num">v{version} · just-in-time context</span>
        </footer>
      </div>
    </div>
  );
}
