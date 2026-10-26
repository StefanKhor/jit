import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";

const button = cva(
  [
    "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap",
    "font-medium transition-[background-color,border-color,color,box-shadow,opacity,transform]",
    "duration-150 ease-out active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-40",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-ivory text-canvas shadow-[0_1px_0_0_rgba(255,255,255,0.5)_inset,0_8px_20px_-12px_rgba(255,255,255,0.4)] hover:bg-ivory/90",
        accent:
          "bg-gradient-to-b from-accent to-accent/85 text-accent-ink glow-accent hover:from-accent/90 hover:to-accent/75",
        outline:
          "border border-line-2 bg-panel/50 text-ink backdrop-blur hover:border-ink-3/60 hover:bg-raised",
        ghost: "text-ink-2 hover:bg-raised hover:text-ink",
        danger: "border border-bad/30 text-bad hover:border-bad/55 hover:bg-bad/10",
      },
      size: {
        sm: "h-7 rounded-lg px-2.5 text-xs",
        md: "h-9 rounded-xl px-3.5 text-sm",
        lg: "h-11 rounded-xl px-5 text-sm",
        icon: "size-9 rounded-xl",
        "icon-sm": "size-7 rounded-lg",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /** Rendered before the label — a glyph or short marker. */
  lead?: ReactNode;
}

export function Button({
  variant,
  size,
  lead,
  className,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(button({ variant, size }), className)}
      {...props}
    >
      {lead ? (
        <span aria-hidden="true" className="shrink-0">
          {lead}
        </span>
      ) : null}
      {children}
    </button>
  );
}

/** A square, quiet button for icon-only actions in toolbars and headers. */
export function IconButton({ className, size = "icon", ...props }: ButtonProps) {
  return (
    <Button
      variant="ghost"
      size={size}
      className={cx("text-ink-3 hover:text-ink", className)}
      {...props}
    />
  );
}
