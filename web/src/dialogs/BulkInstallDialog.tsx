import { useEffect, useState } from "react";

import { fmt } from "../format";
import { useJit } from "../state/store";
import type {
  InspectResult,
  InstallResult,
  MarketplaceItem,
  ScanFinding,
} from "../types";
import { StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";
import { ToggleRow } from "../ui/Field";
import { sourceHint } from "./MarketDialog";

type Phase = "review" | "install" | "done";

type RowState =
  | "pending"
  | "ready"
  | "flagged"
  | "blocked"
  | "unavailable"
  | "working"
  | "done"
  | "failed";

interface Row {
  /** The id to install with; review may resolve it to the real skill id. */
  id: string;
  item: MarketplaceItem;
  state: RowState;
  findings: ScanFinding[];
  detail: string;
}

/** Run `fn` over `items` with a small ceiling on how many are in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

const DOT: Record<RowState, "neutral" | "accent" | "ok" | "warn" | "bad"> = {
  pending: "neutral",
  ready: "ok",
  flagged: "warn",
  blocked: "bad",
  unavailable: "bad",
  working: "accent",
  done: "ok",
  failed: "bad",
};

const LABEL: Record<RowState, string> = {
  pending: "checking",
  ready: "ready",
  flagged: "needs review",
  blocked: "blocked",
  unavailable: "unavailable",
  working: "installing",
  done: "installed",
  failed: "failed",
};

/**
 * Install many directory entries in one pass. Every entry is reviewed the same
 * way a single install is — nothing is written until the scan comes back — and
 * entries that need acknowledgement are held back until the user says so. The
 * installs then run one at a time so progress is visible and the `skills` CLI is
 * never asked to do more than one thing at once.
 */
export function BulkInstallDialog({
  items,
  onClose,
}: {
  items: MarketplaceItem[] | null;
  onClose: () => void;
}) {
  const ctx = useJit();
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<Phase>("review");
  const [reviewed, setReviewed] = useState(0);
  const [ack, setAck] = useState(false);
  const [progress, setProgress] = useState(0);
  // The size of the run, frozen when it starts: the rows move out of `ready` as
  // they finish, so the live target list cannot be used to report on it.
  const [planned, setPlanned] = useState(0);

  useEffect(() => {
    if (!items || items.length === 0) return;
    let cancelled = false;
    let done = 0;
    setPhase("review");
    setReviewed(0);
    setAck(false);
    setProgress(0);
    setRows(
      items.map((item) => ({
        id: item.id,
        item,
        state: "pending" as RowState,
        findings: [],
        detail: "",
      })),
    );

    void mapLimit(items, 4, async (item) => {
      let outcome: {
        item: MarketplaceItem;
        result: InspectResult | null;
        error: string;
      };
      try {
        const result = await ctx.api<InspectResult>("/api/marketplace/inspect", {
          method: "POST",
          body: JSON.stringify({ id: item.id, ...sourceHint(item) }),
        });
        outcome = { item, result, error: "" };
      } catch (error) {
        outcome = {
          item,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      done += 1;
      if (!cancelled) setReviewed(done);
      return outcome;
    }).then((outcomes) => {
      if (cancelled) return;
      setRows(
        outcomes.map(({ item, result, error }) => {
          if (!result) {
            return {
              id: item.id,
              item,
              state: "unavailable" as RowState,
              findings: [],
              detail: error || "could not be reviewed",
            };
          }
          const blocked = result.checksum_required && !result.checksum_present;
          return {
            id: result.id || item.id,
            item,
            state: blocked
              ? ("blocked" as RowState)
              : result.report.requires_ack
                ? ("flagged" as RowState)
                : ("ready" as RowState),
            findings: result.report.findings || [],
            detail: blocked ? "no sha256 checksum to pin it to" : "",
          };
        }),
      );
      setReviewed(outcomes.length);
    });

    return () => {
      cancelled = true;
    };
  }, [items]);

  if (!items || items.length === 0) return null;

  const count = items.length;
  const byState = (state: RowState) => rows.filter((row) => row.state === state);
  const ready = byState("ready");
  const flagged = byState("flagged");
  const blocked = [...byState("blocked"), ...byState("unavailable")];
  const reviewing = rows.some((row) => row.state === "pending");
  // Flagged entries only join the run once the user has acknowledged them.
  const targets = ack ? [...ready, ...flagged] : ready;
  const skipped = ack ? blocked.length : flagged.length + blocked.length;
  const installing = phase === "install";
  const summary = [
    `${ready.length} ready`,
    flagged.length ? `${flagged.length} flagged` : "",
    blocked.length ? `${blocked.length} blocked` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const install = async () => {
    if (installing || targets.length === 0) return;
    setPhase("install");
    setProgress(0);
    setPlanned(targets.length);
    let ok = 0;
    let failed = 0;
    const mark = (id: string, state: RowState, detail = "") =>
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, state, detail } : row)),
      );

    for (const row of targets) {
      mark(row.id, "working");
      try {
        const result = await ctx.api<InstallResult>("/api/marketplace/install", {
          method: "POST",
          body: JSON.stringify({
            id: row.id,
            inputs: {},
            acknowledge: ack,
            ...sourceHint(row.item),
          }),
        });
        const problem = result.error || (result.errors || [])[0] || "";
        if (result.connected === false || problem) {
          failed += 1;
          mark(row.id, "failed", problem || "install failed");
        } else {
          ok += 1;
          mark(row.id, "done");
        }
      } catch (error) {
        failed += 1;
        mark(row.id, "failed", error instanceof Error ? error.message : String(error));
      }
      setProgress((current) => current + 1);
    }

    setPhase("done");
    const parts = [`Installed ${ok}`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    ctx.toast(parts.join(" · "), failed || !ok ? "error" : "ok");
    await ctx.refreshAll();
    await ctx.loadMarketplace(true);
  };

  return (
    <Dialog
      open
      // Keep the dialog put while the queue is running: closing it would leave
      // installs half-done with nowhere to report them.
      onClose={installing ? () => {} : onClose}
      labelledBy="bulk-install-title"
      className="w-[min(44rem,calc(100vw-2rem))]"
    >
      <DialogHead
        kicker="Bulk install"
        title={
          <span id="bulk-install-title">
            Install {fmt(count)} {count === 1 ? "entry" : "entries"}
          </span>
        }
        onClose={installing ? () => {} : onClose}
      >
        {phase === "done"
          ? `Installed ${fmt(progress)} of ${fmt(planned)}${
              skipped ? ` · ${fmt(skipped)} left alone` : ""
            }.`
          : reviewing
            ? `Reviewing ${fmt(reviewed)} of ${fmt(count)}…`
            : summary}
      </DialogHead>

      <DialogBody className="space-y-4">
        <ul className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <StatusDot
                className="mt-1.5"
                tone={DOT[row.state]}
                pulse={row.state === "working"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink" title={row.item.name}>
                  {row.item.name}
                </div>
                <div className="num truncate text-[11px] text-ink-3">
                  {row.item.origin || row.id}
                </div>
                {row.findings.length ? (
                  <ul className="mt-1 space-y-0.5">
                    {row.findings.map((finding, index) => (
                      <li
                        key={`${finding.rule}-${index}`}
                        className="text-[11px] leading-relaxed text-ink-3"
                      >
                        <span className="num text-ink-2">{finding.rule}</span> —{" "}
                        {finding.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {row.detail ? (
                  <p
                    className={cx(
                      "mt-0.5 text-[11px]",
                      row.state === "failed" ? "text-bad" : "text-ink-3",
                    )}
                  >
                    {row.detail}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 pt-0.5 text-[11px] text-ink-3">
                {LABEL[row.state]}
              </span>
            </li>
          ))}
        </ul>

        {phase === "review" && flagged.length ? (
          <ToggleRow
            label={`Install the ${fmt(flagged.length)} flagged ${
              flagged.length === 1 ? "entry" : "entries"
            } too. I have read the findings above.`}
            checked={ack}
            onCheckedChange={setAck}
          />
        ) : null}
      </DialogBody>

      <DialogFoot>
        <Button variant="ghost" onClick={installing ? undefined : onClose} disabled={installing}>
          {phase === "done" ? "Close" : "Cancel"}
        </Button>
        {phase !== "done" ? (
          <Button
            variant="primary"
            onClick={() => void install()}
            disabled={installing || reviewing || targets.length === 0}
          >
            {installing
              ? `Installing ${fmt(progress)} of ${fmt(planned)}…`
              : reviewing
                ? "Install"
                : `Install ${fmt(targets.length)}`}
          </Button>
        ) : null}
      </DialogFoot>
    </Dialog>
  );
}
