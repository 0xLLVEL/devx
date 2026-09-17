import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  /* §65: 11–12px, 999px radius, 3px/8px padding. Tone comes from the §8
     `-soft` tokens, never from a raw colour. */
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-150",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary-soft text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
        destructive: "border-transparent bg-destructive-soft text-destructive",
        info: "border-transparent bg-info-soft text-info",
        cyan: "border-transparent bg-cyan-soft text-cyan",
        outline: "border-border text-muted-foreground",
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
