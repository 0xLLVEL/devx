import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const VARIANTS = {
  info: "border-l-foreground",
  success: "border-l-success",
  warning: "border-l-warning",
  destructive: "border-l-destructive",
} as const;

const DOT = {
  info: "bg-ink-muted",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const;

/**
 * A bordered inline note (caveats, remedies, hints) in one consistent shape.
 * The left edge carries the severity (preview `.callout`); the words stay ink.
 */
export function Callout({
  variant = "info",
  title,
  children,
  className,
}: {
  variant?: keyof typeof VARIANTS;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={variant === "destructive" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-3 border border-line-strong border-l-2 bg-surface px-6 py-4 text-sm text-foreground",
        VARIANTS[variant],
        className,
      )}
    >
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[variant])} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
      </div>
    </div>
  );
}
