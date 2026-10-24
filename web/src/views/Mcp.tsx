import { useState } from "react";

import { useJit } from "../context";
import { fmt, summary } from "../format";
import type { ConfigPath, McpImportServer } from "../types";
import { Empty } from "../components/ui";

export function Mcp() {
  const ctx = useJit();
  const [importOpen, setImportOpen] = useState(false);
  const [imports, setImports] = useState<McpImportServer[]>([]);
  const [importPaths, setImportPaths] = useState<ConfigPath[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState("");

  const showImports = async () => {
    setImportOpen(true);
    setImportError("");
    setImports([]);
    setImportPaths([]);
    try {
      const data = await ctx.api<{
        paths: ConfigPath[];
        servers: McpImportServer[];
      }>("/api/mcp/imports");
      setImports(data.servers || []);
      setImportPaths(data.paths || []);
      setSelected(
        new Set(
          (data.servers || [])
            .map((server, index) => (server.managed ? -1 : index))
            .filter((index) => index >= 0),
        ),
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const importSelected = async () => {
    const servers = [...selected]
      .map((index) => imports[index])
      .filter((server): server is McpImportServer => Boolean(server))
      .map((server) => ({ name: server.name, source: server.source }));
    if (servers.length === 0) {
      ctx.toast("Select at least one server.", "error");
      return;
    }
    setImportBusy(true);
    try {
      const result = await ctx.api<{
        imported: string[];
        skipped: string[];
        errors: string[];
      }>("/api/mcp/import", {
        method: "POST",
        body: JSON.stringify({ servers }),
      });
      const parts = [`${result.imported.length} imported`];
      if (result.skipped.length) parts.push(`${result.skipped.length} already managed`);
      if (result.errors.length) parts.push(result.errors[0] || "");
      ctx.toast(
        parts.join(" · "),
        result.errors.length ? "error" : "ok",
      );
      setImportOpen(false);
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setImportBusy(false);
    }
  };

  const act = async (
    server: string,
    action: "connect" | "disconnect" | "index" | "remove",
  ) => {
    if (action === "remove") {
      const ok = await ctx.confirmAction(
        "Remove from JIT?",
        `"${server}" and its indexed tools will be removed from JIT. The external server and its own config are untouched.`,
        "Remove",
      );
      if (!ok) return;
    }
    setBusy(server);
    try {
      if (action === "remove") {
        const result = await ctx.api<{ tools_removed?: number }>(
          "/api/mcp/remove",
          { method: "POST", body: JSON.stringify({ server }) },
        );
        ctx.toast(`Removed ${server} · ${fmt(result.tools_removed || 0)} tools.`);
      } else if (action === "connect") {
        const result = await ctx.api<{ tools: unknown[] }>("/api/mcp/connect", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(`Connected to ${server} · ${result.tools.length} tools.`);
      } else if (action === "disconnect") {
        await ctx.api("/api/mcp/disconnect", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(`${server} disconnected.`);
      } else {
        const result = await ctx.api<{
          found?: number;
          added?: number;
          updated?: number;
          skipped?: number;
          errors?: string[];
        }>("/api/mcp/index", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(
          summary(result),
          (result.errors || []).length ? "error" : "ok",
        );
      }
      await ctx.refreshAll();
      if (action === "remove" && ctx.marketLoaded) {
        await ctx.loadMarketplace(true);
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="kicker">04 — MCP</div>
          <h2 className="section-title">
            The bridge.<span className="count">{ctx.mcpServers.length}</span>
          </h2>
        </div>
        <div className="section-actions">
          <button className="btn" onClick={() => ctx.setView("marketplace")}>
            Marketplace
          </button>
          <button className="btn" onClick={() => void showImports()}>
            Import configs
          </button>
          <button className="btn" onClick={() => void ctx.openMcpExport()}>
            Export
          </button>
          <button className="btn btn-solid" onClick={ctx.openMcpAdd}>
            Add server
          </button>
        </div>
      </div>

      <p className="section-copy">
        JIT manages its own MCP servers. Import a client config to copy servers
        in, or export JIT servers back out. Neither direction changes the other
        side unless you choose it.
      </p>

      {ctx.mcpServers.length === 0 ? (
        <Empty
          title="No servers yet."
          actions={
            <>
              <button
                className="btn btn-solid"
                onClick={() => ctx.setView("marketplace")}
              >
                Browse marketplace
              </button>
              <button className="btn" onClick={() => void showImports()}>
                Import configs
              </button>
            </>
          }
        >
          Install one from the marketplace, or import a server you already use.
        </Empty>
      ) : (
        <div className="table-wrap" id="servers-table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Tools
                </th>
                <th scope="col" className="actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {ctx.mcpServers.map((server) => {
                const dot =
                  server.status === "connected"
                    ? "ok"
                    : server.status === "error"
                      ? "bad"
                      : server.status === "connecting"
                        ? "warn"
                        : "";
                return (
                  <tr key={server.name}>
                    <td>
                      <span
                        className="row-name"
                        style={{ cursor: "default" }}
                        title={server.source || ""}
                      >
                        {server.name}
                      </span>
                      {server.error ? (
                        <div className="row-sub" title={server.error}>
                          {server.error}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className="state">
                        <i className={`dot ${dot}`} />
                        {server.status}
                      </span>
                    </td>
                    <td className="num" title="Indexed tools">
                      {fmt(server.indexed_tool_count ?? server.tool_count)}
                    </td>
                    <td className="actions">
                      {server.status === "connected" ? (
                        <>
                          <button
                            className="btn-mini"
                            disabled={busy === server.name}
                            onClick={() => void act(server.name, "index")}
                          >
                            Index
                          </button>
                          <button
                            className="btn-mini"
                            disabled={busy === server.name}
                            onClick={() => void act(server.name, "disconnect")}
                          >
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-mini"
                          disabled={busy === server.name}
                          onClick={() => void act(server.name, "connect")}
                        >
                          {server.status === "error" ? "Retry" : "Connect"}
                        </button>
                      )}
                      <button
                        className="btn-mini danger"
                        disabled={busy === server.name}
                        title="Remove from JIT; the external config is untouched"
                        onClick={() => void act(server.name, "remove")}
                      >
                        {busy === server.name ? "…" : "Remove"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importOpen ? (
        <div className="panel" style={{ marginTop: "22px" }}>
          <div className="panel-head">
            <h2>Import from client configs</h2>
            <span className="panel-note">read-only</span>
          </div>
          <p className="panel-copy">
            Choose the servers you want JIT to manage. The source config is
            never modified.
          </p>
          <div className="import-paths">
            {importPaths.map((entry) => (
              <div key={entry.path}>
                <i className={`dot ${entry.exists ? "ok" : ""}`} />
                {entry.path}{" "}
                <span className="cat-count">
                  {entry.exists ? "found" : "missing"}
                </span>
              </div>
            ))}
          </div>
          {importError ? (
            <div className="empty" style={{ padding: "22px 0" }}>
              <p>{importError}</p>
            </div>
          ) : imports.length === 0 ? (
            <div className="empty" style={{ padding: "22px 0" }}>
              <p>No servers found in client configs.</p>
            </div>
          ) : (
            <div className="import-list">
              {imports.map((server, index) => (
                <label className="import-row" key={`${server.name}-${server.source}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    disabled={server.managed}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <span className="import-name">{server.name}</span>
                    <span className="import-meta">
                      {server.command || server.url || "MCP server"} ·{" "}
                      {server.source}
                      {server.managed ? " · already managed" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="form-actions" style={{ marginTop: "18px" }}>
            <button
              className="btn btn-solid"
              onClick={() => void importSelected()}
              disabled={
                importBusy ||
                !imports.some((server, index) => !server.managed && selected.has(index))
              }
            >
              {importBusy ? "Importing…" : "Import selected"}
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => {
                setImportOpen(false);
                setImportError("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
