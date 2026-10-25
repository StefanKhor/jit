import { useEffect, useState, type ReactNode } from "react";

import { cx } from "./cx";
import { Checkbox } from "./Field";

export interface Selection {
  /** Keys currently selected, in insertion order. */
  selected: Set<string>;
  count: number;
  has: (key: string) => boolean;
  toggle: (key: string, on?: boolean) => void;
  toggleAll: (on?: boolean) => void;
  /** Replace the selection with exactly these keys. */
  select: (keys: string[]) => void;
  clear: () => void;
  /** Every available key is selected (and there is at least one). */
  all: boolean;
  /** Some but not all are selected — the header box shows a dash. */
  some: boolean;
}

/**
 * Track a set of selected row keys. The selection self-prunes when the rows
 * change, so a refresh can never leave a stale id selected.
 */
export function useSelection(keys: string[]): Selection {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const signature = keys.join("\u0000");

  useEffect(() => {
    setPicked((current) => {
      if (current.size === 0) return current;
      const allowed = new Set(keys);
      const next = new Set<string>();
      for (const key of current) if (allowed.has(key)) next.add(key);
      return next.size === current.size ? current : next;
    });
    // Re-prune only when the set of available keys actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const toggle = (key: string, on?: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (on ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return {
    selected: picked,
    count: picked.size,
    has: (key) => picked.has(key),
    toggle,
    toggleAll: (on) =>
      setPicked(on ?? picked.size !== keys.length ? new Set(keys) : new Set()),
    select: (next) => setPicked(new Set(next)),
    clear: () => setPicked(new Set()),
    all: keys.length > 0 && picked.size === keys.length,
    some: picked.size > 0 && picked.size < keys.length,
  };
}

/** The header checkbox: checks all rows, dashes when the selection is partial. */
export function SelectAll({
  selection,
  label = "Select all rows",
}: {
  selection: Selection;
  label?: string;
}) {
  return (
    <Checkbox
      aria-label={label}
      checked={selection.all}
      indeterminate={selection.some}
      onChange={(event) => selection.toggleAll(event.target.checked)}
    />
  );
}

/**
 * The bulk bar. It lives in a panel head in place of the usual actions, so the
 * moment anything is selected the verbs for the whole selection appear.
 */
export function SelectionBar({
  count,
  noun = "selected",
  onClear,
  children,
}: {
  count: number;
  noun?: string;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={cx(
          "inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10",
          "px-2.5 py-1 text-[11px] font-medium text-accent",
        )}
      >
        <span className="num leading-none">{count}</span>
        {noun}
      </span>
      {children}
      <button
        type="button"
        className="ml-0.5 rounded-md px-2 py-1 text-[11px] text-ink-3 transition-colors hover:text-ink"
        onClick={onClear}
      >
        Clear
      </button>
    </div>
  );
}
