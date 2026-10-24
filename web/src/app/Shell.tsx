import { useEffect, useState, type ReactNode } from "react";

import { fmt, viewLabels } from "../format";
import { useJit } from "../state/store";
import type { View } from "../types";
import { StatusDot } from "../ui/Badge";
import { Kbd, Wordmark } from "../ui/Display";
import { cx } from "../ui/cx";

const NAV: View[] = [
  "overview",
  "skills",
  "marketplace",
  "mcp",
  "search",
  "settings",
];

function clockText(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * The frame: one editorial masthead — wordmark, a horizontal run of sections,
 * and the live status at the far right. No rail, no numbering.
 */
export function Shell({ children }: { children: ReactNode }) {
  const ctx = useJit();
  const [clock, setClock] = useState(clockText());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(clockText()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const version = ctx.health?.version || "1.0.0";

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1320px] items-stretch gap-2 px-5 md:px-8">
          <button
            type="button"
            onClick={() => ctx.setView("overview")}
            aria-label="JIT — overview"
            className="flex items-center pr-3"
          >
            <Wordmark className="text-[13px]" />
          </button>

          <span aria-hidden="true" className="my-auto hidden h-5 w-px bg-line md:block" />

          <nav className="hidden items-stretch md:flex" aria-label="Sections">
            {NAV.map((view) => {
              const active = ctx.view === view;
              return (
                <button
                  key={view}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => ctx.setView(view)}
                  className={cx(
                    "relative px-3.5 text-sm transition-colors",
                    active ? "text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {viewLabels[view]}
                  <span
                    aria-hidden="true"
                    className={cx(
                      "absolute inset-x-3 bottom-0 h-px transition-colors",
                      active ? "bg-accent" : "bg-transparent",
                    )}
                  />
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
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

        {/* Sections on narrow screens, where the masthead nav is hidden. */}
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
  );
}
