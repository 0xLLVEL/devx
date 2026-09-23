import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border text-[13px] font-medium transition-[color,background-color,border-color,opacity] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 active:opacity-85 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // preview `.btn.ghost`: outlined ink, transparent until hover.
        outline:
          "border-line-strong bg-transparent text-foreground hover:bg-hover",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-hover",
        // The chrome icon recipe (preview `.ticon`): transparent until hover.
        ghost: "border-transparent text-ink-muted hover:border-line-strong hover:text-foreground",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>;

/** Primary interactive control, shadcn/ui compatible. */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
