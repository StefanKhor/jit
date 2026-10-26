import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cx } from "./cx";

/** A binary control on Radix: keyboard and screen-reader correct by default. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line-2 bg-inset/80 shadow-[0_1px_2px_0_rgb(0_0_0/0.4)_inset] transition-all",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:shadow-[0_0_14px_-2px_color-mix(in_oklab,var(--color-accent)_70%,transparent)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cx(
          "pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-ink-3 transition-transform",
          "data-[state=checked]:translate-x-[1.15rem] data-[state=checked]:bg-accent-ink",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
