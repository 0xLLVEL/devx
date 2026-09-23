import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 border px-3 py-1 text-xs font-medium transition-colors duration-150",
  {
    variants: {
      variant: {
        default: "border-line-strong text-foreground",
        success: "border-success text-success",
        warning: "border-warning text-warning",
        destructive: "border-destructive text-destructive",
        outline: "border-line-strong text-ink-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Optional colored dot indicator before children */
    dot?: boolean;
    dotClassName?: string;
  };

/** Compact status indicator. */
export function Badge({ className, variant, dot, dotClassName, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full bg-current opacity-80", dotClassName)}
        />
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
