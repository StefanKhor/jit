import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { cx } from "./cx";
import { IconButton } from "./Button";

/**
 * A modal on Radix: focus trapping, Escape, scroll lock and the top layer are
 * handled; the surface and the motion are ours.
 */
export function Dialog({
  open,
  onClose,
  className,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cx(
            "fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px]",
            "data-[state=open]:animate-overlay data-[state=closed]:animate-overlay-out",
          )}
        />
        <DialogPrimitive.Content
          aria-labelledby={labelledBy}
          className={cx(
            "surface edge lift fixed left-1/2 top-1/2 z-[60] flex max-h-[min(46rem,calc(100dvh-2rem))] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-2 bg-panel/85 text-ink backdrop-blur-2xl outline-none",
            "data-[state=open]:animate-dialog data-[state=closed]:animate-dialog-out",
            className,
          )}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DialogHead({
  kicker,
  title,
  onClose,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="relative flex items-start justify-between gap-5 border-b border-line px-6 py-5">
      <div className="min-w-0">
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <DialogPrimitive.Title className="mt-2 text-lg text-ink">
          {title}
        </DialogPrimitive.Title>
        {children ? (
          <DialogPrimitive.Description className="mt-1.5 text-xs leading-relaxed text-ink-2">
            {children}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      {onClose ? (
        <IconButton className="-mr-1.5 -mt-1" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
            <path
              d="M3.5 3.5l9 9m0-9l-9 9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      ) : null}
      {/* The same top-lit rule that runs under a panel head. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-accent/25 via-transparent to-transparent"
      />
    </header>
  );
}

export function DialogBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("min-h-0 flex-1 overflow-y-auto px-6 py-5", className)}>
      {children}
    </div>
  );
}

export function DialogFoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <footer
      className={cx(
        "flex flex-wrap items-center justify-end gap-2 border-t border-line bg-inset/40 px-6 py-4 backdrop-blur",
        className,
      )}
    >
      {children}
    </footer>
  );
}
