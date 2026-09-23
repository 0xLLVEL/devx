import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Single-line text or number field. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-[color,border-color] duration-150 placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 [&:not(:placeholder-shown)]:border-line-strong",
        className,
      )}
      {...props}
    />
  );
}
