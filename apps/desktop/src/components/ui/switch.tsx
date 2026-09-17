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
        /* §51 toggle: 180–220ms thumb travel, with track glow when checked. */
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-[color,background-color,box-shadow] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-primary shadow-[inset_0_0_6px_var(--accent-soft)]"
          : "bg-input",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-elevated shadow-sm transition-[transform,box-shadow] duration-200 ease-standard",
          checked ? "translate-x-4 shadow-md" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
