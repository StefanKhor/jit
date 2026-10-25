import { useEffect, useState } from "react";

import { summary } from "../format";
import { useJit } from "../state/store";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { Wordmark } from "../ui/Display";
import { ToggleRow } from "../ui/Field";

/** First-run configuration: optional local import and setup completion. */
export function SetupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setScan(false);
    }
  }, [open]);

  const save = async () => {
    await ctx.saveConfig({ complete_setup: true });
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

  const dismiss = () => {
    if (!busy) void finish(false);
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      labelledBy="setup-dialog-title"
      className="w-[min(38rem,calc(100vw-2rem))]"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void finish(false);
        }}
      >
        <DialogHead
          kicker="First run"
          title={<span id="setup-dialog-title">Welcome to JIT.</span>}
          onClose={dismiss}
        />
        <DialogBody className="space-y-5">
          <Wordmark className="text-sm" />
          <p className="text-sm leading-relaxed text-ink-2">
            JIT starts empty. Install from the marketplace, or import what you
            already use. Nothing is read from your client configs automatically.
          </p>
          <p className="text-xs leading-relaxed text-ink-3">
            Optional OpenAI-compatible reranking can be configured later in
            Settings.
          </p>
          <ToggleRow
            label="Index skills already on this machine optional"
            hint="Reads the usual skill folders once. Source files are not modified."
            checked={scan}
            onCheckedChange={setScan}
          />
        </DialogBody>
        <DialogFoot>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            Browse marketplace
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void finish(false)}
          >
            Skip for now
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Finish setup"}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
