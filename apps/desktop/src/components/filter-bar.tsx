import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * §61 filters.
 *
 * The row holds the compact controls; every control that is off its default
 * becomes a removable chip underneath, and `Clear filters` appears once more
 * than one of them is stacked so the user is not reduced to resetting the
 * selects one by one. A filter only ever reaches this component when the data
 * behind it has something to filter, so no control here is decoration.
 */

export type ActiveFilter = {
  id: string;
  /** What the filter is, e.g. `Server`. */
  label: string;
  /** The value it is set to, e.g. `Caddy`. */
  value: string;
  /** Returns that one filter to its default. */
  onClear: () => void;
};

export function FilterBar({
  children,
  active,
  onClear,
  className,
}: {
  /** The compact controls themselves. */
  children: ReactNode;
  active: readonly ActiveFilter[];
  /** Resets every filter at once. */
  onClear: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>

      {active.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {active.map((filter) => (
            <span
              key={filter.id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2 pr-1 text-xs text-ink-secondary"
            >
              <span className="text-ink-muted">{filter.label}</span>
              <span className="font-medium text-foreground">{filter.value}</span>
              <button
                type="button"
                aria-label={`Clear ${filter.label} filter`}
                onClick={filter.onClear}
                className="ml-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}

          {active.length > 1 ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
