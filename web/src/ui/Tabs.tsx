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
        "inline-flex items-center gap-1 rounded-full border border-line bg-inset p-0.5",
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
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs text-ink-3 transition-colors hover:text-ink-2",
        "data-[state=active]:bg-raised data-[state=active]:text-ink",
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
