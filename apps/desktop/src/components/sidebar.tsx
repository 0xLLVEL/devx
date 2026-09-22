import { Link, NavLink } from "react-router-dom";

import { Tooltip } from "@/components/ui/tooltip";
import { NAV_SECTIONS } from "@/lib/navigation";
import { useServiceMetrics } from "@/lib/queries";
import { useNavCounts, useSystemStatus, type SystemStatus } from "@/lib/shell-data";
import { cn } from "@/lib/utils";

/** Vercel flat — final 200/56, flat active */
const EXPANDED_WIDTH = "200px";
const COLLAPSED_WIDTH = "56px";

/**
 * Sidebar (§5).
 *
 * Expanded 200px, collapsed 56px, 220ms on the §52 easing. The active item is
 * marked four ways at once — raised background, thin accent line, accent icon,
 * high-contrast text — so the state never rests on colour alone (§55). Counts
 * come from real queries only: before the backend answers, a row shows no
 * number rather than a guess (§131 Rule 17).
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const counts = useNavCounts();
  const status = useSystemStatus();
  // Subscribing a second time is free: same key, same cache entry. It is what
  // lets the footer tell "still reading" apart from "could not read".
  const metrics = useServiceMetrics();

  return (
    <nav
      aria-label="Main navigation"
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      className="flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-[220ms] ease-standard"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="mb-3 last:mb-0">
            {collapsed ? (
              <div aria-hidden className="mx-2 mb-2 h-px bg-gradient-to-r from-transparent via-line-subtle to-transparent" />
            ) : (
              <p className="px-2.5 pb-1 text-caption tracking-wide text-ink-muted uppercase">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const count = counts[item.to];
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    {...(collapsed ? { "aria-label": item.label } : {})}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md text-nav transition-[background-color,color] duration-150 [&_svg]:size-4 [&_svg]:shrink-0",
                        collapsed ? "justify-center px-2" : "px-2.5",
                        isActive
                          ? "bg-hover font-medium text-foreground"
                          : "text-ink-muted hover:bg-hover/60 hover:text-ink-secondary",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          aria-hidden
                          className={cn(
                            "transition-colors duration-150",
                            isActive ? "text-foreground" : "text-ink-muted group-hover:text-ink-secondary",
                          )}
                        />
                        {collapsed ? null : (
                          <>
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {count === undefined ? null : (
                              <span
                                className={cn(
                                  "font-mono text-caption",
                                  isActive ? "text-ink-secondary" : "text-ink-disabled",
                                )}
                              >
                                {count}
                              </span>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                );

                return (
                  <li key={item.to}>
                    {/* Collapsed rows are icon-only, so they carry a tooltip —
                        on hover and on keyboard focus alike (§94). */}
                    {collapsed ? (
                      <Tooltip label={item.label}>{link}</Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* The PROJECTS block of §5 is deliberately absent: the backend has no
          project concept yet, and rows for it would be invented data. */}
      <SystemFooter
        status={status}
        unreadable={metrics.isError}
        collapsed={collapsed}
      />
    </nav>
  );
}

const DOT_TONE: Record<SystemStatus["state"], string> = {
  ready: "bg-success ring-2 ring-success/20 animate-[status-pulse_3s_ease-in-out_infinite]",
  attention: "bg-warning ring-2 ring-warning/25",
  error: "bg-destructive ring-2 ring-destructive/30",
  starting: "animate-pulse bg-warning ring-2 ring-warning/25",
  stopping: "animate-pulse bg-warning ring-2 ring-warning/25",
  unknown: "bg-muted-foreground/40",
};

/**
 * Bottom-left system status (§118), linking to the page that holds the detail
 * behind the verdict. Nothing renders until real metrics exist: an empty
 * "System Ready" would be a claim the backend never made.
 */
/**
 * §118/§120 #10: the system state is never hidden. A read that failed leaves
 * the footer saying so rather than removing it, because a vanished footer
 * looks the same as a healthy one on a quiet machine. A read still in flight
 * is different, and stays absent: there is no state to report yet, and
 * inventing one would be worse than the space it fills (§131 Rule 17).
 */
const UNREADABLE_STATUS: SystemStatus = {
  state: "unknown",
  label: "Status unavailable",
  detail: "The service metrics could not be read.",
  failedCount: 0,
};

function SystemFooter({
  status,
  unreadable,
  collapsed,
}: {
  status: SystemStatus | null;
  unreadable: boolean;
  collapsed: boolean;
}) {
  const resolved = status ?? (unreadable ? UNREADABLE_STATUS : null);
  if (!resolved) {
    return null;
  }

  const link = (
    <Link
      to="/diagnostics"
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        collapsed && "justify-center px-2",
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", DOT_TONE[resolved.state])}
      />
      {collapsed ? (
        <span className="sr-only">
          {resolved.label}: {resolved.detail}
        </span>
      ) : (
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">
            {resolved.label}
          </span>
          <span className="block truncate text-caption text-ink-muted">
            {resolved.detail}
          </span>
        </span>
      )}
    </Link>
  );

  return (
    <div className="border-t border-line-subtle p-2">
      {collapsed ? (
        <Tooltip label={`${resolved.label} — ${resolved.detail}`} side="top">
          {link}
        </Tooltip>
      ) : (
        link
      )}
    </div>
  );
}
