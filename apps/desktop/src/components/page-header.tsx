import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Flat, functional page header: a solid title row with an optional
 * right-aligned slot for page-specific status. Replaces the old gradient
 * HeroBand — the page headline reads as a sentence, not a banner
 * (see DESIGN.md).
 */
export function PageHeader({
  title,
  description,
  right,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {right ? <div className="flex flex-col items-end gap-2">{right}</div> : null}
    </div>
  );
}
