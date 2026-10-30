import { useState } from "react";

import { fmt } from "../format";
import { useJit } from "../state/store";
import type {
  ConfigPath,
  McpImportServer,
  McpTool,
  McpToolCallResult,
} from "../types";
import { StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ActivityStatus, Empty, Spinner } from "../ui/Display";
import { Checkbox, Field, Select, Textarea } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";

export function Mcp() {
  const ctx = useJit();
  const [importOpen, setImportOpen] = useState(false);
  const [imports, setImports] = useState<McpImportServer[]>([]);
  const [importPaths, setImportPaths] = useState<ConfigPath[]>([]);
  const [importsLoading, setImportsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState("");
  const [busyAction, setBusyAction] = useState<"connect" | "disconnect" | "remove" | "">("");

  /* Tool runner: invoke a tool on a connected server, behind a confirm gate. */
  const [runnerOpen, setRunnerOpen] = useState(false);
  const [runnerServer, setRunnerServer] = useState("");
  const [runnerTools, setRunnerTools] = useState<McpTool[]>([]);
  const [runnerTool, setRunnerTool] = useState("");
  const [runnerArgs, setRunnerArgs] = useState("{}");
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [runnerError, setRunnerError] = useState("");
  const [runnerResult, setRunnerResult] = useState<McpToolCallResult | null>(
    null,
  );

  const connectedServers = ctx.mcpServers.filter(
    (server) => server.status === "connected",
  );

  const showImports = async () => {
    setImportOpen(true);
    setImportError("");
    setImports([]);
    setImportPaths([]);
    setImportsLoading(true);
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
    } finally {
      setImportsLoading(false);
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
    action: "connect" | "disconnect" | "remove",
  ) => {
    if (action === "remove") {
      const ok = await ctx.confirmAction(
        "Remove from JIT?",
        `"${server}" will be removed from JIT. The external server and its own config are untouched.`,
        "Remove",
      );
      if (!ok) return;
    }
    setBusy(server);
    setBusyAction(action);
    try {
      if (action === "remove") {
        await ctx.api("/api/mcp/remove", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(`Removed ${server}.`);
      } else if (action === "connect") {
        const result = await ctx.api<{ tools: unknown[] }>("/api/mcp/connect", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(`Connected to ${server} · ${result.tools.length} tools.`);
      } else {
        await ctx.api("/api/mcp/disconnect", {
          method: "POST",
          body: JSON.stringify({ server }),
        });
        ctx.toast(`${server} disconnected.`);
      }
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy("");
      setBusyAction("");
    }
  };

  /** Scaffold a starter JSON for a tool's required arguments. */
  const scaffoldArgs = (tool: McpTool | undefined): string => {
    const props = tool?.inputSchema?.properties || {};
    const required = new Set(tool?.inputSchema?.required || []);
    const obj: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(props)) {
      const schema = (raw || {}) as { type?: string; default?: unknown };
      if (schema.default !== undefined) obj[key] = schema.default;
      else if (schema.type === "number" || schema.type === "integer") obj[key] = 0;
      else if (schema.type === "boolean") obj[key] = false;
      else if (schema.type === "array") obj[key] = [];
      else if (schema.type === "object") obj[key] = {};
      else if (required.has(key)) obj[key] = "";
    }
    return JSON.stringify(obj, null, 2);
  };

  const pickRunnerServer = async (name: string) => {
    setRunnerServer(name);
    setRunnerTools([]);
    setRunnerTool("");
    setRunnerResult(null);
    setRunnerError("");
    if (!name) return;
    try {
      const data = await ctx.api<{ tools: McpTool[] }>(
        `/api/mcp/tools?server=${encodeURIComponent(name)}`,
      );
      setRunnerTools(data.tools || []);
      const first = (data.tools || [])[0];
      if (first) {
        setRunnerTool(first.name);
        setRunnerArgs(scaffoldArgs(first));
      } else {
        setRunnerError("This server exposes no tools.");
      }
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : String(error));
    }
  };

  const openRunner = () => {
    setRunnerOpen(true);
    setRunnerResult(null);
    setRunnerError("");
    const first = connectedServers[0];
    void pickRunnerServer(first ? first.name : "");
  };

  const pickRunnerTool = (name: string) => {
    setRunnerTool(name);
    setRunnerResult(null);
    setRunnerArgs(scaffoldArgs(runnerTools.find((tool) => tool.name === name)));
  };

  const runTool = async () => {
    if (runnerBusy || !runnerServer || !runnerTool) return;
    let args: unknown;
    try {
      args = JSON.parse(runnerArgs.trim() || "{}");
    } catch {
      setRunnerError("Arguments are not valid JSON.");
      return;
    }
    // Tools run third-party code with real side effects — never send without
    // an explicit yes, even for a re-run.
    const ok = await ctx.confirmAction(
      `Run ${runnerTool}?`,
      `This invokes "${runnerTool}" on ${runnerServer}. Tools can have side effects: files written, commands run, external calls made.`,
      "Run tool",
    );
    if (!ok) return;
    setRunnerBusy(true);
    setRunnerError("");
    try {
      const result = await ctx.api<McpToolCallResult>("/api/mcp/call", {
        method: "POST",
        body: JSON.stringify({ server: runnerServer, tool: runnerTool, args }),
      });
      setRunnerResult(result);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunnerBusy(false);
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
        description="JIT manages its own MCP servers. Import servers from a client config, or add one manually. JIT's copy is separate from the client's."
        actions={
          <>
            {connectedServers.length > 0 ? (
              <Button onClick={openRunner}>Run a tool</Button>
            ) : null}
            <Button onClick={() => void showImports()}>Import configs</Button>
            <Button variant="primary" onClick={ctx.openMcpAdd}>
              Add server
            </Button>
          </>
        }
      />

      {busy ? (
        <ActivityStatus>
          {busyAction === "connect"
            ? `Connecting to ${busy} and discovering tools…`
            : busyAction === "disconnect"
              ? `Disconnecting ${busy}…`
              : `Removing ${busy} from JIT…`}
        </ActivityStatus>
      ) : null}

      {total === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty
            title="No servers yet."
            actions={
              <Button variant="primary" onClick={() => void showImports()}>
                Import configs
              </Button>
            }
          >
            Import a server you already use, or add one manually.
          </Empty>
        </Panel>
      ) : (
        <Panel id="servers-table">
          <PanelHead
            title="Servers"
            hint={`${fmt(connected)} of ${fmt(total)} connected`}
          />
          <TableWrap>
            <Table className="w-full min-w-[600px] table-fixed">
              <thead>
                <tr>
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
                  const connecting =
                    busy === server.name && busyAction === "connect";
                  const disconnecting =
                    busy === server.name && busyAction === "disconnect";
                  const removing =
                    busy === server.name && busyAction === "remove";
                  return (
                    <Tr key={server.name}>
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
                        title="Tools the server exposes"
                      >
                        {fmt(server.tool_count)}
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {server.status === "connected" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === server.name}
                              lead={disconnecting ? <Spinner /> : undefined}
                              onClick={() => void act(server.name, "disconnect")}
                            >
                              {disconnecting ? "Disconnecting…" : "Disconnect"}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === server.name}
                              lead={connecting ? <Spinner /> : undefined}
                              onClick={() => void act(server.name, "connect")}
                            >
                              {connecting
                                ? "Connecting…"
                                : server.status === "error"
                                  ? "Retry"
                                  : "Connect"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === server.name}
                            lead={removing ? <Spinner /> : undefined}
                            title="Remove from JIT; the external config is untouched"
                            onClick={() => void act(server.name, "remove")}
                          >
                            {removing ? "Removing…" : "Remove"}
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

      {runnerOpen ? (
        <Panel>
          <PanelHead
            title="Run a tool"
            hint={`${fmt(connectedServers.length)} of ${fmt(total)} connected`}
          />
          <PanelBody className="space-y-4">
            {connectedServers.length === 0 ? (
              <p className="py-2 text-center text-sm text-ink-2">
                Connect a server first.
              </p>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Server">
                    <Select
                      value={runnerServer}
                      onChange={(event) =>
                        void pickRunnerServer(event.target.value)
                      }
                    >
                      {connectedServers.map((server) => (
                        <option key={server.name} value={server.name}>
                          {server.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Tool">
                    <Select
                      value={runnerTool}
                      onChange={(event) => pickRunnerTool(event.target.value)}
                    >
                      {runnerTools.length === 0 ? (
                        <option value="">No tools loaded</option>
                      ) : null}
                      {runnerTools.map((tool) => (
                        <option key={tool.name} value={tool.name}>
                          {tool.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                {(() => {
                  const tool = runnerTools.find(
                    (entry) => entry.name === runnerTool,
                  );
                  return tool?.description ? (
                    <p className="text-xs leading-relaxed text-ink-3">
                      {tool.description}
                    </p>
                  ) : null;
                })()}

                <Field
                  label="Arguments (JSON)"
                  hint="Scaffolded from the tool's schema; edit freely."
                >
                  <Textarea
                    value={runnerArgs}
                    spellCheck={false}
                    onChange={(event) => setRunnerArgs(event.target.value)}
                  />
                </Field>

                {runnerError ? (
                  <p className="text-xs text-danger">{runnerError}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    disabled={runnerBusy || !runnerTool}
                    lead={runnerBusy ? <Spinner /> : undefined}
                    onClick={() => void runTool()}
                  >
                    {runnerBusy ? "Running…" : "Run"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRunnerOpen(false);
                      setRunnerResult(null);
                      setRunnerError("");
                    }}
                  >
                    Close
                  </Button>
                </div>

                {runnerBusy ? (
                  <ActivityStatus>
                    Running {runnerTool} on {runnerServer}…
                  </ActivityStatus>
                ) : null}

                {runnerResult ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <StatusDot tone={runnerResult.isError ? "bad" : "ok"} />
                      <span className="text-xs text-ink-2">
                        {runnerResult.isError
                          ? "The tool reported an error."
                          : "Completed."}
                      </span>
                    </div>
                    <pre className="surface max-h-72 overflow-auto rounded-xl border border-line p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                      {(runnerResult.content || [])
                        .map((block) =>
                          block.type === "text" && block.text
                            ? block.text
                            : JSON.stringify(block),
                        )
                        .filter(Boolean)
                        .join("\n\n") || "(empty result)"}
                    </pre>
                  </div>
                ) : null}
              </>
            )}
          </PanelBody>
        </Panel>
      ) : null}

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

            {importsLoading ? (
              <ActivityStatus>Checking known MCP client configs…</ActivityStatus>
            ) : importError ? (
              <p className="py-4 text-center text-sm text-ink-2">{importError}</p>
            ) : imports.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-2">
                No servers found in client configs.
              </p>
            ) : (
              <div className="surface divide-y divide-line overflow-hidden rounded-xl border border-line">
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
                lead={importBusy ? <Spinner /> : undefined}
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
            {importBusy ? (
              <ActivityStatus>Importing selected server configs…</ActivityStatus>
            ) : null}
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  );
}
