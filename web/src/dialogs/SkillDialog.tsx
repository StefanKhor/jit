import { fmt } from "../format";
import type { SkillDetail } from "../types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";

/**
 * Read-only view of one indexed skill or MCP tool: what it is, when it applies,
 * how it is addressed, and its full body (or tool parameters and schema).
 */
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
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="skill-dialog-title"
      className="w-[min(38rem,calc(100vw-2rem))]"
    >
      <DialogHead
        kicker={detail?.kind === "tool" ? "MCP tool" : "Skill"}
        title={<span id="skill-dialog-title">{detail?.name || "—"}</span>}
        onClose={onClose}
      />
      <DialogBody className="space-y-6">
        {detail ? (
          <>
            {detail.description ? (
              <p className="text-sm leading-relaxed text-ink-2">
                {detail.description}
              </p>
            ) : null}

            {detail.when_to_use ? (
              <section className="space-y-2">
                <h3 className="kicker">When to use</h3>
                <p className="text-sm leading-relaxed text-ink-2">
                  {detail.when_to_use}
                </p>
              </section>
            ) : null}

            {detail.categories?.length ? (
              <section className="space-y-2">
                <h3 className="kicker">Categories</h3>
                <div className="flex flex-wrap gap-1.5">
                  {detail.categories.map((category) => (
                    <Badge key={category}>{category}</Badge>
                  ))}
                </div>
              </section>
            ) : null}

            {detail.aliases?.length ? (
              <section className="space-y-2">
                <h3 className="kicker">Aliases</h3>
                <p className="num text-xs leading-relaxed text-ink-2">
                  {detail.aliases.join(" · ")}
                </p>
              </section>
            ) : null}

            {detail.kind === "tool" &&
            (detail.params?.length || detail.schema) ? (
              <section className="space-y-4">
                <h3 className="kicker">Parameters</h3>
                {detail.params?.length ? (
                  <ul className="space-y-1.5">
                    {detail.params.map((param) => (
                      <li key={param} className="flex items-center gap-2">
                        <span className="num text-xs text-ink">{param}</span>
                        {detail.required?.includes(param) ? (
                          <Badge tone="accent">required</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {detail.schema ? (
                  <pre className="overflow-x-auto rounded-xl border border-line bg-inset p-3.5 font-mono text-xs leading-relaxed text-ink-2">
                    {JSON.stringify(detail.schema, null, 2)}
                  </pre>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="kicker">Body</h3>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-inset p-3.5 font-mono text-xs leading-relaxed text-ink-2">
                {detail.body || "(empty)"}
              </pre>
            </section>

            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4 text-[11px] text-ink-3">
              <span
                className="num min-w-0 max-w-full truncate"
                title={detail.path || ""}
              >
                {detail.path || "—"}
              </span>
              <span className="num shrink-0">{fmt(detail.tokens)} tokens</span>
            </div>
          </>
        ) : (
          <p className="num text-sm text-ink-3">—</p>
        )}
      </DialogBody>
      <DialogFoot>
        <Button onClick={onClose}>Close</Button>
      </DialogFoot>
    </Dialog>
  );
}
