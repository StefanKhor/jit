import * as SelectPrimitive from "@radix-ui/react-select";

import { cx } from "./cx";

export interface SelectOption {
  value: string;
  label: string;
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A select on Radix — the trigger and the menu are ours, positioning and
 * keyboard handling are not. Items must have a non-empty `value`.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  id,
  name,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value?: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SelectPrimitive.Root
      value={value}
      name={name}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cx(
          "inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-2 bg-inset px-3 text-left text-sm text-ink transition-colors",
          "hover:border-ink-3/50 focus:border-accent/60 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15",
          "data-[placeholder]:text-ink-3 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="shrink-0 text-ink-3">
          <Chevron />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-[70] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-2 bg-panel text-ink shadow-2xl shadow-black/60 data-[state=open]:animate-overlay"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className={cx(
                  "relative flex cursor-default select-none items-center rounded-lg py-2 pl-8 pr-2.5 text-sm outline-none",
                  "data-[highlighted]:bg-raised data-[state=checked]:text-accent",
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2.5 inline-flex size-3.5 items-center justify-center text-accent">
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                    <path
                      d="M3.5 8.5l3 3 6-6.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
