import { Monitor, Moon, Settings, Sun, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { NotificationSlot } from "@/components/notification-center";
import { themeLabel, nextTheme, useTheme } from "@/components/theme-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ipc } from "@/lib/ipc";
import { navCrumb } from "@/lib/navigation";
import { useSystemStatus, type SystemState } from "@/lib/shell-data";
import { useServiceMetrics } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Topbar (preview `.top`): brand · crumbs · status voice · search · actions.
 * Square controls, hairline borders, no logo mark — a dot and the wordmark.
 */

const STATUS_DOT: Record<SystemState, string> = {
  ready: "bg-success",
  attention: "bg-warning",
  error: "bg-destructive",
  starting: "bg-warning",
  stopping: "bg-warning",
  unknown: "bg-muted-foreground/40",
};

const UNREADABLE_LABEL = "Status unavailable";
const UNREADABLE_DETAIL = "The service metrics could not be read.";

export function Topbar({
  className,
  onOpenSearch,
}: {
  className?: string;
  onOpenSearch: () => void;
}) {
  const appInfo = useQuery({ queryKey: ["app-info"], queryFn: ipc.appInfo });
  const location = useLocation();
  const status = useSystemStatus();
  const metrics = useServiceMetrics();
  const crumb = navCrumb(location.pathname);

  // §120 #10: a failed read stays visible; a read still in flight stays absent.
  const resolved =
    status ??
    (metrics.isError
      ? {
          state: "unknown" as SystemState,
          label: UNREADABLE_LABEL,
          detail: UNREADABLE_DETAIL,
          failedCount: 0,
        }
      : null);

  return (
    <header
      className={cn(
        "flex h-[72px] shrink-0 items-center gap-4 border-b border-line-subtle bg-topbar px-8",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5" aria-label="DEVX">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            resolved ? STATUS_DOT[resolved.state] : "bg-muted-foreground/40",
          )}
        />
        <span className="font-mono text-[15px] font-semibold tracking-tight text-foreground">
          DEVX
        </span>
        {appInfo.data ? (
          <span className="text-[11px] text-ink-muted">v{appInfo.data.version}</span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 border-l border-border pl-4 text-[13px] whitespace-nowrap text-ink-muted">
        {crumb.section ? (
          <>
            <span>{crumb.section}</span>
            <span className="text-ink-muted/60">/</span>
          </>
        ) : null}
        <b className="font-semibold text-foreground">{crumb.page}</b>
      </div>

      {resolved ? (
        <div className="flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-muted">
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[resolved.state])}
          />
          <span>{resolved.label}</span>
          {resolved.failedCount > 0 ? (
            <span> · {resolved.failedCount} failed</span>
          ) : null}
          {!status && metrics.isError ? (
            <span className="text-ink-muted">{UNREADABLE_DETAIL}</span>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onOpenSearch}
        className="ml-auto flex h-9 min-w-40 items-center gap-3 border border-line-strong bg-transparent px-4 text-left text-[13px] text-ink-muted transition-colors duration-150 hover:border-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1 truncate">Search anything...</span>
        <kbd className="border border-line-strong px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          Ctrl K
        </kbd>
      </button>

      <div className="flex items-center gap-1">
        <NotificationSlot />
        <ThemeSlot />
        <Tooltip label="Settings">
          {/* A link, not a button wrapping a link: nested interactive elements
              break keyboard navigation. */}
          <Link
            to="/settings"
            aria-label="Settings"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "border-transparent text-ink-muted hover:border-line-strong hover:text-foreground",
            )}
          >
            <Settings />
          </Link>
        </Tooltip>
      </div>
    </header>
  );
}

const THEME_ICONS: Record<string, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** The three theme choices, cycled from the chrome. */
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
        className="border-transparent text-ink-muted hover:border-line-strong hover:text-foreground"
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}
