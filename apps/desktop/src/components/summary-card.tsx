import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * Summary card: label, big value, status line, one click target — no icon
 * (preview `.card`). The whole card is the link, so its accessible name is
 * its own content. No trend slot: the backend keeps no previous period.
 */

export type SummaryTone = "neutral" | "success" | "warning" | "destructive";

/**
 * Card-as-link recipe: flat border, hover = border colour only, no lift.
 * Shared so every clickable card on the dashboard behaves identically.
 */
export const cardLinkClass = [
  "group flex border border-border bg-card text-card-foreground",
  "transition-[border-color] duration-150 hover:border-line-strong",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
].join(" ");

const TONE_TEXT: Record<SummaryTone, string> = {
  neutral: "text-ink-muted",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function SummaryCard({
  to,
  label,
  value,
  status,
  tone = "neutral",
  pending = false,
}: {
  /** Where the card goes. */
  to: string;
  label: string;
  /** The headline number, or null while it is unknown. */
  value: string | null;
  /** The current state, in words — never colour alone. */
  status: string;
  tone?: SummaryTone;
  /** The backend has not answered yet, so show a skeleton, not a zero. */
  pending?: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn(
        cardLinkClass,
        "flex-col gap-0 p-6",
        // Preview `.card.bad`: a failing group is marked on the left edge only.
        tone === "destructive" && "shadow-[inset_2px_0_0_var(--danger)]",
      )}
    >
      <span className="mb-2 text-[13px] text-ink-muted">{label}</span>

      {pending ? (
        <>
          <span
            aria-hidden
            className="block h-8 w-16 shimmer-skeleton"
          />
          <span className="sr-only">{`Loading ${label}`}</span>
        </>
      ) : (
        <span className="text-display tracking-[-0.02em] leading-[1.2] font-semibold">
          {value ?? "—"}
        </span>
      )}

      <span className={cn("mt-2 text-[13px]", TONE_TEXT[tone])}>
        {status}
      </span>
    </Link>
  );
}
