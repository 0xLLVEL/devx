import { History } from "lucide-react";

import { stateTone } from "@/components/status-dot";
import { EmptyState } from "@/components/ui/empty-state";
import { describeExit, describeTransition, formatRelativeTime } from "@/lib/activity";
import type { EventEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * §42 recent activity: the service transitions the backend logged, newest
 * first, each as a sentence plus how long ago it happened.
 *
 * Informative, not noisy: one line per transition, capped, and the exit reason
 * only when it explains something. Every row comes from the event log — there
 * is no client-side timeline to fall out of step with what Rust recorded.
 */
export function ActivityTimeline({
  events,
  limit = 6,
}: {
  events: readonly EventEntry[];
  limit?: number;
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="No service events yet."
        description="Starting, stopping or failing a service records it here."
      />
    );
  }

  return (
    <ul className="space-y-2.5">
      {events.slice(0, limit).map((event) => {
        const exit = describeExit(event.exit);
        return (
          <li key={`${event.at_unix}-${event.id}-${event.state}`} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", stateTone(event.state))}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {describeTransition(event.state, event.id)}
              </p>
              <p className="text-caption text-ink-muted">
                <time dateTime={toIso(event.at_unix)}>
                  {formatRelativeTime(event.at_unix)}
                </time>
                {exit ? ` · ${exit}` : ""}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The machine-readable form of an event's timestamp, for `<time dateTime>`. */
function toIso(atUnix: number): string {
  if (!Number.isFinite(atUnix) || atUnix <= 0) {
    return "";
  }
  return new Date(atUnix * 1000).toISOString();
}
