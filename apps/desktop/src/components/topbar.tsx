import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { themeLabel, nextTheme, useTheme } from "@/components/theme-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ipc } from "@/lib/ipc";
import { findNavItem, findNavSection } from "@/lib/navigation";
import { useSystemStatus } from "@/lib/shell-data";
import { cn } from "@/lib/utils";

/**
 * Topbar (§6): page context on the left, the global search trigger in the
 * middle, the terminal, notification, settings and theme slots on the right.
 * 64px tall.
 *
 * It is an opaque surface rather than glass: §14 keeps the blur treatment for
 * floating layers and asks for real surfaces everywhere else.
 */
export function Topbar({
  collapsed,
  onToggleSidebar,
  onOpenSearch,
  terminalOpen,
  onToggleTerminal,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  /** Whether the bottom terminal drawer (§31) is showing. */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
  const { pathname } = useLocation();
  const item = findNavItem(pathname);
  const section = findNavSection(pathname);
  // §31: the Terminal page already shows the console, so the drawer has
  // nothing to add there — and its toggle is not offered there either (§56: no
  // control that does nothing).
  const showTerminalToggle = pathname !== "/terminal";

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line-subtle bg-topbar px-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleSidebar}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </Tooltip>

        <div className="min-w-0">
          {section ? (
            <p className="truncate text-caption text-ink-muted">{section.label}</p>
          ) : null}
          <p className="truncate text-sm font-medium text-foreground">
            {item?.label ?? "DevX"}
          </p>
        </div>
      </div>

      {/* §6: the search trigger sits in the middle and names its own shortcut. */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="flex h-9 w-full max-w-md items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 text-left text-sm text-ink-muted transition-colors duration-150 hover:border-line-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Search anything...</span>
        <kbd className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-caption text-ink-muted">
          Ctrl K
        </kbd>
      </button>

      <div className="flex flex-1 items-center justify-end gap-1">
        {showTerminalToggle ? (
          <Tooltip label={`Terminal drawer (Ctrl T)`}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Terminal drawer"
              aria-expanded={terminalOpen}
              onClick={onToggleTerminal}
            >
              <TerminalSquare />
            </Button>
          </Tooltip>
        ) : null}
        <NotificationSlot />
        <Tooltip label="Settings">
          {/* A link, not a button wrapping a link: nested interactive elements
              break keyboard navigation. */}
          <Link
            to="/settings"
            aria-label="Settings"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <Settings />
          </Link>
        </Tooltip>
        <ThemeSlot />
      </div>
    </header>
  );
}

/**
 * Notifications (§98).
 *
 * The badge counts services that are actually failing, and the panel lists
 * the state transitions Rust recorded. There is no "mark all read" and no
 * "clear": the backend has no such command, and a button that does nothing is
 * worse than a missing one.
 */
function NotificationSlot() {
  const status = useSystemStatus();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const events = useQuery({
    queryKey: ["events", "recent", 20],
    queryFn: () => ipc.eventsRecent(20),
    // Nothing is fetched until the panel is opened (§101).
    enabled: open,
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
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const failed = status?.failedCount ?? 0;
  const label =
    failed > 0
      ? `Notifications: ${failed} service${failed === 1 ? "" : "s"} failed`
      : "Notifications";

  const entries = events.data ?? [];

  return (
    <div ref={container} className="relative">
      <Tooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="relative"
        >
          <Bell />
          {failed > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive font-mono text-[10px] text-destructive-foreground"
            >
              {failed}
            </span>
          ) : null}
        </Button>
      </Tooltip>

      {open ? (
        <div className="glass-surface absolute right-0 z-50 mt-2 w-[360px] rounded-lg p-1 shadow-lg">
          <p className="px-3 py-2 text-caption tracking-wide text-ink-muted uppercase">
            Recent service events
          </p>
          {events.isPending ? (
            <p className="px-3 py-2 text-sm text-ink-muted" role="status">
              Loading events…
            </p>
          ) : null}
          {events.isError ? (
            // §39: the same titled callout and retry every page uses, so the
            // panel reports the failure instead of printing the backend's own
            // string as the whole message.
            <div className="p-2">
              <Callout variant="destructive" title="Could not read the event log.">
                <p>
                  {events.error instanceof Error
                    ? events.error.message
                    : "The backend did not answer."}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void events.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            </div>
          ) : null}
          {!events.isPending && !events.isError && entries.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ink-muted">
              No service events recorded yet.
            </p>
          ) : null}
          {entries.length > 0 ? (
            <ul className="max-h-72 overflow-y-auto">
              {entries.map((event) => (
                <li
                  key={`${event.at_unix}-${event.id}-${event.state}`}
                  className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-hover"
                >
                  <span className="min-w-0">
                    <span
                      className="block truncate font-mono text-xs"
                      title={event.id}
                    >
                      {event.id}
                    </span>
                    <span className="block text-caption text-ink-muted">
                      {formatEventTime(event.at_unix)}
                      {event.exit ? ` · ${event.exit}` : ""}
                    </span>
                  </span>
                  <EventState state={event.state} />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="border-t border-line-subtle px-3 py-2">
            <Link
              to="/services"
              onClick={() => setOpen(false)}
              className="text-xs text-primary hover:underline"
            >
              Open Services
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Colour is never the only signal (§55): dot plus the state's own name. */
function EventState({ state }: { state: string }) {
  const tone =
    state === "running"
      ? "bg-success"
      : state === "failed"
        ? "bg-destructive"
        : state === "starting" || state === "stopping"
          ? "bg-warning"
          : "bg-muted-foreground/40";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-secondary">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {state}
    </span>
  );
}

function formatEventTime(atUnix: number): string {
  const elapsed = Math.max(0, Date.now() / 1000 - atUnix);
  if (elapsed < 60) {
    return "just now";
  }
  if (elapsed < 3600) {
    return `${Math.floor(elapsed / 60)} min ago`;
  }
  if (elapsed < 86400) {
    return `${Math.floor(elapsed / 3600)} h ago`;
  }
  return `${Math.floor(elapsed / 86400)} d ago`;
}

const THEME_ICONS: Record<string, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** §46: the three choices, cycled from the chrome. */
function ThemeSlot() {
  const theme = useTheme();
  const toast = useToast();
  const Icon = THEME_ICONS[theme.theme] ?? Monitor;

  useEffect(() => {
    if (theme.error) {
      toast.error("Could not save the theme", {
        details: theme.error instanceof Error ? theme.error.message : undefined,
      });
    }
  }, [theme.error, toast]);

  const label = `Theme: ${themeLabel(theme.theme)}${
    theme.theme === "system" ? ` (${theme.resolved})` : ""
  }`;

  return (
    <Tooltip label={theme.ready ? `${label} — click to change` : "Theme"}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={theme.ready ? `${label}, change theme` : "Change theme"}
        disabled={!theme.ready || theme.saving}
        onClick={() => theme.setTheme(nextTheme(theme.theme))}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}
