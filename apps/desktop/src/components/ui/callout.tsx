import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const VARIANTS = {
  info: "border-primary/40 bg-primary/10 text-foreground",
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-foreground",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

/** A bordered inline note (caveats, remedies, hints) in one consistent shape. */
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
      className={cn("rounded-md border p-3 text-sm", VARIANTS[variant], className)}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? "mt-1 opacity-90" : "opacity-90"}>{children}</div> : null}
    </div>
  );
}
