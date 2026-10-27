import * as SliderPrimitive from "@radix-ui/react-slider";

import { cx } from "./cx";

/** A single-thumb range. The value is the number, not a one-element array. */
export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SliderPrimitive.Root
      className={cx(
        "relative flex h-5 w-full touch-none select-none items-center",
        disabled && "opacity-50",
        className,
      )}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([next]) => onValueChange(next ?? min)}
      onValueCommit={
        onValueCommit ? ([next]) => onValueCommit(next ?? min) : undefined
      }
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-line/80 shadow-[0_1px_2px_0_rgb(0_0_0/0.5)_inset]">
        <SliderPrimitive.Range className="absolute h-full bg-gradient-to-r from-accent-2/70 to-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        id={id}
        aria-label={ariaLabel}
        className="block size-3.5 rounded-full border border-line-2 bg-ink shadow-[0_1px_3px_0_rgb(0_0_0/0.6)] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
    </SliderPrimitive.Root>
  );
}
