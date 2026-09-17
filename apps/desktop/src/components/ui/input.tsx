import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Single-line text or number field. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        /* §12 inputs are 8px, §55 focus is a 2px accent outline with offset.
           Focus glow adds a soft halo for premium depth. Filled inputs gain
           a stronger border so the user can scan which fields have data. */
        "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-[color,border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 [&:not(:placeholder-shown)]:border-line-strong",
        className,
      )}
      {...props}
    />
  );
}
