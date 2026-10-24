import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";

/** The page banner: kicker, a display title, one line of intent, and actions. */
export function PageHead({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 pb-7">
      <div className="min-w-0">
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <h1 className="display mt-3 text-3xl text-ink md:text-4xl">{title}</h1>
        {description ? (
          <p className="mt-3.5 max-w-xl text-sm leading-relaxed text-ink-2">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

/** A bordered surface. Everything on a page sits on one of these. */
export function Panel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cx(
        "overflow-hidden rounded-2xl border border-line bg-panel/80",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function PanelHead({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm text-ink">{title}</h2>
        {hint ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-3">{hint}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function PanelBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("p-5", className)}>{children}</div>;
}
