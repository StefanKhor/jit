import type { ReactNode } from "react";

import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/** A small set of mutually exclusive filters, in one inset track. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx(
        "inline-flex items-center gap-0.5 rounded-full border border-line bg-inset p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors",
              active
                ? "bg-raised text-ink"
                : "text-ink-3 hover:text-ink-2",
            )}
          >
            {option.label}
            {option.count != null ? (
              <span className="num text-[10px] text-ink-3">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
