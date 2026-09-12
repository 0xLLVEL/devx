import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Form label. Always pair with a control via `htmlFor`. */
export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
