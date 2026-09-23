import type { SiteStatus } from "@/lib/ipc";
import type { MenuItem } from "@/components/ui/menu";
import { SiteListItem } from "./SiteListItem";

type Props = {
  sites: SiteStatus[];
  selectedHostname: string | null;
  onSelect: (hostname: string) => void;
  buildActions: (site: SiteStatus) => MenuItem[];
  onOpenInBrowser: (site: SiteStatus) => void;
};

export function SiteList({ sites, selectedHostname, onSelect, buildActions, onOpenInBrowser }: Props) {
  return (
    <ul className="divide-y divide-border border-t border-border">
      {sites.map((site) => (
        <li key={site.hostname}>
          <SiteListItem
            site={site}
            isSelected={selectedHostname === site.hostname}
            actions={buildActions(site)}
            onSelect={() => onSelect(site.hostname)}
            onOpenInBrowser={() => onOpenInBrowser(site)}
          />
        </li>
      ))}
    </ul>
  );
}
