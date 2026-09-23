import { NavLink } from "react-router-dom";

import { NAV_SECTIONS } from "@/lib/navigation";
import { useNavCounts } from "@/lib/shell-data";
import { cn } from "@/lib/utils";

/**
 * Sidebar (preview `.side`): plain text rows, no icons, hairline left marker
 * on the active item, section labels in uppercase tracking. Fixed 220px —
 * the mockup has no collapse affordance.
 *
 * Counts come from real queries only: before the backend answers, a row shows
 * no number rather than a guess.
 */
export function Sidebar({ className }: { className?: string }) {
  const counts = useNavCounts();

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-y-auto border-r border-line-subtle bg-sidebar px-3 py-4",
        className,
      )}
    >
      {NAV_SECTIONS.map((section) => (
        <div key={section.id} className="mb-2 last:mb-0">
          <p className="px-3 pt-4 pb-2 text-xs tracking-[0.08em] text-ink-muted uppercase first:pt-1">
            {section.label}
          </p>
          <ul>
            {section.items.map((item) => {
              const count = counts[item.to];
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) =>
                      cn(
                        "flex min-h-9 cursor-pointer items-center gap-2.5 border-l-2 border-transparent px-3 py-2.5 text-sm transition-[background-color,border-color,color] duration-150",
                        isActive
                          ? "border-l-foreground bg-surface-2 font-semibold text-foreground"
                          : "text-ink-muted hover:bg-hover hover:text-ink-secondary",
                      )
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {count === undefined ? null : (
                      <span
                        className={cn(
                          "font-mono text-xs",
                          "text-ink-muted",
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* The PROJECTS block of §5 is deliberately absent: the backend has no
          project concept yet, and rows for it would be invented data. */}
    </nav>
  );
}
