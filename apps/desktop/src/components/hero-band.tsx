import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The gradient band every page opens with: a soft primary wash that carries
 * the page's headline and any right-aligned summary slot. The visual
 * signature of the infotainment redesign.
 */
export function HeroBand({
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
        "rounded-xl border border-border bg-gradient-to-br from-primary/10 via-background to-background p-6",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            DevX
          </p>
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          {description ? (
            <div className="text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {right ? <div className="flex flex-col items-end gap-2">{right}</div> : null}
      </div>
    </div>
  );
}
