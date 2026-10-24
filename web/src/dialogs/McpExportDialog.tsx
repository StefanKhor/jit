import { useEffect, useState, type FormEvent } from "react";

import { fmt } from "../format";
import { useJit } from "../state/store";
import type { ConfigPath, McpStatus } from "../types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { Stat } from "../ui/Display";
import { Checkbox, Field, Input, ToggleRow } from "../ui/Field";
import { Select } from "../ui/Select";

const STATUS_TONE: Record<McpStatus, "neutral" | "ok" | "warn" | "bad"> = {
  disconnected: "neutral",
  connecting: "warn",
  connected: "ok",
  error: "bad",
};

/** Copy JIT-managed server definitions into a client config. */
export function McpExportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paths, setPaths] = useState<ConfigPath[]>([]);
  const [destination, setDestination] = useState("custom");
  const [custom, setCustom] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(ctx.mcpServers.map((server) => server.name)));
    setOverwrite(false);
    setError("");
    setCustom("");
    setLoading(true);
    void ctx.api<{ paths: ConfigPath[] }>("/api/mcp/configs")
      .then((data) => {
        setPaths(data.paths || []);
        // Prefer the project-local config. Selecting a real user config by
        // default makes an accidental click modify an unrelated client.
        const preferred =
          data.paths?.find(
            (entry) => entry.exists && entry.path.endsWith(".mcp.json"),
          )?.path || "custom";
        setDestination(preferred);
      })
      .catch((caught: unknown) => {
        setPaths([]);
        setDestination("custom");
        ctx.toast(
          caught instanceof Error ? caught.message : String(caught),
          "error",
        );
      })
      .finally(() => setLoading(false));
  }, [open]);

  const chosenDestination = destination === "custom" ? custom.trim() : destination;
  const destLabel = chosenDestination
    ? chosenDestination.split(/[\\/]/).pop()
    : "config";
  const destinationOptions = [
    ...paths.map((entry) => ({
      value: entry.path,
      label: entry.exists ? `${entry.path} · exists` : entry.path,
    })),
    { value: "custom", label: "Custom path…" },
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const servers = [...selected];
    if (servers.length === 0) {
      setError("Select at least one server.");
      return;
    }
    if (!chosenDestination) {
      setError("Choose a destination config.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await ctx.api<{
        exported: string[];
        skipped: string[];
        errors: string[];
        path: string;
      }>("/api/mcp/export", {
        method: "POST",
        body: JSON.stringify({
          servers,
          destination: chosenDestination,
          overwrite,
        }),
      });
      if (result.errors.length) {
        setError(result.errors[0] || "");
        ctx.toast(result.errors[0] || "Export failed", "error");
        return;
      }
      const parts = [`${fmt(result.exported.length)} exported`];
      if (result.skipped.length) parts.push(`${fmt(result.skipped.length)} skipped`);
      onClose();
      ctx.toast(`${parts.join(" · ")} · ${result.path}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="mcp-export-title"
      className="w-[min(40rem,calc(100vw-2rem))]"
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogHead
          kicker="Transfer out"
          title={<span id="mcp-export-title">Export MCP servers.</span>}
          onClose={onClose}
        />
        <DialogBody className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-2">
            Write JIT-managed server definitions into a client config. JIT keeps
            its own copy.
          </p>

          <div className="flex items-center gap-6 rounded-xl border border-line bg-inset/50 px-5 py-4">
            <Stat
              label="JIT"
              value={fmt(ctx.mcpServers.length)}
              hint="managed servers"
            />
            <span aria-hidden="true" className="shrink-0 text-ink-3">
              →
            </span>
            <div className="min-w-0 flex-1">
              <div className="kicker">Client</div>
              <div
                className="num mt-2 truncate text-2xl leading-none text-ink"
                title={chosenDestination || undefined}
              >
                {destLabel}
              </div>
              <div className="mt-2 text-xs text-ink-3">
                mcpServers / opencode
              </div>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
            {ctx.mcpServers.map((server) => (
              <label
                key={server.name}
                className="flex cursor-pointer items-start gap-3 border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-raised/40"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(server.name)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(server.name);
                      else next.delete(server.name);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm text-ink">
                    <span className="truncate">{server.name}</span>
                    <Badge tone={STATUS_TONE[server.status]}>
                      {server.status}
                    </Badge>
                  </span>
                  <span
                    className="num mt-1 block truncate text-[11px] text-ink-3"
                    title={server.source || ""}
                  >
                    {server.source || "JIT-managed server"}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <Field label="Destination config">
            <Select
              className="num"
              value={destination}
              onValueChange={setDestination}
              options={destinationOptions}
            />
          </Field>

          {destination === "custom" ? (
            <Field label="Custom path">
              <Input
                type="text"
                className="num"
                placeholder="~/path/to/mcp.json"
                spellCheck={false}
                autoComplete="off"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
              />
            </Field>
          ) : null}

          <ToggleRow
            label="Overwrite servers with the same name"
            checked={overwrite}
            onCheckedChange={setOverwrite}
          />

          <p className="text-xs leading-relaxed text-warn">
            Environment variables and headers are copied as-is. Only export to a
            config you trust.
          </p>

          {loading ? (
            <p className="text-xs text-ink-3">Reading client configs…</p>
          ) : null}

          {error ? (
            <p className="text-xs text-bad" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFoot>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || loading}>
            {busy ? "Exporting…" : "Export selected"}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
