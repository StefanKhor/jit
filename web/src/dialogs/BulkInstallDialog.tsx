import { useEffect, useRef, useState } from "react";

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

type Phase = "choose" | "review" | "install" | "done";

type RowState =
  | "queued"
  | "pending"
  | "ready"
  | "flagged"
  | "blocked"
  | "unavailable"
  | "working"
  | "done"
  | "cancelled"
  | "failed";

interface Row {
  /** The id to install with; review may resolve it to the real skill id. */
  id: string;
  item: MarketplaceItem;
  state: RowState;
  findings: ScanFinding[];
  detail: string;
  startedAt?: number;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function installErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const acknowledgement = message.match(
    /^this entry needs explicit acknowledgement before install(?::\s*(.*))?$/i,
  );
  if (acknowledgement) {
    const reason = acknowledgement[1]?.trim();
    return [
      "Security review requires acknowledgement; this skill was not installed.",
      reason || "Choose Review all first to see why, or explicitly allow it in Quick install.",
    ].join(" ");
  }
  const timeout = message.match(/scan timed out after (\d+)s/i);
  if (timeout) {
    return `Security scan timed out after ${timeout[1]}s. This skill was not installed. You can retry it or explicitly acknowledge an unscanned install.`;
  }
  if (/no matching skill found|no longer provides|does not provide/i.test(message)) {
    return `This skill is no longer available from its listed source. It was not installed. (${message})`;
  }
  return `Install failed. ${message}`;
}

/** Run `fn` over `items` with a small ceiling on how many are in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (shouldStop()) return;
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
  queued: "neutral",
  pending: "neutral",
  ready: "ok",
  flagged: "warn",
  blocked: "bad",
  unavailable: "bad",
  working: "accent",
  done: "ok",
  cancelled: "neutral",
  failed: "bad",
};

const LABEL: Record<RowState, string> = {
  queued: "queued",
  pending: "checking",
  ready: "ready",
  flagged: "needs review",
  blocked: "blocked",
  unavailable: "unavailable",
  working: "installing",
  done: "installed",
  cancelled: "not started",
  failed: "failed",
};

/**
 * Install many directory entries in one pass. Users can review the full batch
 * first or install while each skill is scanned. Work is bounded to four active
 * requests, and a running batch can stop after its in-flight installs finish.
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
  const [phase, setPhase] = useState<Phase>("choose");
  const [reviewRequested, setReviewRequested] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [ack, setAck] = useState(false);
  const [forceOverride, setForceOverride] = useState(false);
  const [quickAck, setQuickAck] = useState(false);
  const [quickForce, setQuickForce] = useState(false);
  const [progress, setProgress] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  // The size of the run, frozen when it starts: the rows move out of `ready` as
  // they finish, so the live target list cannot be used to report on it.
  const [planned, setPlanned] = useState(0);

  useEffect(() => {
    if (phase !== "review" && phase !== "install") return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (items) return;
    setPhase("choose");
    setReviewRequested(false);
    setAck(false);
    setForceOverride(false);
    setQuickAck(false);
    setQuickForce(false);
    stopRequestedRef.current = false;
    setStopRequested(false);
  }, [items]);

  useEffect(() => {
    if (!items || items.length === 0 || !reviewRequested) return;
    let cancelled = false;
    let done = 0;
    setPhase("review");
    setReviewed(0);
    setAck(false);
    setForceOverride(false);
    setProgress(0);
    setRows(
      items.map((item) => ({
        id: item.id,
        item,
        state: "queued" as RowState,
        findings: [],
        detail: "",
      })),
    );

    void mapLimit(items, 4, async (item) => {
      const startedAt = Date.now();
      setRows((current) =>
        current.map((row) =>
          row.id === item.id ? { ...row, state: "pending", startedAt } : row,
        ),
      );
      let result: InspectResult | null = null;
      let error = "";
      try {
        result = await ctx.api<InspectResult>("/api/marketplace/inspect", {
          method: "POST",
          body: JSON.stringify({ id: item.id, ...sourceHint(item) }),
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      let row: Row;
      if (!result) {
        row = {
          id: item.id,
          item,
          state: "unavailable",
          findings: [],
          detail: error || "could not be reviewed",
        };
      } else {
        const blocked = result.checksum_required && !result.checksum_present;
        const doNotInstall = result.report.gate === "block";
        const detail = blocked
          ? "no sha256 checksum to pin it to"
            : doNotInstall
            ? `SkillSpector: ${result.report.recommendation || "DO_NOT_INSTALL"}${
                typeof result.report.risk_score === "number"
                  ? ` · risk ${result.report.risk_score}/100`
                  : ""
              }`
              : result.report.scanner_available === false
                ? `not scanned — needs acknowledgement${
                    result.report.note ? ` · ${result.report.note}` : ""
                  }`
                : "";
        row = {
          id: result.id || item.id,
          item,
          state:
            blocked || doNotInstall
              ? "blocked"
              : result.report.requires_ack
                ? "flagged"
                : "ready",
          findings: result.report.findings || [],
          detail,
        };
      }

      done += 1;
      if (!cancelled) {
        setReviewed(done);
        setRows((current) =>
          current.map((existing) => (existing.id === row.id ? row : existing)),
        );
      }
      return row;
    }).then(() => {
      if (cancelled) return;
      setReviewed(items.length);
    });

    return () => {
      cancelled = true;
    };
  }, [items, reviewRequested]);

  useEffect(() => {
    if (!items || items.length === 0 || reviewRequested) return;
    setRows(
      items.map((item) => ({
        id: item.id,
        item,
        state: "queued" as RowState,
        findings: [],
        detail: "",
      })),
    );
  }, [items, reviewRequested]);

  if (!items || items.length === 0) return null;

  const count = items.length;
  const byState = (state: RowState) => rows.filter((row) => row.state === state);
  const ready = byState("ready");
  const flagged = byState("flagged");
  const blocked = [...byState("blocked"), ...byState("unavailable")];
  const queuedCount = rows.filter((row) => row.state === "queued").length;
  const activeCount = rows.filter(
    (row) => row.state === "pending" || row.state === "working",
  ).length;
  const reviewing = phase === "review" && (queuedCount > 0 || activeCount > 0);
  // Flagged entries only join the run once the user has acknowledged them.
  const targets = forceOverride
    ? [...ready, ...flagged, ...blocked]
    : ack
      ? [...ready, ...flagged]
      : ready;
  const skipped = forceOverride
    ? 0
    : ack
      ? blocked.length
      : flagged.length + blocked.length;
  const installing = phase === "install";
  const summary = [
    `${ready.length} ready`,
    flagged.length ? `${flagged.length} flagged` : "",
    blocked.length ? `${blocked.length} blocked` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const runInstall = async (
    installTargets: Row[],
    acknowledge: boolean,
    skippedCount = 0,
    force = false,
  ) => {
    if (installing || installTargets.length === 0) return;
    setPhase("install");
    setProgress(0);
    setPlanned(installTargets.length);
    stopRequestedRef.current = false;
    setStopRequested(false);
    let ok = 0;
    let failed = 0;
    const started = new Set<string>();
    const mark = (
      id: string,
      state: RowState,
      detail = "",
      findings?: ScanFinding[],
    ) =>
      setRows((current) =>
        current.map((row) =>
          row.id === id
            ? {
                ...row,
                state,
                detail,
                startedAt: state === "working" ? Date.now() : undefined,
                ...(findings ? { findings } : {}),
              }
            : row,
        ),
      );

    await mapLimit(installTargets, 4, async (row) => {
      if (stopRequestedRef.current) return;
      started.add(row.id);
      mark(row.id, "working");
      try {
        const result = await ctx.api<InstallResult>("/api/marketplace/install", {
          method: "POST",
          body: JSON.stringify({
            id: row.id,
            inputs: {},
            acknowledge,
            force,
            ...sourceHint(row.item),
          }),
        });
        const problem = result.error || (result.errors || [])[0] || "";
        if (result.connected === false || problem) {
          failed += 1;
          mark(row.id, "failed", problem || "install failed");
        } else {
          ok += 1;
          const findings = result.warnings || [];
          mark(
            row.id,
            "done",
            findings.length ? `Installed with ${findings.length} scan finding(s).` : "",
            findings,
          );
        }
      } catch (error) {
        failed += 1;
        mark(row.id, "failed", installErrorMessage(error));
      }
      setProgress((current) => current + 1);
    }, () => stopRequestedRef.current);

    const cancelled = stopRequestedRef.current;
    if (cancelled) {
      const targetIds = new Set(installTargets.map((row) => row.id));
      setRows((current) =>
        current.map((row) =>
          targetIds.has(row.id) && !started.has(row.id)
            ? { ...row, state: "cancelled", detail: "Stopped before this skill started." }
            : row,
        ),
      );
    }

    setPhase("done");
    const parts = [`Installed ${ok}`];
    if (skippedCount) parts.push(`${skippedCount} skipped`);
    if (failed) parts.push(`${failed} failed`);
    if (cancelled) parts.push("stopped by you");
    ctx.toast(parts.join(" · "), failed || !ok ? "error" : "ok");
    await ctx.refreshAll();
    await ctx.loadMarketplace(true);
  };

  const installReviewed = () =>
    void runInstall(targets, ack || forceOverride, skipped, forceOverride);

  const installWithoutReview = () => {
    const installTargets = items.map((item) => ({
      id: item.id,
      item,
      state: "queued" as RowState,
      findings: [],
      detail: "",
    }));
    void runInstall(installTargets, quickAck || quickForce, 0, quickForce);
  };

  const stopAfterCurrent = () => {
    stopRequestedRef.current = true;
    setStopRequested(true);
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
          ? `${stopRequested ? "Stopped after" : "Installed"} ${fmt(progress)} of ${fmt(planned)}${
              skipped ? ` · ${fmt(skipped)} left alone` : ""
            }.`
          : phase === "choose"
            ? `${fmt(count)} selected. Choose whether to review all first or scan as each one installs.`
          : phase === "install"
              ? stopRequested
                ? `Stopping after active installs · ${fmt(progress)} of ${fmt(planned)} complete…`
                : `Installing · ${fmt(progress)} of ${fmt(planned)} complete · ${activeCount} active · ${queuedCount} queued`
              : reviewing
            ? `Reviewing · ${fmt(reviewed)} of ${fmt(count)} complete · ${activeCount} active · ${queuedCount} queued`
            : summary}
      </DialogHead>

      <DialogBody className="space-y-4">
        {phase === "review" || phase === "install" ? (
          <div className="space-y-2 rounded-xl border border-line bg-inset/40 p-3">
            <div
              role="progressbar"
              aria-label={phase === "review" ? "Review progress" : "Install progress"}
              aria-valuemin={0}
              aria-valuemax={phase === "review" ? count : planned}
              aria-valuenow={phase === "review" ? reviewed : progress}
              className="h-2 overflow-hidden rounded-full bg-raised"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{
                  width: `${Math.round(
                    ((phase === "review" ? reviewed / count : progress / planned) || 0) * 100,
                  )}%`,
                }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-ink-3">
              <span>
                {phase === "review" ? `${reviewed} of ${count} reviewed` : `${progress} of ${planned} installed`}
              </span>
              <span>
                {activeCount} active · {queuedCount} queued
              </span>
            </div>
          </div>
        ) : null}
        {phase === "choose" ? (
          <div className="space-y-3 rounded-xl border border-line bg-inset/40 p-4">
            <p className="text-xs leading-relaxed text-ink-2">
              Quick install skips the all-at-once review. JIT still scans each
              skill immediately before installing it; flagged or unscanned
              entries remain gated unless you explicitly acknowledge them.
            </p>
            <p className="text-[11px] leading-relaxed text-ink-3">
              Source fetches and scans can take several minutes. During a run,
              each active row shows its elapsed time and the batch can be stopped.
            </p>
            <p className="text-xs leading-relaxed text-ink-3">
              Installed skills are copied only into{" "}
              <code className="num rounded border border-line-2 bg-raised px-1 py-0.5 text-[11px] text-ink-2">
                {ctx.config?.index_dir || "~/.jit"}/skills
              </code>
              . Source staging stays inside the JIT cache; it does not install to
              your project’s or global <code className="num">.agents/skills</code>.
            </p>
            <ToggleRow
              label="Allow entries when the scan is unavailable or returns CAUTION. DO_NOT_INSTALL results remain blocked."
              checked={quickAck}
              onCheckedChange={setQuickAck}
            />
            <ToggleRow
              label="Force-install entries SkillSpector blocks."
              hint="Overrides DO_NOT_INSTALL and unscanned results for this batch. Use only if you accept the unverified risk."
              checked={quickForce}
              onCheckedChange={setQuickForce}
            />
          </div>
        ) : null}

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
                {row.startedAt && (row.state === "pending" || row.state === "working")
                  ? `${LABEL[row.state]} · ${duration(clock - row.startedAt)}`
                  : LABEL[row.state]}
              </span>
            </li>
          ))}
        </ul>

        {phase === "review" && flagged.length && !forceOverride ? (
          <ToggleRow
            label={`Install the ${fmt(flagged.length)} flagged ${
              flagged.length === 1 ? "entry" : "entries"
            } too. I have read the findings above.`}
            checked={ack}
            onCheckedChange={setAck}
          />
        ) : null}
        {phase === "review" && blocked.length ? (
          <ToggleRow
            label={`Force-install ${fmt(blocked.length)} blocked or unscanned ${blocked.length === 1 ? "entry" : "entries"}.`}
            hint="This overrides SkillSpector’s DO_NOT_INSTALL block or a missing scan report for these entries. Only continue if you accept that risk."
            checked={forceOverride}
            onCheckedChange={(enabled) => {
              setForceOverride(enabled);
              if (enabled) setAck(false);
            }}
          />
        ) : null}
      </DialogBody>

      <DialogFoot>
        {phase === "choose" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setReviewRequested(true);
                setPhase("review");
              }}
            >
              Review all first
            </Button>
            <Button variant="primary" onClick={installWithoutReview}>
              Install without pre-review
            </Button>
          </>
        ) : phase === "done" ? (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        ) : phase === "install" ? (
          <Button
            variant="ghost"
            onClick={stopAfterCurrent}
            disabled={stopRequested}
          >
            {stopRequested ? "Stopping…" : "Stop after active skills"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={installing ? undefined : onClose} disabled={installing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={installReviewed}
              disabled={installing || reviewing || targets.length === 0}
            >
              {installing
                ? `Installing ${fmt(progress)} of ${fmt(planned)}…`
                : reviewing
                  ? "Reviewing…"
                  : `Install ${fmt(targets.length)}`}
            </Button>
          </>
        )}
      </DialogFoot>
    </Dialog>
  );
}
