import { useEffect, useState } from "react";

import { fmt, summary } from "../format";
import { useJit } from "../state/store";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { Stat } from "../ui/Display";
import { Checkbox, Field, Input, ToggleRow } from "../ui/Field";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";

/** Move skills across the local/JIT boundary, in either direction. */
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
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="transfer-title"
      className="w-[min(40rem,calc(100vw-2rem))]"
    >
      <DialogHead
        kicker="Transfer"
        title={<span id="transfer-title">Move skills between local and JIT.</span>}
        onClose={onClose}
      />
      <DialogBody className="space-y-5">
        <p className="text-sm leading-relaxed text-ink-2">
          Copy a local folder into JIT's own storage, index files where they
          live, or export JIT entries back to a local skills folder.
        </p>

        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next === "out" ? "out" : "in")}
          className="space-y-5"
        >
          <TabList label="Transfer direction">
            <Tab value="in">Into JIT</Tab>
            <Tab value="out">Out of JIT</Tab>
          </TabList>

          <div className="flex items-center gap-6 rounded-xl border border-line bg-inset/50 px-5 py-4">
            <Stat label="Local" value={fmt(local)} hint="indexed in place" />
            <span aria-hidden="true" className="shrink-0 text-ink-3">
              {tab === "in" ? "→" : "←"}
            </span>
            <Stat label="JIT" value={fmt(jit)} hint="owned copies" />
          </div>

          <TabPanel value="in" className="space-y-4">
            <Field
              label="Source path optional"
              hint="A skill file or a folder. Empty scans the usual local skill folders."
            >
              <Input
                type="text"
                className="num"
                placeholder="Leave empty for the usual skill folders"
                spellCheck={false}
                autoComplete="off"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
            <ToggleRow
              label={`Copy into ${ctx.config?.index_dir || "~/.jit"}/skills`}
              hint="Checked: JIT owns the copy. Unchecked: JIT indexes the file where it lives."
              checked={copy}
              onCheckedChange={setCopy}
            />
            <ToggleRow
              label="Overwrite existing JIT copies"
              checked={overwrite}
              onCheckedChange={setOverwrite}
            />
          </TabPanel>

          <TabPanel value="out" className="space-y-4">
            {ctx.skills.length === 0 ? (
              <p className="text-sm text-ink-3">
                No skills indexed yet. Import one first.
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
                {ctx.skills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer items-start gap-3 border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-raised/40"
                  >
                    <Checkbox
                      className="mt-0.5"
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
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm text-ink">
                        <span className="truncate">{skill.name}</span>
                        <Badge tone={skill.managed ? "accent" : "neutral"}>
                          {skill.managed ? "JIT copy" : "Local file"}
                        </Badge>
                      </span>
                      <span
                        className="num mt-1 block truncate text-[11px] text-ink-3"
                        title={`${skill.id} · ${skill.path || "no path"}`}
                      >
                        {skill.id} · {skill.path || "no path"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <Field
              label="Destination folder"
              hint="Each skill is written to <destination>/<id>/SKILL.md."
            >
              <Input
                type="text"
                className="num"
                value={dest}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setDest(event.target.value)}
              />
            </Field>
            <ToggleRow
              label="Overwrite existing files"
              checked={exportOverwrite}
              onCheckedChange={setExportOverwrite}
            />
          </TabPanel>
        </Tabs>

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
          variant="primary"
          disabled={busy}
          onClick={() => void (tab === "in" ? transferIn() : transferOut())}
        >
          {tab === "in"
            ? busy
              ? "Working…"
              : "Import"
            : busy
              ? "Exporting…"
              : "Export selected"}
        </Button>
      </DialogFoot>
    </Dialog>
  );
}
