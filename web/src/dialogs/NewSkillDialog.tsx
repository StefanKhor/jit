import { useEffect, useState, type FormEvent } from "react";

import { useJit } from "../state/store";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { Field, Input, Textarea } from "../ui/Field";

interface CreateResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Write a brand-new skill into JIT's managed folder and index it. */
export function NewSkillDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setBody("");
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
    if (!body.trim()) {
      setError("The skill needs a body — the procedure the agent will read.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await ctx.api<CreateResult>("/api/skills/create", {
        method: "POST",
        body: JSON.stringify({
          name: safeName,
          description: description.trim(),
          body,
        }),
      });
      onClose();
      ctx.toast(`Created ${safeName}.`);
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
      labelledBy="skill-new-title"
      className="w-[min(44rem,calc(100vw-2rem))]"
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogHead
          kicker="New skill"
          title={<span id="skill-new-title">Write a skill from scratch.</span>}
          onClose={onClose}
        />
        <DialogBody className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-2">
            JIT writes the file into{" "}
            <span className="num">
              {`${ctx.config?.index_dir || "~/.jit"}/skills/<name>/SKILL.md`}
            </span>{" "}
            and indexes it. The file stays the source of truth — edit it on
            disk anytime.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Simple folder name, e.g. deploy-node.">
              <Input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="deploy-node"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Description"
              hint="One line on when to use it — this is what search matches."
            >
              <Input
                type="text"
                autoComplete="off"
                placeholder="Deploy a node app to Azure App Service"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Body (markdown)"
            hint="The procedure itself: steps, commands, gotchas."
          >
            <Textarea
              spellCheck={false}
              className="min-h-56"
              placeholder={"1. Install the CLI…\n2. …"}
              value={body}
              onChange={(event) => setBody(event.target.value)}
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
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create skill"}
          </Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
