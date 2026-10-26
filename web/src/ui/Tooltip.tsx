import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * A short explanation on hover. The child must accept a ref — pass a button or
 * a span, not a fragment.
 */
export function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={180} skipDelayDuration={400}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="surface edge z-[80] max-w-xs rounded-xl border border-line-2 bg-panel/90 px-2.5 py-1.5 text-xs text-ink-2 shadow-xl shadow-black/60 backdrop-blur-xl data-[state=delayed-open]:animate-overlay"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
