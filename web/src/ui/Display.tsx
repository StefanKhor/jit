import { useEffect, useId, useState, type ReactNode } from "react";

import { fmt } from "../format";
import { cx } from "./cx";

const JIT_ASCII = [
  "      ██╗ ██╗████████╗",
  "      ██║ ██║╚══██╔══╝",
  "      ██║ ██║   ██║",
  "      ██║ ██║   ██║",
  " ██   ██║ ██║   ██║",
  " ╚█████╔╝ ██║   ██║",
  "  ╚════╝  ╚═╝   ╚═╝",
]
  .map((line) => line.padEnd(21))
  .join("\n");

const ASCII_LOGO_STYLE =
  "absolute inset-0 m-0 select-none whitespace-pre font-mono text-[0.56em] leading-[1.05]";

/** JIT's compact block-letter ASCII logo. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="JIT"
      className={cx("inline-flex items-center gap-1.5 text-ink", className)}
    >
      <span className="relative inline-block align-middle">
        <pre aria-hidden="true" className={`${ASCII_LOGO_STYLE} invisible static`}>
          {JIT_ASCII}
        </pre>
        <pre
          aria-hidden="true"
          className={`${ASCII_LOGO_STYLE} translate-x-px translate-y-px text-ink-3/60`}
        >
          {JIT_ASCII}
        </pre>
        <pre aria-hidden="true" className={`${ASCII_LOGO_STYLE} text-accent`}>
          {JIT_ASCII}
        </pre>
      </span>
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

/**
 * A proportional arc — a value drawn as a fraction of a ring.
 *
 * The stroke is a gradient, and the arc draws itself in on mount, which makes a
 * number that only changes by a fraction of a percent still read as a movement.
 */
type RingTone = "accent" | "accent-2" | "ok" | "warn" | "bad";

const RING_STOPS: Record<RingTone, [string, string]> = {
  accent: ["var(--color-accent-2)", "var(--color-accent)"],
  "accent-2": ["var(--color-accent-3)", "var(--color-accent-2)"],
  ok: ["var(--color-accent)", "var(--color-ok)"],
  warn: ["var(--color-warn)", "var(--color-accent)"],
  bad: ["var(--color-bad)", "var(--color-warn)"],
};

export function Ring({
  value,
  size = 132,
  thickness = 8,
  tone = "accent",
  children,
  className,
  label,
}: {
  /** Fraction of the ring to fill, 0–1. */
  value: number;
  size?: number;
  thickness?: number;
  tone?: RingTone;
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  const id = useId();
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const radius = 50 - thickness / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * ratio;
  const [from, to] = RING_STOPS[tone];

  return (
    <div
      className={cx("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 100 100"
        className="size-full -rotate-90"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="var(--color-line-2)"
          strokeWidth={thickness}
          strokeOpacity={0.55}
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          style={{
            ["--draw-from" as string]: `${circumference}`,
            ["--draw-to" as string]: `${circumference - filled}`,
          }}
          className="motion-safe:animate-draw"
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {children}
        </div>
      ) : null}
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

export function ActivityStatus({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="surface flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/[0.04] px-4 py-3 text-sm text-ink-2"
    >
      <Spinner className="shrink-0 text-accent" />
      <span>{children}</span>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num surface rounded-md border border-line-2 bg-raised px-1.5 py-0.5 text-[10px] text-ink-3">
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
