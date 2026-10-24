import { useEffect, useState, type ReactNode } from "react";

import { useJit } from "../context";
import { fmt, pct, viewLabels } from "../format";
import type { View } from "../types";
import { Brand } from "./ui";

function clockText(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

const NAV: Array<{ view: View; num: string; label: string }> = [
  { view: "overview", num: "01", label: "Overview" },
  { view: "skills", num: "02", label: "Skills" },
  { view: "marketplace", num: "03", label: "Marketplace" },
  { view: "mcp", num: "04", label: "MCP" },
  { view: "search", num: "05", label: "Search" },
  { view: "settings", num: "06", label: "Settings" },
];

export function Shell({ children }: { children: ReactNode }) {
  const ctx = useJit();
  const [clock, setClock] = useState(clockText());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(clockText()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const total = ctx.stats?.total || 0;
  const enabled = ctx.stats?.enabled || 0;
  const version = ctx.health?.version || "1.0.0";

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="brand-lockup">
            <Brand />
            <div className="wordmark">JIT</div>
          </div>
          <div className="tagline">just-in-time context</div>
        </div>

        <div>
          <div className="rail-label">Sections</div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((item) => (
              <button
                key={item.view}
                className={`nav-link${ctx.view === item.view ? " is-active" : ""}`}
                onClick={() => ctx.setView(item.view)}
              >
                <span className="nav-num">{item.num}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="rail-bottom">
          <div className="rail-index">
            <div className="rail-index-head">
              <span>Indexed</span>
              <b>{fmt(total)}</b>
            </div>
            <span
              className="rail-meter"
              aria-hidden="true"
              title={
                total
                  ? `${fmt(enabled)} of ${fmt(total)} entries enabled`
                  : "No entries indexed"
              }
            >
              <i style={{ width: `${total ? pct(enabled, total) : 0}%` }} />
            </span>
          </div>
          <div className="status">
            <span className={`dot ${ctx.online ? "ok" : "bad"}`} />
            <span>{ctx.online ? "local" : "offline"}</span>
          </div>
          <div className="rail-meta">
            <span>v{version}</span>
            <span>MIT</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb">
            <span>JIT</span>
            <span className="crumb-sep">/</span>
            <b>{viewLabels[ctx.view]}</b>
          </div>
          <div className="topbar-tools">
            <span className="clock">{clock}</span>
            {ctx.config?.auth_enabled ? (
              <button className="btn btn-quiet" onClick={ctx.logout}>
                Sign out
              </button>
            ) : null}
          </div>
        </header>
        <section className="view is-active" key={ctx.view}>
          {children}
        </section>
      </main>
    </div>
  );
}
