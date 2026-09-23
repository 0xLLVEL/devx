import { cn } from "@/lib/utils";

export type SwitchProps = {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
};

/**
 * Binary toggle.
 *
 * Implemented as a `button` with `role="switch"` and `aria-checked`, which is
 * the pattern assistive technology expects for an on/off control.
 */
export function Switch({
  id,
  checked,
  onCheckedChange,
  disabled,
  className,
  ...rest
}: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-[18px] w-[34px] shrink-0 items-center rounded-full border border-line-strong bg-transparent transition-[border-color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-3 rounded-full transition-transform duration-200 ease-standard",
          checked
            ? "translate-x-[18px] bg-success"
            : "translate-x-[2px] bg-muted-foreground",
        )}
      />
    </button>
  );
}
