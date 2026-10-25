import { useEffect, useRef, useState, type FormEvent } from "react";

import { setAuthKey } from "../api";
import { fmt, summary } from "../format";
import { useJit } from "../state/store";
import type { IndexExport } from "../types";
import { Badge, Meta } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Field, Input, ToggleRow } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { Select } from "../ui/Select";
import { Slider } from "../ui/Slider";

export function Settings() {
  const ctx = useJit();
  const config = ctx.config;
  const [rerankKey, setRerankKey] = useState("");
  const [rerankBase, setRerankBase] = useState("");
  const [rerankModel, setRerankModel] = useState("");
  const [embeddingProvider, setEmbeddingProvider] = useState<"local" | "openai-compatible">("local");
  const [localEmbeddingModel, setLocalEmbeddingModel] = useState("");
  const [localEmbeddingDim, setLocalEmbeddingDim] = useState("384");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [embeddingBase, setEmbeddingBase] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDim, setEmbeddingDim] = useState("1536");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState("");
  const [threshold, setThreshold] = useState(0.6);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!config) return;
    setRerankBase(config.rerank_api_base || "");
    setRerankModel(config.rerank_model || "");
    setEmbeddingProvider(config.embedding_provider || "local");
    setLocalEmbeddingModel(config.embedding_local_model || "");
    setLocalEmbeddingDim(String(config.embedding_local_dim || 384));
    setEmbeddingBase(config.embedding_api_base || "");
    setEmbeddingModel(config.embedding_api_model || "");
    setEmbeddingDim(String(config.embedding_api_dim || 1536));
    setThreshold(Number(config.confidence_threshold ?? 0.6));
  }, [config]);

  const saveRerank = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("rerank");
    try {
      const updates: Record<string, unknown> = {
        rerank_api_base: rerankBase.trim(),
        rerank_model: rerankModel.trim(),
      };
      if (rerankKey.trim()) updates.rerank_api_key = rerankKey.trim();
      await ctx.saveConfig(updates);
      setRerankKey("");
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

  const saveEmbedding = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("embedding");
    try {
      const updates: Record<string, unknown> = {
        embedding_provider: embeddingProvider,
        embedding_local_model: localEmbeddingModel.trim(),
        embedding_local_dim: Number(localEmbeddingDim),
        embedding_api_base: embeddingBase.trim(),
        embedding_api_model: embeddingModel.trim(),
        embedding_api_dim: Number(embeddingDim),
      };
      if (embeddingKey.trim()) updates.embedding_api_key = embeddingKey.trim();
      await ctx.saveConfig(updates);
      setEmbeddingKey("");
      ctx.toast("Embedding settings saved. Rebuild the vector index if the active provider or model changed.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const reindexEmbeddings = async () => {
    setSaving("embedding-reindex");
    try {
      const result = await ctx.api<{
        added: number;
        updated: number;
        skipped: number;
        errors: string[];
      }>("/api/embeddings/reindex", { method: "POST" });
      await ctx.refreshAll();
      if (result.errors.length) {
        ctx.toast(`Rebuild finished with ${result.errors.length} error(s): ${result.errors[0]}`, "error");
      } else {
        ctx.toast(`Vector index rebuilt: ${fmt(result.updated + result.added)} item(s) updated.`);
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving("");
    }
  };

  const removeEmbeddingKey = async () => {
    const ok = await ctx.confirmAction(
      "Remove the embeddings API key?",
      "Remote embedding providers require an API key. A local OpenAI-compatible endpoint may not.",
      "Remove",
    );
    if (!ok) return;
    try {
      await ctx.saveConfig({ embedding_api_key: "" });
      ctx.toast("Embeddings API key removed.");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const removeKey = async () => {
    const ok = await ctx.confirmAction(
      "Remove the reranker API key?",
      "The reranker will stop using authenticated remote endpoints. Local OpenAI-compatible endpoints may still work without a key.",
      "Remove",
    );
    if (!ok) return;
    try {
      await ctx.saveConfig({ rerank_api_key: "" });
      ctx.toast("Reranker API key removed.");
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
      "Every skill will be removed from the JIT index. JIT-owned skill files and source files stay on disk.",
      "Clear index",
    );
    if (!ok) return;
    try {
      await ctx.api("/api/clear", { method: "POST" });
      ctx.toast("Index cleared.");
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const hasKey = Boolean(config?.rerank_api_key);
  const hasEmbeddingKey = Boolean(config?.embedding_api_key);
  const authOn = Boolean(config?.auth_enabled);
  const indexDir = config?.index_dir || "~/.jit";
  const keyHelp = config?.rerank_key_env
    ? "Set by JIT_RERANK_API_KEY in the environment."
    : `Stored in ${indexDir}/config.json with mode 600.`;
  const authHelp = config?.auth_env
    ? "Set by JIT_API_KEY in the environment."
    : "Changes take effect immediately. This browser keeps the new key.";

  const localRerankEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
    rerankBase.trim(),
  );
  const rerankConfigured = Boolean(
    rerankBase.trim() && rerankModel.trim() && (hasKey || localRerankEndpoint),
  );
  const rerankState = rerankConfigured ? "active" : "not configured";
  const localEmbeddingEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
    embeddingBase.trim(),
  );
  const cloudEmbeddingConfigured = Boolean(
    embeddingBase.trim() &&
      embeddingModel.trim() &&
      (hasEmbeddingKey || embeddingKey.trim() || localEmbeddingEndpoint),
  );
  const embeddingState = embeddingProvider === "local"
    ? "built in · local"
    : cloudEmbeddingConfigured
      ? "cloud endpoint configured"
      : "configuration needed";

  return (
    <div className="space-y-8">
      <PageHead
        kicker="06 — Settings"
        title="Configuration."
        description="Choose local or OpenAI-compatible embeddings, configure the optional reranker, and manage access and index settings."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Panel>
            <PanelHead
              title="Embeddings"
              hint="required for semantic retrieval"
              actions={
                <Badge tone={embeddingProvider === "local" ? "neutral" : cloudEmbeddingConfigured ? "accent" : "warn"}>
                  {embeddingState}
                </Badge>
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Choose the built-in local model or an OpenAI-compatible embeddings API. Cloud mode sends skill text and search queries to that endpoint and may incur usage costs. Changing provider or model requires rebuilding indexed vectors.
              </p>
              <form className="space-y-5" onSubmit={saveEmbedding}>
                <Field
                  label="Embedding provider"
                  hint={config?.embedding_provider_env ? "Set by JIT_EMBEDDING_PROVIDER in the environment." : undefined}
                >
                  <Select
                    value={embeddingProvider}
                    disabled={Boolean(config?.embedding_provider_env)}
                    onValueChange={(value) => setEmbeddingProvider(value as "local" | "openai-compatible")}
                    options={[
                      { value: "local", label: "Built-in local model" },
                      { value: "openai-compatible", label: "OpenAI-compatible cloud or local endpoint" },
                    ]}
                  />
                </Field>

                {embeddingProvider === "local" ? (
                  <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_9rem]">
                    <Field
                      label="Local model"
                      hint={config?.embedding_model_env ? "Controlled by JIT_EMBEDDING_MODEL." : "Downloaded to the local model cache on first use."}
                    >
                      <Input
                        value={localEmbeddingModel}
                        disabled={Boolean(config?.embedding_model_env)}
                        onChange={(event) => setLocalEmbeddingModel(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Dimensions"
                      hint={config?.embedding_dim_env ? "Controlled by JIT_EMBEDDING_DIM." : undefined}
                    >
                      <Input
                        type="number"
                        min={1}
                        max={16384}
                        value={localEmbeddingDim}
                        disabled={Boolean(config?.embedding_dim_env)}
                        onChange={(event) => setLocalEmbeddingDim(event.target.value)}
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <Field
                      label="Embeddings API key"
                      hint={config?.embedding_key_env ? "Set by JIT_EMBEDDING_API_KEY in the environment." : `Stored in ${indexDir}/config.json with mode 600.`}
                    >
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={hasEmbeddingKey ? `saved · ${config?.embedding_api_key}` : "required for remote endpoints"}
                        value={embeddingKey}
                        disabled={Boolean(config?.embedding_key_env)}
                        onChange={(event) => setEmbeddingKey(event.target.value)}
                      />
                    </Field>
                    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_9rem]">
                      <Field
                        label="OpenAI-compatible API base"
                        hint={config?.embedding_base_env ? "Set by JIT_EMBEDDING_API_BASE." : "For example: https://api.openai.com/v1"}
                      >
                        <Input
                          value={embeddingBase}
                          spellCheck={false}
                          disabled={Boolean(config?.embedding_base_env)}
                          onChange={(event) => setEmbeddingBase(event.target.value)}
                        />
                      </Field>
                      <Field
                        label="Vector dimensions"
                        hint={config?.embedding_dim_env ? "Set by JIT_EMBEDDING_API_DIM." : "Must match the endpoint model output."}
                      >
                        <Input
                          type="number"
                          min={1}
                          max={16384}
                          value={embeddingDim}
                          disabled={Boolean(config?.embedding_dim_env)}
                          onChange={(event) => setEmbeddingDim(event.target.value)}
                        />
                      </Field>
                    </div>
                    <Field
                      label="Embedding model"
                      hint={config?.embedding_model_env ? "Set by JIT_EMBEDDING_API_MODEL." : undefined}
                    >
                      <Input
                        value={embeddingModel}
                        spellCheck={false}
                        disabled={Boolean(config?.embedding_model_env)}
                        onChange={(event) => setEmbeddingModel(event.target.value)}
                      />
                    </Field>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="primary" disabled={saving === "embedding"}>
                    {saving === "embedding" ? "Saving…" : "Save embedding settings"}
                  </Button>
                  {hasEmbeddingKey && !config?.embedding_key_env ? (
                    <Button
                      type="button"
                      disabled={embeddingProvider === "openai-compatible" && !localEmbeddingEndpoint}
                      onClick={() => void removeEmbeddingKey()}
                    >
                      Remove key
                    </Button>
                  ) : null}
                </div>
              </form>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-2 pt-4">
                <p className="max-w-sm text-xs leading-relaxed text-ink-3">
                  Rebuild all stored vectors after changing the provider, model, endpoint, or dimensions. This sends existing skill contents to the selected provider.
                </p>
                <Button
                  type="button"
                  disabled={saving !== "" || !ctx.stats?.total}
                  onClick={() => void reindexEmbeddings()}
                >
                  {saving === "embedding-reindex" ? "Rebuilding…" : "Rebuild vector index"}
                </Button>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Reranker (the decision layer)"
              hint="OpenAI-compatible Chat Completions"
              actions={
                <Badge tone={rerankState === "active" ? "accent" : "warn"}>
                  {rerankState}
                </Badge>
              }
            />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                Re-scores the top vector candidates with any OpenAI-compatible
                chat-completions endpoint — the model decides which skill wins.
                When an endpoint and model are configured, every lookup is
                reranked; until then JIT falls back to cosine and says so. For
                local endpoints such as Ollama, the API key can be blank.
              </p>
              <form className="space-y-5" onSubmit={saveRerank}>
                <Field label="Reranker API key" hint={keyHelp}>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      hasKey ? `saved · ${config?.rerank_api_key}` : "optional for local endpoints"
                    }
                    value={rerankKey}
                    disabled={Boolean(config?.rerank_key_env)}
                    onChange={(event) => setRerankKey(event.target.value)}
                  />
                </Field>
                <div className="grid gap-5 md:grid-cols-2">
                  <Field
                    label="OpenAI-compatible API base"
                    hint={config?.rerank_base_env ? "Set by JIT_RERANK_API_BASE in the environment." : undefined}
                  >
                    <Input
                      type="text"
                      spellCheck={false}
                      value={rerankBase}
                      disabled={Boolean(config?.rerank_base_env)}
                      onChange={(event) => setRerankBase(event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Reranker model"
                    hint={config?.rerank_model_env ? "Set by JIT_RERANK_MODEL in the environment." : undefined}
                  >
                    <Input
                      type="text"
                      spellCheck={false}
                      value={rerankModel}
                      disabled={Boolean(config?.rerank_model_env)}
                      onChange={(event) => setRerankModel(event.target.value)}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    setRerankBase("https://api.tokenfactory.nebius.com/v1/");
                    setRerankModel("nvidia/Nemotron-3_5-Lightning");
                    ctx.toast("Nebius + NVIDIA Nemotron preset selected. Add your API key and save.");
                  }}
                >
                  Use Nebius Token Factory + NVIDIA Nemotron 3.5 Lightning
                </Button>
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
                    disabled={!hasKey || Boolean(config?.rerank_key_env)}
                    onClick={() => void removeKey()}
                  >
                    Remove key
                  </Button>
                </div>
              </form>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Retrieval threshold" hint="recall vs precision" />
            <PanelBody className="space-y-5">
              <p className="text-xs leading-relaxed text-ink-3">
                JIT returns a match only when the score clears this bar. Lower it
                to catch more (more false positives), raise it to return only
                confident matches. Weigh the effect against the Search view.
              </p>
              <form className="space-y-5" onSubmit={saveThreshold}>
                <Field
                  label="Confidence threshold"
                  hint="Rerank scores and cosine similarity are 0–1. Default 0.6."
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
