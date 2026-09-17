import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * §18 summary card: icon, label, value, status, one click target.
 *
 * The whole card is the link — a nested button inside a link breaks keyboard
 * navigation — so the card's accessible name is its own content.
 *
 * There is no trend slot: §131 Rule 17 forbids invented numbers, and the
 * backend keeps no previous period to compare against.
 */

export type SummaryTone = "neutral" | "success" | "warning" | "destructive";

const TONE_DOT: Record<SummaryTone, string> = {
  neutral: "bg-muted-foreground/40",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * The §51 card-hover recipe for a card that is itself a link: accent border,
 * 1px lift, 160ms. Reduced motion drops the lift rather than merely shortening
 * it, so the card never moves under `prefers-reduced-motion`.
 *
 * Shared so every clickable card on the dashboard behaves identically.
 */
export const cardLinkClass = [
  "group flex rounded-lg border border-border bg-card text-card-foreground shadow-sm",
  "transition-[transform,border-color,box-shadow] duration-[160ms]",
  "hover:-translate-y-px hover:border-primary/40 hover:shadow-md",
  "motion-reduce:hover:translate-y-0",
  // §55: the ring colour is stated rather than left to `currentColor`, so a
  // clickable card focuses exactly like every button and input in the app.
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
].join(" ");

export function SummaryCard({
  to,
  icon: Icon,
  label,
  value,
  status,
  tone = "neutral",
  pending = false,
}: {
  /** Where the card goes. §18 requires a real click interaction. */
  to: string;
  icon: LucideIcon;
  label: string;
  /** The headline number, or null while it is unknown. */
  value: string | null;
  /** §89 Level 2: the current state, in words — never colour alone (§55). */
  status: string;
  tone?: SummaryTone;
  /** §37: the backend has not answered yet, so show a skeleton, not a zero. */
  pending?: boolean;
}) {
  return (
    <Link to={to} className={cn(cardLinkClass, "flex-col gap-2 p-3.5")}>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-ink-secondary",
            "transition-[color,border-color,box-shadow] duration-[160ms]",
            "group-hover:border-primary/40 group-hover:text-primary group-hover:shadow-[0_0_8px_var(--accent-soft)]",
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 truncate text-xs font-medium text-ink-secondary">
          {label}
        </span>
      </div>

      {pending ? (
        <>
          <span
            aria-hidden
            className="block h-6 w-12 animate-pulse rounded-sm bg-secondary"
          />
          <span className="sr-only">{`Loading ${label}`}</span>
        </>
      ) : (
        <span className="font-mono text-h2 tracking-tight text-foreground">
          {value ?? "—"}
        </span>
      )}

      <span
        className={cn(
          "flex items-center gap-1.5 text-caption",
          tone === "destructive" ? "text-destructive" : "text-ink-muted",
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
        />
        <span className="min-w-0 truncate">{status}</span>
      </span>
    </Link>
  );
}
