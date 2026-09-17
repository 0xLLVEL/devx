import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 disabled:grayscale-[0.2] active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /* §48 Primary: accent fill with subtle hover glow. */
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover hover:shadow-[0_0_12px_var(--accent-soft)]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        /* §48 Secondary: surface-2 on the default border. */
        outline:
          "border border-border bg-surface-2 text-foreground hover:border-line-strong hover:bg-hover",
        secondary: "bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "hover:bg-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
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
