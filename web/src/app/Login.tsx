import { useState, type FormEvent } from "react";

import { Button } from "../ui/Button";
import { Wordmark } from "../ui/Display";
import { Field, Input } from "../ui/Field";

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
    <div className="grid min-h-full place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="text-sm" />

        <h1 className="display mt-7 text-3xl text-ink">Access key</h1>
        <p className="mt-3.5 text-sm leading-relaxed text-ink-2">
          This dashboard is gated. Enter the key the server was started with.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <Field label="Key" error={error || undefined}>
            <Input
              type="password"
              value={key}
              autoFocus
              autoComplete="off"
              placeholder="••••••••"
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={busy || !key.trim()}
          >
            {busy ? "Checking…" : "Unlock"}
          </Button>
        </form>

        <p className="num mt-8 text-[11px] text-ink-3">
          JIT · just-in-time context
        </p>
      </div>
    </div>
  );
}
