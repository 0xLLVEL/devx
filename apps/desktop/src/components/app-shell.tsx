import {
  Boxes,
  Database,
  Globe,
  LayoutDashboard,
  Mail,
  Package,
  Settings,
  Share2,
  Stethoscope,
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
  { to: "/share", label: "Share", icon: <Share2 /> },
  { to: "/databases", label: "Databases", icon: <Database /> },
  { to: "/mail", label: "Mail", icon: <Mail /> },
  { to: "/diagnostics", label: "Diagnostics", icon: <Stethoscope /> },
  { to: "/settings", label: "Settings", icon: <Settings /> },
];

/** Application chrome: fixed sidebar plus scrollable content region. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <nav
        aria-label="Main navigation"
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3"
      >
        <div className="mb-4 flex items-center gap-2 px-2 pt-1">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            DX
          </span>
          <span className="text-sm font-semibold tracking-tight">DevX</span>
        </div>

        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors [&_svg]:size-4",
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="h-full flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
