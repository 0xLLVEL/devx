import type { ReactNode } from "react";

/**
 * Flat page header: eyebrow, big title, subtitle, optional status box and the
 * page's primary action opposite. No bottom rule — panels below supply their
 * own borders (preview `.headrow`).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  right,
  primaryAction,
  children,
  className,
}: {
  /** One line of context above the title — a greeting, a section name. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  /** Primary action, pinned to the far end of the title row. */
  primaryAction?: ReactNode;
  /** Search / filters / tabs row, below the title. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 space-y-2">
          {eyebrow ? (
            <p className="text-[13px] tracking-[0.08em] text-ink-muted uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-h1 tracking-tight">{title}</h2>
          {description ? (
            <div className="text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {right || primaryAction ? (
          <div className="flex flex-wrap items-start gap-6">
            {right ? (
              <div className="flex flex-col items-end gap-2">{right}</div>
            ) : null}
            {primaryAction ? (
              <div className="flex items-center gap-3">{primaryAction}</div>
            ) : null}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-6">{children}</div> : null}
    </div>
  );
}
