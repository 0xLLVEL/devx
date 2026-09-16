import {
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
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { NotificationSlot } from "@/components/notification-center";
import { themeLabel, nextTheme, useTheme } from "@/components/theme-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { findNavItem, findNavSection } from "@/lib/navigation";

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
