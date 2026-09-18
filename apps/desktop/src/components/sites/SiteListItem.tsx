import { ChevronRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OverflowMenu, useContextMenu, type MenuItem } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SiteStatus } from "@/lib/ipc";
import { serverLabel, siteUrl } from "./site-helpers";

type Props = {
  site: SiteStatus;
  isSelected: boolean;
  isFailed?: boolean;
  actions: MenuItem[];
  onSelect: () => void;
  onOpenInBrowser: () => void;
};

export function SiteListItem({ site, isSelected, isFailed = false, actions, onSelect, onOpenInBrowser }: Props) {
  const menu = useContextMenu({ label: `Actions for ${site.hostname}`, items: actions });

  return (
    <tr
      onContextMenu={menu.onContextMenu}
      onClick={onSelect}
      className={cn(
        "group cursor-pointer transition-colors duration-150 rounded-md",
        isSelected ? "bg-surface-2/90 text-foreground font-medium" : "hover:bg-surface-2/40 text-muted-foreground hover:text-foreground",
      )}
    >
      <td className="px-2.5 py-2 rounded-md" colSpan={2}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                isFailed ? "bg-destructive ring-2 ring-destructive/20" : isSelected ? "bg-foreground/80 ring-2 ring-foreground/20" : "bg-[#10b981]",
              )}
            />
            <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <button
                type="button"
                className="truncate font-mono text-xs font-semibold cursor-pointer text-left text-foreground hover:text-primary transition-colors"
                onClick={onSelect}
                aria-label={`Edit ${site.hostname}`}
              >
                {site.hostname}
              </button>
              <div className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                {site.php_version ? <span>PHP {site.php_version}</span> : <span>static</span>}
                <span>·</span>
                <span>{serverLabel(site.web_server)}</span>
                <span>·</span>
                <span>{site.https ? "https" : "http"}</span>
                {site.https ? <span className="sr-only">HTTPS</span> : null}
              </div>
              <span className="sr-only" data-selectable>{siteUrl(site)}</span>
              {site.php_endpoint ? <span className="sr-only" data-selectable>fastcgi_pass {site.php_endpoint}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
              <Tooltip label={`Open ${site.hostname} in browser`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); onOpenInBrowser(); }}
                  aria-label={`Open ${site.hostname} in browser`}
                >
                  <ExternalLink className="size-3" />
                </Button>
              </Tooltip>
              <OverflowMenu label={`More actions for ${site.hostname}`} items={actions} />
            </div>
            {isFailed ? (
              <span className="rounded-full border border-destructive/40 bg-destructive/15 px-1.5 py-0.2 text-[10px] font-medium text-destructive">Failed</span>
            ) : (
              <ChevronRight className={cn("size-3.5 transition-transform", isSelected ? "text-primary" : "text-muted-foreground/40 group-hover:text-muted-foreground")} />
            )}
          </div>
        </div>
      </td>
      {menu.panel}
    </tr>
  );
}
