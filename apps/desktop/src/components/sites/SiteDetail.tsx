import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { OverflowMenu } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import type { SiteStatus, CaStatus, DnsStatus } from "@/lib/ipc";
import { serverLabel, siteUrl } from "./site-helpers";
import { Globe } from "lucide-react";

type TabId = "overview" | "aliases" | "env" | "requests" | "auth";

type Props = {
  site: SiteStatus | null;
  tab: TabId;
  onTabChange: (t: TabId) => void;
  phpChoices: string[];
  dns?: DnsStatus;
  ca?: CaStatus;
  dnsSuffix?: string;
  configDnsMode?: string;
  onOpenInBrowser: (s: SiteStatus) => void;
  onOpenFolder: (s: SiteStatus) => void;
  onRemove: (s: SiteStatus) => void;
  onCopyUrl: (s: SiteStatus) => void;
  pingSlot: React.ReactNode;
  overviewSlot: React.ReactNode;
  aliasesSlot: React.ReactNode;
  envSlot: React.ReactNode;
  requestsSlot: React.ReactNode;
  authSlot: React.ReactNode;
};

const TABS: Array<[TabId, (s: SiteStatus) => string]> = [
  ["overview", () => "Overview"],
  ["aliases", (s) => `Aliases${s.aliases.length > 0 ? ` (${s.aliases.length})` : ""}`],
  ["env", (s) => `Environment${Object.keys(s.env).length > 0 ? ` (${Object.keys(s.env).length})` : ""}`],
  ["requests", () => "Requests"],
  ["auth", () => "Auth"],
];

export function SiteDetail({ site, tab, onTabChange, onOpenInBrowser, onOpenFolder, onRemove, onCopyUrl, pingSlot, overviewSlot, aliasesSlot, envSlot, requestsSlot, authSlot, dns, ca, configDnsMode, dnsSuffix }: Props) {
  if (!site) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <EmptyState icon={<Globe />} title="No site selected." description="Choose a site from the list on the left to view its overview, DNS, behavior, aliases and logs." />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4 p-6 pb-4">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate font-mono text-2xl font-bold tracking-tight text-foreground"><span className="sr-only">Site </span>{site.hostname}</h2>
          <a href={siteUrl(site)} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void onOpenInBrowser(site); }} className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary transition-colors">{siteUrl(site)}</a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pingSlot}
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-medium border-border/80 bg-surface-1 hover:bg-surface-2" onClick={() => void onOpenInBrowser(site)} aria-label={`Open ${site.hostname} in browser`}>
            <ExternalLink className="size-3.5 text-muted-foreground" />Open
          </Button>
          <OverflowMenu
            label={`More actions for ${site.hostname}`}
            items={[
              { id: "folder", label: "Open folder", onSelect: () => void onOpenFolder(site) } as never,
              { id: "copy", label: "Copy URL", onSelect: () => onCopyUrl(site) } as never,
              { id: "remove", label: "Remove site", destructive: true, onSelect: () => onRemove(site) } as never,
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 border-y border-border/60 px-6 py-3.5 sm:grid-cols-3 lg:grid-cols-6">
        <div><span className="block text-[11px] text-muted-foreground">Status</span><span className="mt-0.5 block text-xs font-medium text-foreground">Stopped</span></div>
        <div><span className="block text-[11px] text-muted-foreground">Document root</span><span className="mt-0.5 block truncate font-mono text-xs text-foreground" title={site.docroot} data-selectable>{site.docroot}</span></div>
        <div><span className="block text-[11px] text-muted-foreground">Runtime</span><span className="mt-0.5 block text-xs font-medium text-foreground">{site.php_version ? `PHP ${site.php_version}` : "Static"}</span>{site.php_endpoint ? <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" data-selectable>fastcgi_pass {site.php_endpoint}</span> : null}</div>
        <div><span className="block text-[11px] text-muted-foreground">Web server</span><span className="mt-0.5 block text-xs font-medium lowercase text-foreground">{serverLabel(site.web_server)}</span></div>
        <div><span className="block text-[11px] text-muted-foreground">HTTPS</span><span className="mt-0.5 block text-xs font-medium text-foreground">{site.https ? "On" : "Off"}</span></div>
        <div><span className="block text-[11px] text-muted-foreground">Aliases</span><span className="mt-0.5 block text-xs font-medium text-foreground">{site.aliases.length > 0 ? `${site.aliases.length} alias${site.aliases.length === 1 ? "" : "es"}` : "None"}</span></div>
      </div>

      <div className="border-b border-border/60 px-6">
        <div role="tablist" aria-label="Site sections" className="flex gap-6">
          {TABS.map(([id, labelFn]) => (
            <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => onTabChange(id)} className={cn("relative cursor-pointer py-3 text-xs font-medium transition-colors duration-150", tab === id ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted-foreground hover:text-foreground")}>
              {labelFn(site)}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {tab === "overview" && (
          <div className="space-y-6">
            <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-1/40">
              <div className="flex items-center justify-between border-b border-border/60 bg-surface-2/20 px-4 py-2.5">
                <h3 className="text-xs font-semibold text-foreground">Recent transitions</h3>
                <Link to="/logs" className="flex items-center gap-1 text-xs text-primary hover:underline">All logs</Link>
              </div>
              <div className="divide-y divide-border/50 text-xs">
                <div className="flex items-center justify-between px-4 py-2.5"><span className="font-mono text-foreground/90">{site.hostname}</span><span className="text-muted-foreground">stopped</span><span className="text-muted-foreground/70">2 min ago</span></div>
                <div className="flex items-center justify-between px-4 py-2.5"><span className="font-mono text-foreground/90">{site.hostname}</span><span className="text-muted-foreground">restart requested</span><span className="text-muted-foreground/70">18 min ago</span></div>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-1/40">
              <div className="border-b border-border/60 bg-surface-2/20 px-4 py-2.5"><h3 className="text-xs font-semibold text-foreground">Local DNS</h3></div>
              <div className="divide-y divide-border/50 font-mono text-xs">
                <div className="flex items-center justify-between px-4 py-2.5"><span className="text-muted-foreground">resolve</span><span className="text-foreground">{configDnsMode === "hosts_file" ? "127.0.0.1 (hosts entry)" : `127.0.0.1 (*.${dnsSuffix ?? dns?.suffix ?? "test"} resolver)`}</span></div>
                <div className="flex items-center justify-between px-4 py-2.5"><span className="text-muted-foreground">certificate</span><span className="text-foreground">{site.https ? (ca?.trusted ? "valid (DevX CA)" : "issued (CA untrusted)") : "not issued"}</span></div>
              </div>
            </div>
            {overviewSlot}
          </div>
        )}
        {tab === "aliases" && <div className="max-w-2xl">{aliasesSlot}</div>}
        {tab === "env" && <div className="max-w-2xl">{envSlot}</div>}
        {tab === "requests" && <div className="max-w-4xl">{requestsSlot}</div>}
        {tab === "auth" && <div className="max-w-2xl">{authSlot}</div>}
      </div>
    </div>
  );
}
