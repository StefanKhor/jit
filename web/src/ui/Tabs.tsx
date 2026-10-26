import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

import { cx } from "./cx";

/** A tab set on Radix. Tabs and their panels share a `value`. */
export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      className={className}
    >
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabList({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.List
      aria-label={label}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border border-line bg-inset/80 p-0.5 shadow-[0_1px_2px_0_rgb(0_0_0/0.35)_inset]",
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function Tab({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs text-ink-3 transition-all hover:text-ink-2",
        "data-[state=active]:bg-gradient-to-b data-[state=active]:from-raised data-[state=active]:to-raised/50 data-[state=active]:text-ink data-[state=active]:shadow-[0_1px_0_0_color-mix(in_oklab,var(--color-ivory)_8%,transparent)_inset,0_10px_18px_-14px_#000]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
        className,
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabsPrimitive.Content
      value={value}
      className={cx("focus-visible:outline-none", className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
