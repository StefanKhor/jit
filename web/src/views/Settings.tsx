import { useEffect, useRef, useState, type FormEvent } from "react";

import { setAuthKey } from "../api";
import { fmt, summary } from "../format";
import { useJit } from "../state/store";
import type { IndexExport } from "../types";
import { Badge, Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Field, Input, ToggleRow } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { Slider } from "../ui/Slider";

export function Settings() {
  const ctx = useJit();
  const config = ctx.config;
  const [nebiusKey, setNebiusKey] = useState("");
  const [base, setBase] = useState("");
  const [nano, setNano] = useState("");
  const [rerank, setRerank] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState("");
  const [marketUrls, setMarketUrls] = useState<string[]>([]);
  const [newMarketUrl, setNewMarketUrl] = useState("");
  const [threshold, setThreshold] = useState(0.6);
  const [skillspectorLlm, setSkillspectorLlm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!config) return;
    setBase(config.nebius_api_base || "");
    setNano(config.nemotron_nano_model || "");
    setRerank(Boolean(config.rerank_enabled));
    setThreshold(Number(config.confidence_threshold ?? 0.6));
    setSkillspectorLlm(Boolean(config.skillspector_llm_enabled));
    setMarketUrls(Array.isArray(config.marketplace_urls) ? config.marketplace_urls : []);
  }, [config]);

  const saveRerank = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("rerank");
    try {
      const updates: Record<string, unknown> = {
        nebius_api_base: base.trim(),
        nemotron_nano_model: nano.trim(),
        rerank_enabled: rerank,
      };
      if (nebiusKey.trim()) updates.nebius_api_key = nebiusKey.trim();
      await ctx.saveConfig(updates);
      setNebiusKey("");
      ctx.toast("Settings saved.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const saveThreshold = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("threshold");
    try {
      await ctx.saveConfig({ confidence_threshold: threshold });
      ctx.toast(`Confidence threshold set to ${threshold.toFixed(2)}.`);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const saveSkillspectorLlm = async (enabled: boolean) => {
    setSkillspectorLlm(enabled);
    setSaving("skillspector-llm");
    try {
      await ctx.saveConfig({ skillspector_llm_enabled: enabled });
      ctx.toast(
        enabled
          ? "SkillSpector semantic LLM analysis enabled."
          : "SkillSpector static-only analysis enabled.",
      );
    } catch (error) {
      setSkillspectorLlm(Boolean(config?.skillspector_llm_enabled));
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const saveMarketplaces = async (next: string[]) => {
    setSaving("market");
    try {
      await ctx.saveConfig({ marketplace_urls: next });
      setMarketUrls(next);
      ctx.toast("Marketplace catalogs saved.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const addMarketplace = async (event: FormEvent) => {
    event.preventDefault();
    const value = newMarketUrl.trim();
    if (!value) return;
    if (marketUrls.includes(value)) {
      setNewMarketUrl("");
      return;
    }
    await saveMarketplaces([...marketUrls, value]);
    setNewMarketUrl("");
  };

  const removeMarketplace = async (url: string) => {
    await saveMarketplaces(marketUrls.filter((item) => item !== url));
  };

  const removeKey = async () => {
    const ok = await ctx.confirmAction(
      "Remove the API key?",
      "Reranking will fall back to local hybrid search.",
      "Remove",
    );
    if (!ok) return;
    try {
      await ctx.saveConfig({ nebius_api_key: "" });
      ctx.toast("API key removed.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const saveAuth = async (event: FormEvent) => {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) {
      ctx.toast("Enter a key, or use Disable auth to turn auth off.", "error");
      return;
    }
    setSaving("auth");
    try {
      await ctx.saveConfig({ api_key: value });
      setAuthKey(value || null);
      setApiKey("");
      ctx.toast(
        value
          ? "Dashboard key set. It will be required on the next load."
          : "Dashboard auth disabled.",
      );
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const clearAuth = async () => {
    const ok = await ctx.confirmAction(
      "Disable dashboard auth?",
      "Anyone who can reach this port will be able to use the dashboard and API.",
      "Disable",
    );
    if (!ok) return;
    try {
      await ctx.saveConfig({ api_key: "" });
      setAuthKey(null);
      ctx.toast("Dashboard auth disabled.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const exportData = async () => {
    try {
      const data = await ctx.api<IndexExport>("/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `jit-index-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      ctx.toast(`Exported ${fmt(data.items.length)} items.`);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const importData = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = await ctx.api<{
        added: number;
        updated: number;
        skipped: number;
        errors: string[];
      }>("/api/import", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      ctx.toast(
        summary(result),
        (result.errors || []).length ? "error" : "ok",
      );
      await ctx.refreshAll();
      if (ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(
        error instanceof SyntaxError
          ? "That file is not valid JSON."
          : error instanceof Error
            ? error.message
            : String(error),
        "error",
      );
    }
  };

  const clearIndex = async () => {
    const ok = await ctx.confirmAction(
      "Clear the index?",
      "Every skill and tool will be removed from the JIT index. JIT-owned skill files and source files stay on disk.",
      "Clear index",
    );
    if (!ok) return;
    try {
      await ctx.api("/api/clear", { method: "POST" });
      ctx.toast("Index cleared.");
      await ctx.refreshAll();
      if (ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const hasKey = Boolean(config?.nebius_api_key);
  const authOn = Boolean(config?.auth_enabled);
  const indexDir = config?.index_dir || "~/.jit";
  const keyHelp = config?.nebius_key_env
    ? "Set by NEBIUS_API_KEY in the environment."
    : `Stored in ${indexDir}/config.json with mode 600.`;
  const authHelp = config?.auth_env
    ? "Set by JIT_API_KEY in the environment."
    : "Changes take effect immediately. This browser keeps the new key.";

  const rerankState = !hasKey
    ? "no key"
    : config?.rerank_enabled
      ? "active"
      : "key saved";

  return (
    <div className="space-y-8">
      <PageHead
        kicker="06 — Settings"
        title="Configuration."
        description="Everything JIT reads at startup: the reranker, the retrieval bar, who may connect, and where state lives."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Panel>
            <PanelHead
              title="Reranking"
              hint="Nebius Token Factory"
              actions={
                <Badge
                  tone={
                    !hasKey ? "neutral" : config?.rerank_enabled ? "accent" : "neutral"
                  }
                >
                  {rerankState}
                </Badge>
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Nemotron Nano re-scores the top candidates before JIT returns
                one. Optional — local hybrid search works without it.
              </p>
              <form className="space-y-5" onSubmit={saveRerank}>
                <Field label="API key" hint={keyHelp}>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      hasKey ? `saved · ${config?.nebius_api_key}` : "not set"
                    }
                    value={nebiusKey}
                    disabled={Boolean(config?.nebius_key_env)}
                    onChange={(event) => setNebiusKey(event.target.value)}
                  />
                </Field>
                <div className="grid gap-5 md:grid-cols-2">
                  <Field label="API base">
                    <Input
                      type="text"
                      spellCheck={false}
                      value={base}
                      onChange={(event) => setBase(event.target.value)}
                    />
                  </Field>
                  <Field label="Nano model">
                    <Input
                      type="text"
                      spellCheck={false}
                      value={nano}
                      onChange={(event) => setNano(event.target.value)}
                    />
                  </Field>
                </div>
                <ToggleRow
                  label="Enable reranking"
                  hint="Re-score candidates with Nemotron Nano."
                  checked={rerank}
                  onCheckedChange={setRerank}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={saving === "rerank"}
                  >
                    {saving === "rerank" ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    disabled={!hasKey || Boolean(config?.nebius_key_env)}
                    onClick={() => void removeKey()}
                  >
                    Remove key
                  </Button>
                </div>
              </form>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="SkillSpector analysis"
              hint={skillspectorLlm ? "static + semantic" : "static only"}
              actions={
                <Badge tone={skillspectorLlm ? "accent" : "neutral"}>
                  {skillspectorLlm ? "LLM on" : "LLM off"}
                </Badge>
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Static checks always run. Semantic analysis sends skill content
                to SkillSpector’s configured model provider and may add latency
                or provider costs. Configure provider credentials in the JIT
                process environment before enabling it.
              </p>
              <ToggleRow
                label="Enable semantic LLM analysis"
                hint={
                  config?.skillspector_llm_env
                    ? "Controlled by JIT_SKILLSPECTOR_LLM in the environment."
                    : "Off by default; static SkillSpector scanning needs no model credentials."
                }
                checked={skillspectorLlm}
                disabled={Boolean(config?.skillspector_llm_env) || saving === "skillspector-llm"}
                onCheckedChange={(enabled) => void saveSkillspectorLlm(enabled)}
              />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Retrieval threshold" hint="recall vs precision" />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                JIT returns a match only when the score clears this bar. Lower it
                to catch more (more false positives), raise it to return only
                confident matches. Measure the effect with{" "}
                <code className="num rounded border border-line-2 bg-raised px-1 py-0.5 text-[11px] text-ink-2">
                  npm run eval
                </code>{" "}
                and the Search view.
              </p>
              <form className="space-y-5" onSubmit={saveThreshold}>
                <Field
                  label="Confidence threshold"
                  hint="Rerank scores are 0–3 scaled to 0–1; cosine and the keyword fallback are also 0–1. Default 0.6."
                >
                  <div className="flex items-center gap-4">
                    <Slider
                      aria-label="Confidence threshold"
                      min={0.2}
                      max={0.95}
                      step={0.05}
                      value={threshold}
                      onValueChange={setThreshold}
                      className="flex-1"
                    />
                    <span className="num w-10 shrink-0 text-right text-sm text-ink">
                      {threshold.toFixed(2)}
                    </span>
                  </div>
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={saving === "threshold"}
                  >
                    {saving === "threshold" ? "Saving…" : "Save"}
                  </Button>
                </div>
              </form>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Access"
              hint={authOn ? "enabled" : "off"}
              actions={
                <Badge tone={authOn ? "ok" : "neutral"}>
                  {authOn ? "on" : "off"}
                </Badge>
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Require a key before the dashboard and API can be used. Useful
                when JIT listens on a network interface.
              </p>
              <form className="space-y-5" onSubmit={saveAuth}>
                <Field label="Dashboard key" hint={authHelp}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={authOn ? "•••• (set)" : "not set"}
                    value={apiKey}
                    disabled={Boolean(config?.auth_env)}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={saving === "auth" || Boolean(config?.auth_env)}
                  >
                    {saving === "auth" ? "Saving…" : "Set key"}
                  </Button>
                  <Button
                    type="button"
                    disabled={!authOn || Boolean(config?.auth_env)}
                    onClick={() => void clearAuth()}
                  >
                    Disable auth
                  </Button>
                </div>
              </form>
            </PanelBody>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHead
              title="Marketplace catalogs"
              hint={
                marketUrls.length
                  ? `${fmt(marketUrls.length)} configured`
                  : "none configured"
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                JIT has no built-in catalog. Add one or more remote catalog URLs
                (JSON with an items array) to populate the marketplace; a later
                source overrides an earlier entry with the same id. A repository
                works too: enter{" "}
                <code className="num rounded border border-line-2 bg-raised px-1 py-0.5 text-[11px] text-ink-2">
                  owner/repo
                </code>{" "}
                or a repo link, and JIT resolves it with the{" "}
                <code className="num rounded border border-line-2 bg-raised px-1 py-0.5 text-[11px] text-ink-2">
                  skills
                </code>{" "}
                CLI.
              </p>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={addMarketplace}
              >
                <Input
                  type="text"
                  aria-label="Catalog URL"
                  placeholder="https://example.com/catalog.json or owner/repo"
                  spellCheck={false}
                  autoComplete="off"
                  value={newMarketUrl}
                  onChange={(event) => setNewMarketUrl(event.target.value)}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saving === "market" || !newMarketUrl.trim()}
                >
                  {saving === "market" ? "Saving…" : "Add"}
                </Button>
              </form>
              {marketUrls.length === 0 ? (
                <p className="text-xs text-ink-3">No catalogs configured.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {marketUrls.map((url) => (
                    <li
                      key={url}
                      className="flex items-center justify-between gap-3 px-3 py-2.5"
                    >
                      <span
                        className="num min-w-0 truncate text-xs text-ink-2"
                        title={url}
                      >
                        {url}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void removeMarketplace(url)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Data" hint="portable JSON" />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Export the index with full skill bodies, or restore a previous
                export.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void exportData()}>Export</Button>
                <Button onClick={() => fileRef.current?.click()}>Import</Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  aria-label="Import index file"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importData(file);
                    event.target.value = "";
                  }}
                />
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Paths" hint="where JIT keeps state" />
            <dl className="text-sm">
              <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
                <dt className="text-xs text-ink-3">Index directory</dt>
                <dd
                  className="num min-w-0 truncate text-ink"
                  title={indexDir}
                >
                  {indexDir}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-xs text-ink-3">Embeddings</dt>
                <dd className="min-w-0 truncate text-ink">
                  {config?.embedding_model || "local"}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel className="border-bad/30">
            <PanelHead title="Danger zone" hint="cannot be undone" />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Remove every item from the JIT index. JIT-owned skill files and
                your source files stay on disk.
              </p>
              <Button variant="danger" onClick={() => void clearIndex()}>
                Clear index
              </Button>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <Meta>JIT v{ctx.health?.version || "1.0.0"} · MIT</Meta>
    </div>
  );
}
