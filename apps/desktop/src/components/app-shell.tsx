import {
  Boxes,
  Database,
  FileText,
  Globe,
  LayoutDashboard,
  Mail,
  Package,
  Settings,
  Share2,
  Stethoscope,
  TerminalSquare,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard /> },
  { to: "/components", label: "Components", icon: <Boxes /> },
  { to: "/services", label: "Services", icon: <Package /> },
  { to: "/sites", label: "Sites", icon: <Globe /> },
  { to: "/logs", label: "Logs", icon: <FileText /> },
  { to: "/share", label: "Share", icon: <Share2 /> },
  { to: "/databases", label: "Databases", icon: <Database /> },
  { to: "/mail", label: "Mail", icon: <Mail /> },
  { to: "/diagnostics", label: "Diagnostics", icon: <Stethoscope /> },
  { to: "/terminal", label: "Terminal", icon: <TerminalSquare /> },
  { to: "/settings", label: "Settings", icon: <Settings /> },
];

/**
 * Application chrome: fixed sidebar plus scrollable content region.
 * Density-8 chrome (MASTER.md): tight nav rows, the wordmark set in the
 * data face, and the active marker kept — a real state signal.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <nav
        aria-label="Main navigation"
        className="flex w-52 shrink-0 flex-col gap-px border-r border-sidebar-border bg-sidebar p-2"
      >
        <div className="mb-3 flex items-baseline gap-2 px-2.5 pt-1.5 pb-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
            DevX
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">panel</span>
        </div>

        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "relative flex min-h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm transition-colors duration-150 cursor-pointer [&_svg]:size-4",
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* Active marker: a real state signal, not a stripe. */}
                {isActive ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                  />
                ) : null}
                {item.icon}
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <main className="h-full flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
