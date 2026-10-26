import type { ToastMessage } from "../types";
import { cx } from "./cx";

/** The single, transient status line. Announced politely to screen readers. */
export function Toast({ toast }: { toast: ToastMessage | null }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4"
      aria-live="polite"
      role="status"
    >
      {toast ? (
        <div
          className={cx(
            "surface edge lift pointer-events-auto flex max-w-lg animate-view items-start gap-2.5 rounded-xl border bg-panel/80 px-4 py-3.5 text-sm backdrop-blur-xl",
            toast.kind === "error" ? "border-bad/40 text-bad" : "border-line-2 text-ink",
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              toast.kind === "error" ? "bg-bad" : "bg-accent",
            )}
          />
          <span className="min-w-0">{toast.message}</span>
        </div>
      ) : null}
    </div>
  );
}
