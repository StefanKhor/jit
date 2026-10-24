import { useEffect, useRef, useState, type FormEvent } from "react";

import { setAuthKey } from "../api";
import { useJit } from "../context";
import { fmt, summary } from "../format";
import type { IndexExport } from "../types";

export function Settings() {
  const ctx = useJit();
  const config = ctx.config;
  const [nebiusKey, setNebiusKey] = useState("");
  const [base, setBase] = useState("");
  const [nano, setNano] = useState("");
  const [ultra, setUltra] = useState("");
  const [rerank, setRerank] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!config) return;
    setBase(config.nebius_api_base || "");
    setNano(config.nemotron_nano_model || "");
    setUltra(config.nemotron_ultra_model || "");
    setRerank(Boolean(config.rerank_enabled));
  }, [config]);

  const saveRerank = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("rerank");
    try {
      const updates: Record<string, unknown> = {
        nebius_api_base: base.trim(),
        nemotron_nano_model: nano.trim(),
        nemotron_ultra_model: ultra.trim(),
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

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="kicker">06 — Settings</div>
          <h2 className="section-title">Configuration.</h2>
        </div>
      </div>

      <div className="columns">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h2>Reranking</h2>
              <span className="panel-note">Nebius Token Factory</span>
            </div>
            <p className="panel-copy">
              Nemotron Nano re-scores the top candidates before JIT returns one.
              Optional — local hybrid search works without it.
            </p>
            <form onSubmit={saveRerank}>
              <label className="field">
                <span className="field-label">API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={hasKey ? `saved · ${config?.nebius_api_key}` : "not set"}
                  value={nebiusKey}
                  disabled={Boolean(config?.nebius_key_env)}
                  onChange={(event) => setNebiusKey(event.target.value)}
                />
                <span className="field-help">{keyHelp}</span>
              </label>
              <label className="field">
                <span className="field-label">API base</span>
                <input
                  type="text"
                  spellCheck={false}
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                />
              </label>
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">Nano model</span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={nano}
                    onChange={(event) => setNano(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Ultra model</span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={ultra}
                    onChange={(event) => setUltra(event.target.value)}
                  />
                </label>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={rerank}
                  onChange={(event) => setRerank(event.target.checked)}
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                <span>Enable reranking</span>
              </label>
              <div className="form-actions">
                <button
                  className="btn btn-solid"
                  type="submit"
                  disabled={saving === "rerank"}
                >
                  {saving === "rerank" ? "Saving…" : "Save"}
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={!hasKey || Boolean(config?.nebius_key_env)}
                  onClick={() => void removeKey()}
                >
                  Remove key
                </button>
                <span className="form-note">
                  {!hasKey
                    ? "Add a key to enable reranking."
                    : config?.rerank_enabled
                      ? "Active."
                      : "Key saved, reranking off."}
                </span>
              </div>
            </form>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Access</h2>
              <span className="panel-note">{authOn ? "enabled" : "off"}</span>
            </div>
            <p className="panel-copy">
              Require a key before the dashboard and API can be used. Useful
              when JIT listens on a network interface.
            </p>
            <form onSubmit={saveAuth}>
              <label className="field">
                <span className="field-label">Dashboard key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={authOn ? "•••• (set)" : "not set"}
                  value={apiKey}
                  disabled={Boolean(config?.auth_env)}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <span className="field-help">{authHelp}</span>
              </label>
              <div className="form-actions">
                <button
                  className="btn btn-solid"
                  type="submit"
                  disabled={saving === "auth" || Boolean(config?.auth_env)}
                >
                  {saving === "auth" ? "Saving…" : "Set key"}
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={!authOn || Boolean(config?.auth_env)}
                  onClick={() => void clearAuth()}
                >
                  Disable auth
                </button>
              </div>
            </form>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">
              <h2>Data</h2>
              <span className="panel-note">portable JSON</span>
            </div>
            <p className="panel-copy">
              Export the index with full skill bodies, or restore a previous
              export.
            </p>
            <div className="form-actions">
              <button className="btn" onClick={() => void exportData()}>
                Export
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()}>
                Import
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importData(file);
                  event.target.value = "";
                }}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Danger zone</h2>
            </div>
            <p className="panel-copy">
              Remove every item from the JIT index. This cannot be undone.
              JIT-owned skill files and your source files stay on disk.
            </p>
            <button className="btn btn-danger" onClick={() => void clearIndex()}>
              Clear index
            </button>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>About</h2>
            </div>
            <dl className="about">
              <div>
                <dt>Version</dt>
                <dd>v{ctx.health?.version || "1.0.0"}</dd>
              </div>
              <div>
                <dt>Index</dt>
                <dd title={indexDir}>{indexDir}</dd>
              </div>
              <div>
                <dt>Embeddings</dt>
                <dd>{config?.embedding_model || "local"}</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>MIT</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
