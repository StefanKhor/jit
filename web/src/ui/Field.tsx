import {
  useEffect,
  useRef,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cx } from "./cx";
import { Switch } from "./Switch";

const CONTROL =
  "w-full rounded-xl border border-line-2 bg-inset/80 px-3 text-ink transition-all " +
  "shadow-[0_1px_2px_0_rgb(0_0_0/0.4)_inset] " +
  "placeholder:text-ink-3 hover:border-ink-3/50 focus:border-accent/60 focus:bg-inset focus:outline-none " +
  "focus-visible:outline-none focus:ring-2 focus:ring-accent/15 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, "h-9", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(CONTROL, "min-h-28 resize-y py-2.5 font-mono text-xs", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, "h-9", className)} {...props} />;
}

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Shows the native "some rows selected" dash instead of a tick. */
  indeterminate?: boolean;
}

export function Checkbox({
  className,
  indeterminate,
  ...props
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={cx(
        "size-4 shrink-0 cursor-pointer rounded border-line-2 bg-inset accent-[var(--color-accent)]",
        className,
      )}
      {...props}
    />
  );
}

/** Label + control + hint, the vertical form unit used across the settings panes. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block space-y-2", className)}>
      <span className="block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error ? (
        <span className="block text-xs text-bad">{error}</span>
      ) : hint ? (
        <span className="block text-xs leading-relaxed text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A labelled switch — the house toggle row. Accepts either `onCheckedChange`
 * (preferred) or a native-style `onChange`, so either call site reads cleanly.
 */
export function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  onChange,
  disabled,
  id,
  className,
}: {
  label: string;
  hint?: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const handle = (next: boolean) => {
    onCheckedChange?.(next);
    onChange?.({
      target: { checked: next },
      currentTarget: { checked: next },
    } as unknown as ChangeEvent<HTMLInputElement>);
  };

  return (
    <label
      className={cx(
        "surface edge flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-panel/60 px-4 py-3 transition-colors hover:border-line-2 hover:bg-panel/90",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {hint ? (
          <span className="mt-1 block text-xs leading-relaxed text-ink-3">
            {hint}
          </span>
        ) : null}
      </span>
      <Switch
        id={id}
        checked={Boolean(checked)}
        onCheckedChange={handle}
        disabled={disabled}
        className="mt-0.5"
      />
    </label>
  );
}
