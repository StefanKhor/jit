import { useState } from "react";

import { fmt, summary } from "../format";
import { useJit } from "../state/store";
import type { BulkResult, ConfigPath, McpImportServer } from "../types";
import { StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Empty } from "../ui/Display";
import { Checkbox } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { SelectAll, SelectionBar, useSelection } from "../ui/Selection";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";

export function Mcp() {
  const ctx = useJit();
  const [importOpen, setImportOpen] = useState(false);
  const [imports, setImports] = useState<McpImportServer[]>([]);
  const [importPaths, setImportPaths] = useState<ConfigPath[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkSel = useSelection(ctx.mcpServers.map((server) => server.name));

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

  const bulk = async (
    action: "connect" | "disconnect" | "index" | "remove",
  ) => {
    const servers = [...bulkSel.selected];
    if (servers.length === 0 || bulkBusy) return;
    if (action === "remove") {
      const ok = await ctx.confirmAction(
        `Remove ${servers.length} server${servers.length === 1 ? "" : "s"} from JIT?`,
        "They and their indexed tools are removed from JIT. The external servers and their own configs are untouched.",
        "Remove",
      );
      if (!ok) return;
    }
    setBulkBusy(true);
    try {
      const result = await ctx.api<BulkResult>("/api/mcp/bulk", {
        method: "POST",
        body: JSON.stringify({ servers, action }),
      });
      const verb = {
        connect: "Connected",
        disconnect: "Disconnected",
        index: "Indexed",
        remove: "Removed",
      }[action];
      const parts = [`${verb} ${result.ok.length}`];
      const tools = Object.values(result.tools || {}).reduce(
        (count, value) => count + value,
        0,
      );
      if (tools && (action === "connect" || action === "index")) {
        parts.push(`${fmt(tools)} tools`);
      }
      if (result.failed.length) parts.push(`${result.failed.length} failed`);
      ctx.toast(parts.join(" · "), result.failed.length ? "error" : "ok");
      bulkSel.clear();
      await ctx.refreshAll();
      if (action === "remove" && ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBulkBusy(false);
    }
  };

  const total = ctx.mcpServers.length;
  const connected = ctx.mcpServers.reduce(
    (count, server) => count + (server.status === "connected" ? 1 : 0),
    0,
  );
  const foundPaths = importPaths.reduce(
    (count, entry) => count + (entry.exists ? 1 : 0),
    0,
  );

  return (
    <div className="space-y-6">
      <PageHead
        kicker="04 — MCP"
        title={
          <span className="flex items-baseline gap-2">
            The bridge.
            <span className="num text-sm text-ink-3">{total}</span>
          </span>
        }
        description="JIT manages its own MCP servers. Import a client config to copy servers in, or export JIT servers back out. Neither direction changes the other side unless you choose it."
        actions={
          <>
            <Button onClick={() => ctx.setView("marketplace")}>Marketplace</Button>
            <Button onClick={() => void showImports()}>Import configs</Button>
            <Button onClick={() => void ctx.openMcpExport()}>Export</Button>
            <Button variant="primary" onClick={ctx.openMcpAdd}>
              Add server
            </Button>
          </>
        }
      />

      {total === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty
            title="No servers yet."
            actions={
              <>
                <Button
                  variant="primary"
                  onClick={() => ctx.setView("marketplace")}
                >
                  Browse marketplace
                </Button>
                <Button onClick={() => void showImports()}>Import configs</Button>
              </>
            }
          >
            Install one from the marketplace, or import a server you already use.
          </Empty>
        </Panel>
      ) : (
        <Panel id="servers-table">
          <PanelHead
            title={bulkSel.count ? `${fmt(bulkSel.count)} selected` : "Servers"}
            hint={
              bulkSel.count
                ? undefined
                : `${fmt(connected)} of ${fmt(total)} connected`
            }
            actions={
              bulkSel.count ? (
                <SelectionBar count={bulkSel.count} onClear={bulkSel.clear}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => void bulk("connect")}
                  >
                    Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => void bulk("index")}
                  >
                    Index
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => void bulk("disconnect")}
                  >
                    Disconnect
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={bulkBusy}
                    onClick={() => void bulk("remove")}
                  >
                    {bulkBusy ? "Working…" : "Remove"}
                  </Button>
                </SelectionBar>
              ) : null
            }
          />
          <TableWrap>
            <Table className="w-full min-w-[600px] table-fixed">
              <thead>
                <tr>
                  <Th className="w-[44px]">
                    <SelectAll selection={bulkSel} label="Select all servers" />
                  </Th>
                  <Th>Server</Th>
                  <Th className="w-[130px]">Status</Th>
                  <Th className="num hidden w-[80px] text-right sm:table-cell">
                    Tools
                  </Th>
                  <Th className="w-[260px] text-right">Actions</Th>
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
                          : "neutral";
                  const picked = bulkSel.has(server.name);
                  return (
                    <Tr
                      key={server.name}
                      className={cx(picked && "bg-accent/[0.04]")}
                    >
                      <Td className="w-[44px]">
                        <Checkbox
                          checked={picked}
                          aria-label={`Select ${server.name}`}
                          onChange={(event) =>
                            bulkSel.toggle(server.name, event.target.checked)
                          }
                        />
                      </Td>
                      <Td>
                        <span
                          className="block min-w-0 truncate text-sm font-medium text-ink"
                          title={server.source || server.name}
                        >
                          {server.name}
                        </span>
                        {server.error ? (
                          <p
                            className="mt-1 min-w-0 truncate text-xs text-ink-3"
                            title={server.error}
                          >
                            {server.error}
                          </p>
                        ) : null}
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                          <StatusDot tone={dot} />
                          {server.status}
                        </span>
                      </Td>
                      <Td
                        className="num hidden text-right text-ink-2 sm:table-cell"
                        title="Indexed tools"
                      >
                        {fmt(server.indexed_tool_count ?? server.tool_count)}
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {server.status === "connected" ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === server.name}
                                onClick={() => void act(server.name, "index")}
                              >
                                Index
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === server.name}
                                onClick={() => void act(server.name, "disconnect")}
                              >
                                Disconnect
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === server.name}
                              onClick={() => void act(server.name, "connect")}
                            >
                              {server.status === "error" ? "Retry" : "Connect"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === server.name}
                            title="Remove from JIT; the external config is untouched"
                            onClick={() => void act(server.name, "remove")}
                          >
                            {busy === server.name ? "…" : "Remove"}
                          </Button>
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      )}

      {importOpen ? (
        <Panel>
          <PanelHead
            title="Import from client configs"
            hint={`${fmt(foundPaths)} of ${fmt(importPaths.length)} paths found`}
          />
          <PanelBody className="space-y-5">
            <p className="text-xs leading-relaxed text-ink-3">
              Choose the servers you want JIT to manage. The source config is
              never modified.
            </p>

            <div className="space-y-1.5">
              {importPaths.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-start gap-2 text-xs"
                >
                  <StatusDot
                    tone={entry.exists ? "ok" : "neutral"}
                    className="mt-1.5"
                  />
                  <span
                    className="num min-w-0 break-all text-ink-2"
                    title={entry.path}
                  >
                    {entry.path}
                  </span>
                  <span className="shrink-0 text-ink-3">
                    {entry.exists ? "found" : "missing"}
                  </span>
                </div>
              ))}
            </div>

            {importError ? (
              <p className="py-4 text-center text-sm text-ink-2">{importError}</p>
            ) : imports.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-2">
                No servers found in client configs.
              </p>
            ) : (
              <div className="divide-y divide-line overflow-hidden rounded-md border border-line">
                {imports.map((server, index) => {
                  const detail = `${server.command || server.url || "MCP server"} · ${server.source}${
                    server.managed ? " · already managed" : ""
                  }`;
                  return (
                    <label
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-raised/50"
                      key={`${server.name}-${server.source}`}
                    >
                      <Checkbox
                        checked={selected.has(index)}
                        disabled={server.managed}
                        aria-label={server.name}
                        onChange={(event) => {
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(index);
                            else next.delete(index);
                            return next;
                          });
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink" title={server.name}>
                          {server.name}
                        </span>
                        <span
                          className="block truncate font-mono text-[11px] text-ink-3"
                          title={detail}
                        >
                          {detail}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void importSelected()}
                disabled={
                  importBusy ||
                  !imports.some(
                    (server, index) => !server.managed && selected.has(index),
                  )
                }
              >
                {importBusy ? "Importing…" : "Import selected"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setImportOpen(false);
                  setImportError("");
                }}
              >
                Cancel
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  );
}
