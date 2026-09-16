import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, CheckCheck, Inbox, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { stateTone } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import {
  describeExit,
  describeTransition,
  formatRelativeTime,
} from "@/lib/activity";
import { ipc, type NotificationEntry, type NotificationList } from "@/lib/ipc";
import { useSystemStatus } from "@/lib/shell-data";
import { cn } from "@/lib/utils";

/**
 * §98's notification center: the bell in the topbar, its panel, and the two
 * actions the section allows.
 *
 * Not a second inbox. Every entry is a transition the supervisor already
 * recorded, and the only thing that makes an entry "new" is a marker Rust
 * persists — so this component never invents an event, a time or a count, it
 * only names what the backend decided. "Mark all read" and "Clear" move that
 * marker; neither of them deletes anything, which is why an error can be
 * cleared here and still be on the dashboard timeline (§42) afterwards.
 *
 * Read straight from TanStack Query rather than through `lib/queries.ts`: the
 * panel is shell chrome with one reader, and it is the only query the badge
 * and the panel share.
 */

/** How many entries the panel asks for. */
const PANEL_LIMIT = 50;

/** One query behind both the badge and the panel: two readers, one answer. */
const NOTIFICATIONS_KEY = ["notifications"] as const;

/**
 * §98 in the topbar.
 *
 * The badge counts unread notifications, which includes any failure that has
 * not been acknowledged — so a service that broke and was never cleared keeps
 * asking, exactly as §98 requires. The count of services that are failing
 * *right now* is a live condition rather than a notification, and it is named
 * in the label and shown by §118's verdict in the sidebar and dashboard.
 */
export function NotificationSlot() {
  const status = useSystemStatus();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Read on mount, not on open: the badge has to be right before anyone clicks
  // it. Transitions invalidate it (see `useServiceEvents`), so the count
  // follows the services without this query polling.
  const notifications = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => ipc.notificationsList(PANEL_LIMIT),
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        // Escape closes the panel; the focus goes back to what opened it, or
        // the keyboard user is left at the top of the document (§55).
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const unread = notifications.data?.unread_count ?? 0;
  const failed = status?.failedCount ?? 0;
  const label = badgeLabel(unread, failed);

  return (
    <div ref={container} className="relative">
      <Tooltip label={label}>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="relative"
        >
          {unread > 0 ? <BellRing /> : <Bell />}
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive font-mono text-[10px] text-destructive-foreground"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </Tooltip>

      {open ? (
        <NotificationPanel
          data={notifications.data}
          isPending={notifications.isPending}
          error={notifications.isError ? notifications.error : null}
          onRetry={() => void notifications.refetch()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * What the bell says, in words.
 *
 * Both facts are named because they are different questions: how many services
 * are broken at this instant, and how many notifications are waiting. The
 * failing count comes first so the alarm is the first thing a screen reader
 * announces; with nothing unread, the string is exactly the one the bell used
 * before the panel could count notifications at all.
 */
function badgeLabel(unread: number, failed: number): string {
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(`${failed} service${failed === 1 ? "" : "s"} failed`);
  }
  if (unread > 0) {
    parts.push(`${unread} unread`);
  }
  return parts.length > 0 ? `Notifications: ${parts.join(", ")}` : "Notifications";
}

/** §98's panel: title, entries newest first, and the two allowed actions. */
function NotificationPanel({
  data,
  isPending,
  error,
  onRetry,
  onClose,
}: {
  data: NotificationList | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  // Both actions answer with the panel they produced, so the UI never has to
  // ask again and can never show a marker the backend did not write.
  const applyResult = (result: NotificationList) =>
    queryClient.setQueryData(NOTIFICATIONS_KEY, result);

  const markAllRead = useMutation({
    mutationFn: () => ipc.notificationsMarkAllRead(PANEL_LIMIT),
    onSuccess: applyResult,
    onError: (error) => {
      toast.error("Could not mark notifications as read", {
        details: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const clear = useMutation({
    mutationFn: () => ipc.notificationsClear(PANEL_LIMIT),
    onSuccess: applyResult,
    onError: (error) => {
      toast.error("Could not clear notifications", {
        details: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const entries = data?.entries ?? [];
  const unread = data?.unread_count ?? 0;
  const busy = markAllRead.isPending || clear.isPending;
  // §98's rule, made visible: as long as an error is unacknowledged, reading
  // everything else does not take it away, so the panel says why it is still
  // here instead of letting the user wonder whether the button worked.
  const unreadErrors = entries.filter(
    (entry) => entry.unread && entry.severity === "error",
  ).length;
  // §56: "Mark all read" only has work while some entry is unread for a reason
  // reading can fix. An unacknowledged failure is not one — Clear is the
  // action for it — so the button greys out rather than accepting a click that
  // changes nothing.
  const readable = entries.some(
    (entry) => entry.unread && entry.severity !== "error",
  );

  return (
    <div className="glass-surface absolute right-0 z-50 mt-2 w-[360px] rounded-lg p-1 shadow-lg">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="text-caption tracking-wide text-ink-muted uppercase">
          Notifications
        </p>
        {unread > 0 ? (
          <p className="text-caption text-ink-muted">{unread} unread</p>
        ) : null}
      </div>

      {isPending ? (
        <p className="px-3 py-2 text-sm text-ink-muted" role="status">
          Loading notifications…
        </p>
      ) : null}

      {error ? (
        // §39: the same titled callout and retry every page uses, so the panel
        // reports the failure instead of printing the backend's own string as
        // the whole message.
        <div className="p-2">
          <Callout variant="destructive" title="Could not read the notifications.">
            <p>
              {error instanceof Error
                ? error.message
                : "The backend did not answer."}
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          </Callout>
        </div>
      ) : null}

      {!isPending && !error && entries.length === 0 && data ? (
        <div className="p-2">
          {/* Two different sentences, because "nothing has happened" and
              "everything was cleared" are not the same news. */}
          {data.recorded === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No service events yet."
              description="Starting, stopping or failing a service records a notification here."
            />
          ) : (
            <EmptyState
              icon={<CheckCheck />}
              title="Nothing to read."
              description="Everything recorded has been cleared. The timeline on the dashboard keeps the history."
            />
          )}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ul className="max-h-72 overflow-y-auto" aria-label="Recorded service events">
          {entries.map((entry) => (
            <NotificationRow
              key={`${entry.at_unix}-${entry.id}-${entry.state}`}
              entry={entry}
            />
          ))}
        </ul>
      ) : null}

      {unreadErrors > 0 ? (
        <p className="border-t border-line-subtle px-3 py-2 text-caption text-ink-muted">
          {unreadErrors === 1
            ? "A failure stays until you clear it."
            : `${unreadErrors} failures stay until you clear them.`}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-line-subtle px-3 py-2">
        <div className="flex items-center gap-1">
          <Tooltip label="Mark every notification as read">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !readable}
              onClick={() => markAllRead.mutate()}
            >
              Mark all read
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="ghost"
            // §56: no control that does nothing. An empty panel has nothing to
            // acknowledge.
            disabled={busy || entries.length === 0}
            onClick={() => clear.mutate()}
          >
            Clear
          </Button>
        </div>
        <Link
          to="/services"
          onClick={onClose}
          className="text-xs text-primary hover:underline"
        >
          Open Services
        </Link>
      </div>
    </div>
  );
}

/**
 * One notification: what happened, how long ago, and whether it is still
 * unread.
 *
 * The sentence comes from the shared §42 vocabulary instead of being rebuilt
 * here, so the panel and the timeline describe the same transition the same
 * way. Severity is never colour alone (§55): the dot is decoration, the state
 * and the exit reason are the words, and an unread entry also carries a
 * screen-reader label and a heavier weight.
 */
function NotificationRow({ entry }: { entry: NotificationEntry }) {
  const exit = describeExit(entry.exit);
  const important = entry.severity === "error";

  return (
    // No hover state: nothing happens when a row is clicked, and a highlight
    // would promise otherwise (§56).
    <li className="flex items-start gap-2.5 rounded-md px-3 py-2">
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", stateTone(entry.state))}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm",
            entry.unread ? "font-medium text-foreground" : "text-ink-secondary",
          )}
        >
          {describeTransition(entry.state, entry.id)}
        </p>
        <p className="text-caption text-ink-muted">
          <time dateTime={toIso(entry.at_unix)}>
            {formatRelativeTime(entry.at_unix)}
          </time>
          {` · ${entry.state}`}
          {exit ? ` · ${exit}` : ""}
        </p>
      </div>
      {important ? (
        <span className="flex shrink-0 items-center gap-1 pt-0.5 text-caption text-destructive">
          <TriangleAlert className="size-3.5" aria-hidden />
          Error
        </span>
      ) : null}
      {entry.unread ? (
        <>
          {/* The dot is decoration; the state is the text above (§55). */}
          <span className="sr-only">Unread</span>
          <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
        </>
      ) : null}
    </li>
  );
}

/** The machine-readable form of an event's timestamp, for `<time dateTime>`. */
function toIso(atUnix: number): string {
  if (!Number.isFinite(atUnix) || atUnix <= 0) {
    return "";
  }
  return new Date(atUnix * 1000).toISOString();
}
