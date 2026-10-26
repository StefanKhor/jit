import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cx } from "./cx";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuRule {
  separator: true;
}

/** A quiet overflow menu for row-level actions. */
export function Menu({
  items,
  label = "Actions",
  align = "end",
}: {
  items: Array<MenuItem | MenuRule>;
  label?: string;
  align?: "start" | "end";
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label={label}
        className="inline-flex size-7 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 data-[state=open]:bg-raised data-[state=open]:text-ink"
      >
        <span aria-hidden="true" className="flex flex-col items-center gap-[3px]">
          <span className="size-[3px] rounded-full bg-current" />
          <span className="size-[3px] rounded-full bg-current" />
          <span className="size-[3px] rounded-full bg-current" />
        </span>
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={6}
          className="surface edge lift z-[70] min-w-44 overflow-hidden rounded-xl border border-line-2 bg-panel/90 p-1 text-ink backdrop-blur-xl data-[state=open]:animate-overlay"
        >
          {items.map((item, index) =>
            "separator" in item ? (
              <MenuPrimitive.Separator
                key={`sep-${index}`}
                className="my-1 h-px bg-line"
              />
            ) : (
              <MenuPrimitive.Item
                key={item.label}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cx(
                  "flex cursor-default select-none items-center rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-40",
                  item.danger
                    ? "text-bad data-[highlighted]:bg-bad/10"
                    : "data-[highlighted]:bg-raised",
                )}
              >
                {item.label}
              </MenuPrimitive.Item>
            ),
          )}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
