import { useEffect, useMemo, useState, type FormEvent } from "react";

import { fmt } from "../format";
import { useJit } from "../state/store";
import type {
  InspectResult,
  InstallResult,
  MarketplaceInput,
  MarketplaceItem,
} from "../types";
import { StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { Field, Input, ToggleRow } from "../ui/Field";

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

/**
 * Inspect before install: the resolved command, the scan findings, an optional
 * checksum acknowledgement, then the install request itself.
 */
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

  const commandLabel =
    item.kind === "mcp" ? "Runs on this machine" : "Installs to";
  const reviewStatus = checksumMissing
    ? "Unpinned — installation blocked"
    : inspect?.report.ok
      ? "No risky patterns found"
      : `${inspect?.report.findings.length || 0} pattern${
          inspect?.report.findings.length === 1 ? "" : "s"
        } to review`;
  const hasFindings = Boolean(inspect?.report.findings.length);
  const checksumPinned = Boolean(inspect?.checksum_required && inspect.checksum_present);

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy="market-dialog-title"
      className="w-[min(38rem,calc(100vw-2rem))]"
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogHead
          kicker={item.kind === "mcp" ? "MCP server" : "Skill"}
          title={<span id="market-dialog-title">{item.name}</span>}
          onClose={onClose}
        />
        <DialogBody className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-2">
            {item.description}
          </p>

          <section className="space-y-2">
            <h3 className="kicker">{commandLabel}</h3>
            <pre className="num min-w-0 overflow-x-auto rounded-xl border border-line bg-inset p-3.5 text-xs leading-relaxed text-ink-2">
              {commandPreview}
            </pre>
          </section>

          {inspecting || inspect ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="kicker">Review</h3>
                {inspecting ? (
                  <span className="num text-[11px] text-ink-3">checking…</span>
                ) : null}
              </div>
              {inspecting ? (
                <p className="text-sm text-ink-2">Reviewing this entry…</p>
              ) : inspect ? (
                <>
                  <p
                    className={cx(
                      "flex items-center gap-2 text-sm font-medium",
                      requiresAck || checksumMissing
                        ? "text-warn"
                        : inspect.report.ok
                          ? "text-ok"
                          : "text-ink",
                    )}
                  >
                    <StatusDot
                      tone={
                        checksumMissing
                          ? "bad"
                          : requiresAck
                            ? "warn"
                            : inspect.report.ok
                              ? "ok"
                              : "neutral"
                      }
                    />
                    {reviewStatus}
                  </p>

                  {hasFindings || checksumMissing || checksumPinned ? (
                    <ul className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-inset/40">
                      {checksumMissing ? (
                        <li className="flex items-start gap-2.5 px-3.5 py-3 text-sm">
                          <StatusDot tone="bad" className="mt-1.5" />
                          <span className="min-w-0 leading-relaxed text-ink-2">
                            This entry fetches a remote body with no{" "}
                            <code className="num">sha256</code> checksum, so its
                            contents could change between review and install. Add
                            a checksum to the catalog to install it.
                          </span>
                        </li>
                      ) : null}
                      {inspect.report.findings.map((finding, index) => (
                        <li
                          className="flex items-start gap-2.5 px-3.5 py-3 text-sm"
                          key={`${finding.rule}-${index}`}
                        >
                          <StatusDot
                            className="mt-1.5"
                            tone={
                              finding.level === "high"
                                ? "bad"
                                : finding.level === "medium"
                                  ? "warn"
                                  : "neutral"
                            }
                          />
                          <span className="min-w-0 leading-relaxed text-ink-2">
                            <span className="num text-ink">{finding.rule}</span> —{" "}
                            {finding.detail}
                          </span>
                        </li>
                      ))}
                      {checksumPinned ? (
                        <li className="flex items-start gap-2.5 px-3.5 py-3 text-sm">
                          <StatusDot tone="ok" className="mt-1.5" />
                          <span className="min-w-0 leading-relaxed text-ink-2">
                            Body is pinned to a sha256 checksum.
                          </span>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {(item.inputs || []).length ? (
            <section className="space-y-4">
              <h3 className="kicker">Configuration</h3>
              {(item.inputs || []).map((input: MarketplaceInput) => {
                const name = input.label || input.key;
                return (
                  <Field
                    key={input.key}
                    label={input.required ? name : `${name} optional`}
                    hint={input.help}
                  >
                    <Input
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
                  </Field>
                );
              })}
            </section>
          ) : null}

          {item.kind === "mcp" ? (
            <ToggleRow
              label="I understand this starts a local process."
              checked={consent}
              onCheckedChange={setConsent}
            />
          ) : null}

          {requiresAck ? (
            <ToggleRow
              label="I have read the review above and want to install this entry anyway. Its text will be injected into my agent's context."
              checked={ack}
              onCheckedChange={setAck}
            />
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
          <Button variant="primary" type="submit" disabled={!canInstall || busy}>
            {busy
              ? "Installing…"
              : item.kind === "mcp"
                ? "Install & connect"
                : "Install"}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
