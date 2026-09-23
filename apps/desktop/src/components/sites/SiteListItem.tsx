import { useContextMenu, type MenuItem } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import type { SiteStatus } from "@/lib/ipc";
import { serverLabel } from "./site-helpers";

type Props = {
  site: SiteStatus;
  isSelected: boolean;
  actions: MenuItem[];
  onSelect: () => void;
  onOpenInBrowser: () => void;
};

export function SiteListItem({ site, isSelected, actions, onSelect }: Props) {
  const menu = useContextMenu({ label: `Actions for ${site.hostname}`, items: actions });

  return (
    <div
      onContextMenu={menu.onContextMenu}
      onClick={onSelect}
      className={cn(
        "group relative cursor-pointer px-4 py-3 transition-colors duration-150",
        isSelected ? "border-l-2 border-foreground bg-surface-2" : "border-l-2 border-transparent hover:bg-hover",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                isSelected ? "bg-foreground" : "bg-success",
              )}
            />
            <button
              type="button"
              className="truncate font-mono text-[13px] font-semibold cursor-pointer text-left text-foreground transition-colors"
              onClick={onSelect}
              aria-label={`Edit ${site.hostname}`}
            >
              {site.hostname}
            </button>
          </div>
          <p className="mt-1 pl-4 font-mono text-xs text-ink-muted">
            <span>{site.php_version ? `PHP ${site.php_version}` : "static"}</span>
            <span> · {serverLabel(site.web_server)} · </span>
            <span className={site.https ? "text-success" : undefined}>{site.https ? "HTTPS" : "HTTP"}</span>
          </p>
        </div>
      </div>
      {menu.panel}
    </div>
  );
}
