import { useEffect, useState, type ReactNode } from "react";

import { fmt } from "../format";
import { cx } from "./cx";

/**
 * The JIT wordmark. There is no icon: the logotype is the mark.
 */
export function Wordmark({
  className,
  dot = true,
}: {
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center font-semibold tracking-[0.34em] text-ink",
        className,
      )}
    >
      JIT
      {dot ? (
        <span aria-hidden="true" className="ml-1.5 size-1.5 rounded-full bg-accent" />
      ) : null}
    </span>
  );
}

/** Counts up to a value, unless the reader asked for less motion. */
export function AnimatedNumber({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const target = Number(value) || 0;
    if (reduceMotion) {
      setDisplay(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const duration = 520;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduceMotion]);

  const text = decimals
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(display)
    : fmt(display);
  return <span className={className}>{text}</span>;
}

/** A figure with a label — the unit of the overview and of panel sidebars. */
export function Stat({
  label,
  value,
  unit,
  hint,
  size = "md",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="kicker">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          className={cx(
            "num display leading-none text-ink",
            size === "lg" ? "text-4xl md:text-5xl" : "text-2xl",
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-xs text-ink-3">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-2 text-xs text-ink-3">{hint}</div> : null}
    </div>
  );
}

/** A hairline progress track, used for ratios and token budgets. */
export function Meter({
  value,
  tone = "accent",
  className,
}: {
  /** Percentage, 0–100. */
  value: number;
  tone?: "accent" | "ok" | "warn" | "bad";
  className?: string;
}) {
  const color =
    tone === "ok"
      ? "bg-ok"
      : tone === "warn"
        ? "bg-warn"
        : tone === "bad"
          ? "bg-bad"
          : "bg-accent";
  return (
    <div
      className={cx("h-1 w-full overflow-hidden rounded-full bg-line", className)}
      role="presentation"
    >
      <div
        className={cx("h-full rounded-full transition-[width] duration-500", color)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx("size-4 animate-spin", className)}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity="0.25"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num rounded border border-line-2 bg-raised px-1.5 py-0.5 text-[10px] text-ink-3">
      {children}
    </kbd>
  );
}

/** The resting state of a list or a view that has nothing to show yet. */
export function Empty({
  title,
  children,
  actions,
  icon,
  className,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-full border border-line bg-raised text-ink-3">
          {icon}
        </div>
      ) : null}
      <div className="text-sm font-medium text-ink">{title}</div>
      {children ? (
        <p className="max-w-md text-sm leading-relaxed text-ink-2">{children}</p>
      ) : null}
      {actions ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
