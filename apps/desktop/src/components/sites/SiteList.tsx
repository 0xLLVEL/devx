import type { SiteStatus } from "@/lib/ipc";
import type { MenuItem } from "@/components/ui/menu";
import { SiteListItem } from "./SiteListItem";

type Props = {
  attentionSites: SiteStatus[];
  normalSites: SiteStatus[];
  selectedHostname: string | null;
  onSelect: (hostname: string) => void;
  buildActions: (site: SiteStatus) => MenuItem[];
  onOpenInBrowser: (site: SiteStatus) => void;
};

export function SiteList({ attentionSites, normalSites, selectedHostname, onSelect, buildActions, onOpenInBrowser }: Props) {
  return (
    <table className="w-full border-separate border-spacing-y-0.5 text-left">
      <tbody>
        {attentionSites.length > 0 ? (
          <>
            <tr><td colSpan={2} className="px-2 pt-2 pb-1"><span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Needs attention</span></td></tr>
            {attentionSites.map((site) => (
              <SiteListItem
                key={site.hostname}
                site={site}
                isSelected={selectedHostname === site.hostname}
                isFailed
                actions={buildActions(site)}
                onSelect={() => onSelect(site.hostname)}
                onOpenInBrowser={() => onOpenInBrowser(site)}
              />
            ))}
          </>
        ) : null}
        <tr><td colSpan={2} className="px-2 pt-2.5 pb-1"><span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Sites</span></td></tr>
        {normalSites.map((site) => (
          <SiteListItem
            key={site.hostname}
            site={site}
            isSelected={selectedHostname === site.hostname}
            isFailed={false}
            actions={buildActions(site)}
            onSelect={() => onSelect(site.hostname)}
            onOpenInBrowser={() => onOpenInBrowser(site)}
          />
        ))}
      </tbody>
    </table>
  );
}
