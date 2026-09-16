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
  type LucideIcon,
} from "lucide-react";

/**
 * The route registry.
 *
 * Routes live in `App.tsx`; this module only describes them for the chrome —
 * sidebar labels, the topbar's page context, and the command palette's
 * navigation group — so those three can never disagree about what a route is
 * called. Routes that do not exist yet are not listed here, and are not shown
 * anywhere: a nav item that leads to a 404 is worse than no nav item.
 */

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * Extra search terms (§57 ranks by name, then type, then tags). Only terms
   * that describe what the page really does — never aspirational features.
   */
  keywords: string[];
  /**
   * §56's `Alt`+digit binding, when the shell really installs one. The shell
   * builds its keymap and the pages label their shortcut hints from this single
   * field, so a hint can never advertise a key that does nothing.
   */
  shortcut?: string;
};

export type NavSection = {
  id: string;
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "environment",
    label: "Environment",
    items: [
      {
        to: "/",
        label: "Dashboard",
        icon: LayoutDashboard,
        keywords: ["home", "overview", "status", "monitor"],
        shortcut: "1",
      },
      {
        to: "/components",
        label: "Components",
        icon: Boxes,
        keywords: ["install", "runtime", "version", "php", "node", "catalog"],
        shortcut: "2",
      },
      {
        to: "/services",
        label: "Services",
        icon: Package,
        keywords: ["start", "stop", "restart", "process", "worker", "cron"],
        shortcut: "3",
      },
      {
        to: "/sites",
        label: "Sites",
        icon: Globe,
        keywords: ["host", "domain", "https", "certificate", "vhost"],
        shortcut: "4",
      },
      {
        to: "/databases",
        label: "Databases",
        icon: Database,
        keywords: ["query", "sql", "mysql", "postgres", "redis", "backup"],
        shortcut: "5",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        to: "/terminal",
        label: "Terminal",
        icon: TerminalSquare,
        keywords: ["command", "shell", "path", "run"],
      },
      {
        to: "/logs",
        label: "Logs",
        icon: FileText,
        keywords: ["output", "error", "tail", "file"],
      },
      {
        to: "/share",
        label: "Share",
        icon: Share2,
        keywords: ["tunnel", "public", "url", "cloudflare"],
      },
      {
        to: "/mail",
        label: "Mail",
        icon: Mail,
        keywords: ["smtp", "inbox", "catch", "message"],
      },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      {
        to: "/diagnostics",
        label: "Diagnostics",
        icon: Stethoscope,
        keywords: ["doctor", "check", "repair", "health", "dns", "certificate"],
      },
      {
        to: "/settings",
        label: "Settings",
        icon: Settings,
        keywords: ["config", "preferences", "theme", "profile", "port"],
      },
    ],
  },
];

/** Every nav item, in sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap(
  (section) => section.items,
);

/**
 * §56's `Alt`+digit bindings as a key → route map. Derived from the registry
 * rather than written out again, so the shell's keymap cannot drift from the
 * shortcut hints the pages render.
 */
export const NAV_SHORTCUTS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.filter((item) => item.shortcut !== undefined).map((item) => [
    item.shortcut as string,
    item.to,
  ]),
);

/** How a page should label a route's shortcut, e.g. `Alt 2`; undefined when it has none. */
export function navShortcutLabel(to: string): string | undefined {
  const shortcut = NAV_ITEMS.find((item) => item.to === to)?.shortcut;
  return shortcut === undefined ? undefined : `Alt ${shortcut}`;
}

/**
 * The nav item a pathname belongs to. Exact matches win; otherwise the
 * longest matching prefix, so nested routes keep their section highlighted.
 */
export function findNavItem(pathname: string): NavItem | undefined {
  const exact = NAV_ITEMS.find((item) => item.to === pathname);
  if (exact) {
    return exact;
  }
  return NAV_ITEMS.filter(
    (item) => item.to !== "/" && pathname.startsWith(`${item.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];
}

/** The section a nav item belongs to, for the topbar's context line. */
export function findNavSection(pathname: string): NavSection | undefined {
  const item = findNavItem(pathname);
  if (!item) {
    return undefined;
  }
  return NAV_SECTIONS.find((section) =>
    section.items.some((candidate) => candidate.to === item.to),
  );
}
