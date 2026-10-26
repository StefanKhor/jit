import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

import { cx } from "./cx";

/**
 * Contained scroll for tables. The wrapper — never the page — is what grows
 * horizontally, so a wide table can never push the layout sideways.
 */
export function TableWrap({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("w-full min-w-0 overflow-x-auto", className)}>{children}</div>
  );
}

export function Table({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <table className={cx("w-full border-collapse text-sm", className)}>
      {children}
    </table>
  );
}

export function Th({
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-line bg-inset/40 px-5 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-ink-3",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cx("border-b border-line/60 px-5 py-3 align-middle", className)}
      {...props}
    >
      {children}
    </td>
  );
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cx(
        "transition-colors last:[&>td]:border-b-0 hover:bg-raised/50",
        className,
      )}
      {...props}
    />
  );
}
