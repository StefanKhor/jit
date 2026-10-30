import { useEffect, useState, type FormEvent } from "react";

import { useJit } from "../state/store";
import type { InstallResult } from "../types";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { ActivityStatus, Spinner } from "../ui/Display";
import { Field, Input, Textarea } from "../ui/Field";

const DEFAULT_CONFIG =
  '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-memory"]\n}';

/** Hand-write an MCP server definition; JIT stores it in its own config. */
export function McpAddDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [name, setName] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setConfig(DEFAULT_CONFIG);
    setError("");
    setBusy(false);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const safeName = name.trim();
    if (!safeName) {
      setError("Name is required.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.trim());
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("The config must be a JSON object.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await ctx.api<InstallResult>("/api/mcp/add", {
        method: "POST",
        body: JSON.stringify({ name: safeName, config: parsed }),
      });
      onClose();
      if (result.connected === false) {
        ctx.toast(
          `Added, but not connected: ${result.error || "connection failed"}`,
          "error",
        );
      } else {
        ctx.toast(`Added ${safeName}.`);
      }
      await ctx.refreshAll();
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
      labelledBy="mcp-add-title"
      className="w-[min(40rem,calc(100vw-2rem))]"
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogHead
          kicker="Manual install"
          title={<span id="mcp-add-title">Add an MCP server.</span>}
          onClose={onClose}
        />
        <DialogBody className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-2">
            Use a command or a streamable HTTP URL. The definition is stored in{" "}
            <span className="num">
              {`${ctx.config?.index_dir || "~/.jit"}/mcp.json`}
            </span>{" "}
            with mode 600.
          </p>
          {busy ? (
            <ActivityStatus>Adding the server and connecting…</ActivityStatus>
          ) : null}
          <Field label="Name" hint="How the server is referenced in JIT.">
            <Input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="my-server"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="JSON config"
            hint="A command and args, or a streamable HTTP url."
          >
            <Textarea
              spellCheck={false}
              value={config}
              onChange={(event) => setConfig(event.target.value)}
            />
          </Field>
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
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            lead={busy ? <Spinner /> : undefined}
          >
            {busy ? "Connecting…" : "Add & connect"}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
