import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Flat, functional page header: a solid title row with optional context
 * above it and the page's primary action opposite. Replaces the old gradient
 * HeroBand — the page headline reads as a sentence, not a banner
 * (see DESIGN.md §63).
 *
 * §63 asks for Title + Description + Primary Action, with the row of search,
 * filters or tabs underneath: that is `primaryAction` and `children`. `right`
 * predates §63 and keeps working, so pages that put status or secondary text
 * opposite the headline stay exactly as they were.
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
  /** §63's primary action, pinned to the far end of the title row. */
  primaryAction?: ReactNode;
  /** §63's search / filters / tabs row, below the title. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-border pb-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {eyebrow ? (
            <p className="text-caption text-ink-muted">{eyebrow}</p>
          ) : null}
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {description ? (
            <div className="text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {right || primaryAction ? (
          <div className="flex flex-wrap items-start gap-4">
            {right ? (
              <div className="flex flex-col items-end gap-2">{right}</div>
            ) : null}
            {primaryAction ? (
              <div className="flex items-center gap-2">{primaryAction}</div>
            ) : null}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
