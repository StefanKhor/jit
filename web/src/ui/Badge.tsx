import type { ReactNode } from "react";

import { cx } from "./cx";

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const TONE: Record<Tone, string> = {
  neutral: "border-line-2 bg-raised text-ink-2",
  accent: "border-accent/30 bg-accent/10 text-accent",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
};

/** A small status pill. */
export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10px] font-medium uppercase leading-4 tracking-[0.08em]",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Slot for the mono meta line (path, author, source) beside a title. */
export function Meta({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("num truncate text-[11px] text-ink-3", className)}>
      {children}
    </div>
  );
}

const DOT: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
};

/** A live indicator dot; pulses when the thing behind it is being watched. */
export function StatusDot({
  tone = "ok",
  pulse = false,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("relative inline-flex size-1.5 shrink-0", className)}>
      {pulse ? (
        <span
          className={cx(
            "absolute inline-flex size-full animate-ping rounded-full opacity-50",
            DOT[tone],
          )}
        />
      ) : null}
      <span className={cx("relative inline-flex size-1.5 rounded-full", DOT[tone])} />
    </span>
  );
}
