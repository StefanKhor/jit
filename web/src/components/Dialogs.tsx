import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useJit } from "../context";
import { fmt, summary } from "../format";
import type {
  ConfigPath,
  ConfirmRequest,
  InspectResult,
  InstallResult,
  MarketplaceInput,
  MarketplaceItem,
  SkillDetail,
  ToastMessage,
} from "../types";
import { Dialog } from "./ui";

export function Toast({ toast }: { toast: ToastMessage | null }) {
  return (
    <div
      className={`toast${toast ? " is-visible" : ""}`}
      data-kind={toast?.kind || "ok"}
      role="status"
      aria-live="polite"
    >
      {toast?.message || ""}
    </div>
  );
}

export function ConfirmDialog({
  request,
  onDone,
}: {
  request: ConfirmRequest | null;
  onDone: () => void;
}) {
  if (!request) return null;
  const finish = (value: boolean) => {
    request.resolve(value);
    onDone();
  };
  return (
    <Dialog open onClose={() => finish(false)}>
      <div className="sheet">
        <div className="kicker">Confirm</div>
        <h2>{request.title}</h2>
        <p className="sheet-copy">{request.text}</p>
        <div className="sheet-actions">
          <button className="btn btn-quiet" type="button" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className="btn btn-solid" type="button" onClick={() => finish(true)}>
            {request.label}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function SetupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [key, setKey] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKey("");
      setScan(false);
    }
  }, [open]);

  const save = async () => {
    const updates: Record<string, unknown> = { complete_setup: true };
    if (key.trim()) updates.nebius_api_key = key.trim();
    await ctx.saveConfig(updates);
  };

  const finish = async (goMarketplace: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await save();
      if (scan) {
        const result = await ctx.api<{
          found?: number;
          added?: number;
          updated?: number;
          skipped?: number;
          errors?: string[];
        }>("/api/skills/scan", { method: "POST" });
        ctx.toast(
          summary(result),
          (result.errors || []).length ? "error" : "ok",
        );
      }
      onClose();
      await ctx.refreshAll();
      if (goMarketplace) {
        ctx.setView("marketplace");
        await ctx.loadMarketplace();
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) void finish(false);
      }}
    >
      <form
        className="sheet"
        onSubmit={(event) => {
          event.preventDefault();
          void finish(false);
        }}
      >
        <div className="sheet-mark">
          <svg
            viewBox="0 0 24 24"
            width="28"
            height="28"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3.5 6h17M3.5 12h10M3.5 18h13"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <rect x="17" y="9.5" width="4" height="5" fill="currentColor" />
          </svg>
        </div>
        <div className="kicker">First run</div>
        <h2>Welcome to JIT.</h2>
        <p className="sheet-copy">
          JIT starts empty. Install from the marketplace, or import what you
          already use. Nothing is read from your client configs automatically.
        </p>
        <label className="field">
          <span className="field-label">
            Nebius API key <em>optional</em>
          </span>
          <input
            type="password"
            autoComplete="off"
            placeholder="nb_..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <span className="field-help">
            Enables Nemotron Nano reranking through Nebius Token Factory.
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={scan}
            onChange={(event) => setScan(event.target.checked)}
          />{" "}
          Index skills already on this machine <em>optional</em>
        </label>
        <p
          className="field-help"
          style={{ marginTop: "-16px", marginBottom: "22px" }}
        >
          Reads the usual skill folders once. Source files are not modified.
        </p>
        <div className="sheet-actions">
          <button
            className="btn btn-quiet push-left"
            type="button"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            Browse marketplace
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            disabled={busy}
            onClick={() => void finish(false)}
          >
            Skip for now
          </button>
          <button className="btn btn-solid" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Finish setup"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SkillDialog({
  open,
  detail,
  onClose,
}: {
  open: boolean;
  detail: SkillDetail | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} className="wide">
      <div className="dialog-head">
        <div>
          <div className="kicker">
            {detail?.kind === "tool" ? "MCP tool" : "Skill"}
          </div>
          <h2>{detail?.name || "—"}</h2>
        </div>
        <button
          className="dialog-close"
          type="button"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="dialog-meta">
        {detail
          ? [
              detail.kind,
              (detail.categories || []).join(" · "),
              `${fmt(detail.tokens)} tokens`,
              detail.path,
            ]
              .filter(Boolean)
              .join("  —  ")
          : "—"}
      </div>
      <div className="dialog-body">
        <pre>{detail?.body || "(empty)"}</pre>
      </div>
    </Dialog>
  );
}

function fillPreview(value: string, values: Record<string, string>): string {
  let result = value;
  for (const [key, replacement] of Object.entries(values)) {
    result = result.split(`{{${key}}}`).join(replacement || `{{${key}}}`);
  }
  return result;
}

// A skill discovered on skills.sh is in no configured catalog, so the review and
// install calls carry the source it came from. Catalog entries have no such
// source and resolve by id alone.
function sourceHint(item: MarketplaceItem): Record<string, string> {
  const install = item.install || {};
  const source = String(install.skills_source || "").trim();
  const skill = String(install.skills_name || "").trim();
  return source ? { source, skill } : {};
}

export function MarketDialog({
  item,
  onClose,
}: {
  item: MarketplaceItem | null;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [ack, setAck] = useState(false);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!item) return;
    const initial: Record<string, string> = {};
    for (const input of item.inputs || []) {
      initial[input.key] = String(input.default || "");
    }
    setValues(initial);
    setConsent(false);
    setAck(false);
    setError("");
    setBusy(false);
    setInspect(null);
    setInspecting(true);
    let cancelled = false;
    ctx
      .api<InspectResult>("/api/marketplace/inspect", {
        method: "POST",
        body: JSON.stringify({ id: item.id, ...sourceHint(item) }),
      })
      .then((result) => {
        if (!cancelled) setInspect(result);
      })
      .catch(() => {
        if (!cancelled) setInspect(null);
      })
      .finally(() => {
        if (!cancelled) setInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const previewValues = useMemo(() => {
    const preview: Record<string, string> = {};
    for (const input of item?.inputs || []) {
      const value = values[input.key] || "";
      preview[input.key] = input.secret && value ? "••••" : value;
    }
    return preview;
  }, [item, values]);

  if (!item) return null;

  const install = item.install || {};
  const url = String(install.url || install.serverUrl || "");
  const commandParts = Array.isArray(install.command)
    ? install.command
    : [install.command];
  const command = [
    ...commandParts,
    ...(Array.isArray(install.args) ? install.args : []),
  ]
    .filter((part) => part != null && part !== "")
    .map((part) => fillPreview(String(part), previewValues))
    .join(" ");
  const env = Object.keys(
    (install.env as Record<string, unknown> | undefined) || {},
  )
    .map((key) => `${key}=••••`)
    .join(" ");
  const commandPreview =
    item.kind === "mcp"
      ? url
        ? `HTTP ${fillPreview(url, previewValues)}`
        : [env, command].filter(Boolean).join(" ") || "—"
      : `${ctx.config?.index_dir || "~/.jit"}/skills/${item.id}/SKILL.md`;

  const checksumMissing = Boolean(
    inspect && inspect.checksum_required && !inspect.checksum_present,
  );
  const requiresAck = Boolean(inspect?.report.requires_ack);
  const canInstall =
    !checksumMissing &&
    (item.inputs || [])
      .filter((input) => input.required)
      .every((input) => Boolean(values[input.key]?.trim())) &&
    (item.kind !== "mcp" || consent) &&
    (!requiresAck || ack);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canInstall || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await ctx.api<InstallResult>("/api/marketplace/install", {
        method: "POST",
        body: JSON.stringify({
          // Reviewing resolves the real id from SKILL.md; install with that so
          // the two calls cannot disagree about which skill is being installed.
          id: inspect?.id || item.id,
          inputs: values,
          acknowledge: ack,
          ...sourceHint(item),
        }),
      });
      onClose();
      if (result.connected === false) {
        ctx.toast(
          `Installed, but not connected: ${result.error || "connection failed"}`,
          "error",
        );
      } else if ((result.errors || []).length) {
        ctx.toast(`Installed · ${result.errors?.[0] || ""}`, "error");
      } else if (item.kind === "mcp") {
        ctx.toast(
          `Connected to ${item.name} · ${fmt(result.added || 0)} tools indexed.`,
        );
      } else {
        ctx.toast(`${item.name} installed.`);
      }
      await ctx.refreshAll();
      await ctx.loadMarketplace(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <form className="sheet dialog-form" onSubmit={submit}>
        <div className="kicker">
          {item.kind === "mcp" ? "MCP server" : "Skill"}
        </div>
        <h2>{item.name}</h2>
        <p className="sheet-copy">{item.description}</p>
        <div className="install-command">
          <div className="field-label">
            {item.kind === "mcp" ? "Runs on this machine" : "Installs to"}
          </div>
          <pre>{commandPreview}</pre>
        </div>

        {inspecting ? (
          <div className="review">
            <div className="review-title">Reviewing this entry…</div>
          </div>
        ) : inspect ? (
          <div
            className={`review${
              inspect.report.ok && !checksumMissing ? " is-ok" : ""
            }`}
          >
            <div
              className={`review-title${
                inspect.report.requires_ack || checksumMissing ? " is-warn" : ""
              }`}
            >
              {checksumMissing
                ? "Unpinned — installation blocked"
                : inspect.report.ok
                  ? "No risky patterns found"
                  : `${inspect.report.findings.length} pattern${
                      inspect.report.findings.length === 1 ? "" : "s"
                    } to review`}
            </div>
            {checksumMissing ? (
              <ul className="review-list">
                <li className="review-item">
                  <i className="dot bad" />
                  <span>
                    This entry fetches a remote body with no <code>sha256</code>{" "}
                    checksum, so its contents could change between review and
                    install. Add a checksum to the catalog to install it.
                  </span>
                </li>
              </ul>
            ) : null}
            {inspect.report.findings.length ? (
              <ul className="review-list">
                {inspect.report.findings.map((finding, index) => (
                  <li className="review-item" key={`${finding.rule}-${index}`}>
                    <i
                      className={`dot ${
                        finding.level === "high"
                          ? "bad"
                          : finding.level === "medium"
                            ? "warn"
                            : ""
                      }`}
                    />
                    <span>
                      <span className="review-rule">{finding.rule}</span> —{" "}
                      {finding.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {inspect.checksum_required && inspect.checksum_present ? (
              <ul className="review-list">
                <li className="review-item">
                  <i className="dot ok" />
                  <span>Body is pinned to a sha256 checksum.</span>
                </li>
              </ul>
            ) : null}
          </div>
        ) : null}

        {(item.inputs || []).map((input: MarketplaceInput) => (
          <label className="field" key={input.key}>
            <span className="field-label">
              {input.label || input.key}
              {input.required ? "" : " "}
              {input.required ? null : <em>optional</em>}
            </span>
            <input
              type={input.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={values[input.key] || ""}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [input.key]: event.target.value,
                }))
              }
            />
            {input.help ? (
              <span className="field-help">{input.help}</span>
            ) : null}
          </label>
        ))}
        {item.kind === "mcp" ? (
          <label className="check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />{" "}
            I understand this starts a local process.
          </label>
        ) : null}
        {requiresAck ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            <span>
              I have read the review above and want to install this entry
              anyway. Its text will be injected into my agent's context.
            </span>
          </label>
        ) : null}
        <p className="install-error">{error}</p>
        <div className="sheet-actions">
          <button className="btn btn-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-solid"
            type="submit"
            disabled={!canInstall || busy}
          >
            {busy
              ? "Installing…"
              : item.kind === "mcp"
                ? "Install & connect"
                : "Install"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function McpAddDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [name, setName] = useState("");
  const [config, setConfig] = useState(
    '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-memory"]\n}',
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setConfig(
      '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-memory"]\n}',
    );
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
      } else if ((result.errors || []).length) {
        ctx.toast(`Added · ${result.errors?.[0] || ""}`, "error");
      } else {
        ctx.toast(
          `Added ${safeName} · ${fmt(result.added || 0)} tools indexed.`,
        );
      }
      await ctx.refreshAll();
      if (ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <form className="sheet dialog-form" onSubmit={submit}>
        <div className="kicker">Manual install</div>
        <h2>Add an MCP server.</h2>
        <p className="sheet-copy">
          Use a command or a streamable HTTP URL. The definition is stored in{" "}
          {ctx.config?.index_dir || "~/.jit"}/mcp.json with mode 600.
        </p>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="my-server"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">JSON config</span>
          <textarea
            spellCheck={false}
            value={config}
            onChange={(event) => setConfig(event.target.value)}
          />
        </label>
        <p className="install-error">{error}</p>
        <div className="sheet-actions">
          <button className="btn btn-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-solid" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Add & connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function TransferDialog({
  open,
  initialTab,
  onClose,
}: {
  open: boolean;
  initialTab: "in" | "out";
  onClose: () => void;
}) {
  const ctx = useJit();
  const [tab, setTab] = useState<"in" | "out">(initialTab);
  const [path, setPath] = useState("");
  const [copy, setCopy] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [dest, setDest] = useState("~/jit-skills");
  const [exportOverwrite, setExportOverwrite] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setPath("");
    setCopy(true);
    setOverwrite(false);
    setDest("~/jit-skills");
    setExportOverwrite(false);
    setSelected(
      new Set(ctx.skills.filter((skill) => skill.managed).map((skill) => skill.id)),
    );
    setError("");
    setBusy(false);
    // Skills are refreshed before the dialog opens; do not reset the form when
    // a background refresh lands while the user is selecting entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  const local = ctx.skills.filter((skill) => !skill.managed).length;
  const jit = ctx.skills.filter((skill) => skill.managed).length;

  const transferIn = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await ctx.api<{
        found?: number;
        copied?: string[];
        added?: number;
        updated?: number;
        skipped?: number;
        errors?: string[];
      }>("/api/skills/transfer", {
        method: "POST",
        body: JSON.stringify({ path, copy, overwrite }),
      });
      const errors = result.errors || [];
      if (errors.length) {
        setError(errors[0] || "");
        ctx.toast(summary(result), "error");
      } else {
        onClose();
        ctx.toast(summary(result));
      }
      await ctx.refreshAll();
      if (ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const transferOut = async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      setError("Select at least one skill.");
      return;
    }
    if (!dest.trim()) {
      setError("Choose a destination folder.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await ctx.api<{
        exported: Array<{ id: string; path: string }>;
        skipped: string[];
        errors: string[];
      }>("/api/skills/export", {
        method: "POST",
        body: JSON.stringify({
          ids,
          destination: dest,
          overwrite: exportOverwrite,
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
      ctx.toast(parts.join(" · "));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="wide">
      <div className="sheet dialog-form">
        <div className="kicker">Transfer</div>
        <h2>Move skills between local and JIT.</h2>
        <p className="sheet-copy">
          Copy a local folder into JIT's own storage, index files where they
          live, or export JIT entries back to a local skills folder.
        </p>

        <div className="transfer-tabs" role="tablist" aria-label="Transfer direction">
          <button
            className={`filter${tab === "in" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "in"}
            onClick={() => setTab("in")}
          >
            Into JIT
          </button>
          <button
            className={`filter${tab === "out" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "out"}
            onClick={() => setTab("out")}
          >
            Out of JIT
          </button>
        </div>

        <div className="transfer-map">
          <div className="transfer-node">
            <span>Local</span>
            <b>{fmt(local)}</b>
            <span>indexed in place</span>
          </div>
          <div className="transfer-arrow" aria-hidden="true">
            {tab === "in" ? "→" : "←"}
          </div>
          <div className="transfer-node">
            <span>JIT</span>
            <b>{fmt(jit)}</b>
            <span>owned copies</span>
          </div>
        </div>

        {tab === "in" ? (
          <div>
            <label className="field">
              <span className="field-label">
                Source path <em>optional</em>
              </span>
              <input
                type="text"
                placeholder="Leave empty for the usual skill folders"
                spellCheck={false}
                autoComplete="off"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <span className="field-help">
                A skill file or a folder. Empty scans the usual local skill
                folders.
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={copy}
                onChange={(event) => setCopy(event.target.checked)}
              />{" "}
              Copy into {ctx.config?.index_dir || "~/.jit"}/skills
            </label>
            <p
              className="field-help"
              style={{ marginTop: "-16px", marginBottom: "16px" }}
            >
              Checked: JIT owns the copy. Unchecked: JIT indexes the file where
              it lives.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />{" "}
              Overwrite existing JIT copies
            </label>
            <p className="install-error">{error}</p>
            <div className="sheet-actions">
              <button className="btn btn-quiet" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-solid"
                type="button"
                disabled={busy}
                onClick={() => void transferIn()}
              >
                {busy ? "Working…" : "Import"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {ctx.skills.length === 0 ? (
              <div className="transfer-empty">
                No skills indexed yet. Import one first.
              </div>
            ) : (
              <div className="transfer-list">
                {ctx.skills.map((skill) => (
                  <label className="transfer-row" key={skill.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(skill.id)}
                      onChange={(event) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(skill.id);
                          else next.delete(skill.id);
                          return next;
                        });
                      }}
                    />
                    <span>
                      <span className="transfer-name">
                        {skill.name}{" "}
                        <span className="tag">
                          {skill.managed ? "JIT copy" : "Local file"}
                        </span>
                      </span>
                      <span className="transfer-meta">
                        {skill.id} · {skill.path || "no path"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <label className="field">
              <span className="field-label">Destination folder</span>
              <input
                type="text"
                value={dest}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setDest(event.target.value)}
              />
              <span className="field-help">
                Each skill is written to &lt;destination&gt;/&lt;id&gt;/SKILL.md.
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={exportOverwrite}
                onChange={(event) => setExportOverwrite(event.target.checked)}
              />{" "}
              Overwrite existing files
            </label>
            <p className="install-error">{error}</p>
            <div className="sheet-actions">
              <button className="btn btn-quiet" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-solid"
                type="button"
                disabled={busy}
                onClick={() => void transferOut()}
              >
                {busy ? "Exporting…" : "Export selected"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

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
    <Dialog open={open} onClose={onClose} className="wide">
      <form className="sheet dialog-form" onSubmit={submit}>
        <div className="kicker">Transfer out</div>
        <h2>Export MCP servers.</h2>
        <p className="sheet-copy">
          Write JIT-managed server definitions into a client config. JIT keeps
          its own copy.
        </p>

        <div className="transfer-map">
          <div className="transfer-node">
            <span>JIT</span>
            <b>{fmt(ctx.mcpServers.length)}</b>
            <span>managed servers</span>
          </div>
          <div className="transfer-arrow" aria-hidden="true">
            →
          </div>
          <div className="transfer-node">
            <span>Client</span>
            <b>{destLabel}</b>
            <span>mcpServers / opencode</span>
          </div>
        </div>

        <div className="transfer-list">
          {ctx.mcpServers.map((server) => (
            <label className="transfer-row" key={server.name}>
              <input
                type="checkbox"
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
              <span>
                <span className="transfer-name">
                  {server.name} <span className="tag">{server.status}</span>
                </span>
                <span className="transfer-meta">
                  {server.source || "JIT-managed server"}
                </span>
              </span>
            </label>
          ))}
        </div>

        <label className="field">
          <span className="field-label">Destination config</span>
          <select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          >
            {paths.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.path}
                {entry.exists ? " · exists" : ""}
              </option>
            ))}
            <option value="custom">Custom path…</option>
          </select>
        </label>
        {destination === "custom" ? (
          <label className="field">
            <span className="field-label">Custom path</span>
            <input
              type="text"
              placeholder="~/path/to/mcp.json"
              spellCheck={false}
              autoComplete="off"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
          </label>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
          />{" "}
          Overwrite servers with the same name
        </label>
        <p className="transfer-warning">
          Environment variables and headers are copied as-is. Only export to a
          config you trust.
        </p>
        {loading ? <div className="search-pending">Reading client configs…</div> : null}
        <p className="install-error">{error}</p>
        <div className="sheet-actions">
          <button className="btn btn-quiet" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-solid"
            type="submit"
            disabled={busy || loading}
          >
            {busy ? "Exporting…" : "Export selected"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
