import { useState, type FormEvent } from "react";

import { Brand } from "./ui";

export function Login({
  onLogin,
  initialError = "",
}: {
  onLogin: (key: string) => Promise<void>;
  initialError?: string;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(value);
      setKey("");
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== "Unauthorized"
          ? caught.message
          : "That key was rejected.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-left">
        <div className="login-brand">
          <Brand size={24} />
          <span>JIT</span>
        </div>
        <div>
          <h1 className="login-title">
            Just-in-time
            <br />
            <em>context.</em>
          </h1>
          <p className="login-sub">
            A local index for agent skills and MCP tools. One entry at a time,
            on demand.
          </p>
        </div>
        <div className="login-meta">local · MIT</div>
      </div>
      <div className="login-right">
        <form className="login-form" onSubmit={submit} noValidate>
          <div className="kicker">Restricted</div>
          <h2 className="login-h2">Enter the dashboard key.</h2>
          <p className="login-copy">
            This instance was started with an API key. It is checked locally
            and never sent anywhere else.
          </p>
          <label className="field">
            <span className="field-label">API key</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <div className="login-row">
            <span className="login-error" role="alert">
              {error}
            </span>
            <button className="btn btn-solid" type="submit" disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
      <div className="login-foot">jit dashboard</div>
    </div>
  );
}
