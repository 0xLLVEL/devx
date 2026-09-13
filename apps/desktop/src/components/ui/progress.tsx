import { cn } from "@/lib/utils";

/**
 * An indeterminate-or-determinate progress bar with the right ARIA wiring.
 * `value` is a 0..1 fraction; `undefined` renders an indeterminate shimmer.
 */
export function Progress({
  value,
  label,
  className,
}: {
  value?: number;
  label: string;
  className?: string;
}) {
  const pct = value === undefined ? undefined : Math.min(Math.max(value, 0), 1) * 100;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(pct !== undefined ? { "aria-valuenow": Math.round(pct) } : {})}
      className={cn("h-1 overflow-hidden rounded-full bg-secondary", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300",
          pct === undefined && "animate-pulse",
        )}
        style={{ width: `${pct ?? 30}%` }}
      />
    </div>
  );
}
