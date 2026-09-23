import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { OverflowMenu } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import type { SiteStatus, CaStatus, DnsStatus, DnsMode, PhpPoolStatus } from "@/lib/ipc";
import { PingButton, type PingResult } from "./PingButton";
import { RoutePanel } from "./RoutePanel";
import { serverLabel, serverLoopback, siteUrl } from "./site-helpers";
import { Globe } from "lucide-react";

type TabId = "overview" | "aliases" | "env" | "requests" | "auth";

type Props = {
  site: SiteStatus | null;
  tab: TabId;
  onTabChange: (t: TabId) => void;
  dns?: DnsStatus;
  ca?: CaStatus;
  mode?: DnsMode;
  pool?: PhpPoolStatus | null;
  onOpenInBrowser: (s: SiteStatus) => void;
  onOpenFolder: (s: SiteStatus) => void;
  onRemove: (s: SiteStatus) => void;
  onCopyUrl: (s: SiteStatus) => void;
  /** Network status strip, rendered under the headrow (preview Frame 3). */
  networkStrip?: React.ReactNode;
  overviewSlot: React.ReactNode;
  aliasesSlot: React.ReactNode;
  envSlot: React.ReactNode;
  requestsSlot: React.ReactNode;
  authSlot: React.ReactNode;
};

const TABS: Array<[TabId, (s: SiteStatus) => string, (s: SiteStatus) => number | null]> = [
  ["overview", () => "Overview", () => null],
  ["aliases", () => "Aliases", (s) => s.aliases.length],
  ["env", () => "Env", (s) => Object.keys(s.env).length],
  ["requests", () => "Requests", () => null],
  ["auth", () => "Auth", () => null],
];

function KvHead({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 text-xs tracking-[0.08em] text-ink-muted uppercase first:mt-0">{children}</div>;
}

function Kv({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-4 border-b border-border/50 py-2 last:border-0">
      <dt className="w-36 shrink-0 text-[13px] text-ink-muted">{label}</dt>
      <dd className={cn("min-w-0 flex-1 truncate text-[13px] text-foreground", mono && "font-mono")} title={typeof value === "string" ? value : undefined} data-selectable={mono ? true : undefined}>
        {value}
      </dd>
    </div>
  );
}

export function SiteDetail({ site, tab, onTabChange, onOpenInBrowser, onOpenFolder, onRemove, onCopyUrl, networkStrip, overviewSlot, aliasesSlot, envSlot, requestsSlot, authSlot, dns, ca, mode, pool }: Props) {
  const [ping, setPing] = useState<PingResult | null>(null);
  useEffect(() => { setPing(null); }, [site?.hostname]);

  if (!site) {
    return (
      <div className="flex flex-col">
        {networkStrip ?? null}
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <EmptyState icon={<Globe />} title="No site selected." description="Choose a site from the list on the left to view its overview, DNS, behavior, aliases and logs." />
        </div>
      </div>
    );
  }

  const aliasesText = site.aliases.length > 0 ? site.aliases.join(", ") : "None";
  const cert = !site.https
    ? "Not issued"
    : ca?.trusted === true
      ? "DevX CA · valid"
      : ca?.trusted === false
        ? "Issued · CA untrusted"
        : "Issued · CA unknown";
  const dnsValue =
    mode === "hosts_file" || mode === undefined
      ? `${site.hostname} → ${serverLoopback(site.web_server)} · hosts file`
      : `${site.hostname} → ${serverLoopback(site.web_server)} · resolver .${dns?.suffix ?? "test"}`;

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="text-[13px] tracking-[0.08em] text-ink-muted uppercase">
            {serverLabel(site.web_server)} · {site.php_version ? `PHP ${site.php_version}` : "Static"} ·{" "}
            <span className={site.https ? "text-success" : undefined}>{site.https ? "HTTPS" : "HTTP"}</span>
            {ping && ping.status !== null ? (
              <>
                {" · "}
                <span className={ping.status < 500 ? "text-success" : "text-warning"}>
                  {ping.status}{ping.latency_ms !== null ? ` · ${ping.latency_ms}ms` : ""}
                </span>
              </>
            ) : null}
          </p>
          <h2 className="truncate font-mono text-h1 font-semibold tracking-tight text-foreground"><span className="sr-only">Site </span>{site.hostname}</h2>
          <p className="font-mono text-[13px] text-ink-muted">
            <a href={siteUrl(site)} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void onOpenInBrowser(site); }} className="hover:text-foreground transition-colors" data-selectable>{siteUrl(site)}</a>
            {" → "}
            <span data-selectable>{site.docroot}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <PingButton hostname={site.hostname} onResult={setPing} />
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[13px]" onClick={() => onCopyUrl(site)} aria-label={`Copy URL for ${site.hostname}`}>
            <Copy className="size-3.5" />Copy URL
          </Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[13px]" onClick={() => void onOpenInBrowser(site)} aria-label={`Open ${site.hostname} in browser`}>
            <ExternalLink className="size-3.5" />Open
          </Button>
          <OverflowMenu
            label={`More actions for ${site.hostname}`}
            items={[
              { id: "folder", label: "Open folder", onSelect: () => void onOpenFolder(site) } as never,
              { id: "remove", label: "Remove site", destructive: true, onSelect: () => onRemove(site) } as never,
            ]}
          />
        </div>
      </div>

      {networkStrip ?? null}

      <RoutePanel site={site} dns={dns} mode={mode} pool={pool} />

      <div className="mt-4 border-b border-border">
        <div role="tablist" aria-label="Site sections" className="flex gap-1">
          {TABS.map(([id, labelFn, countFn]) => {
            const count = countFn(site);
            return (
              <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => onTabChange(id)} className={cn("cursor-pointer px-3 py-2 text-[14px] transition-colors duration-150", tab === id ? "border-b-2 border-foreground -mb-px font-semibold text-foreground" : "text-ink-muted hover:text-foreground")}>
                {labelFn(site)}
                {count !== null && count > 0 ? <span className="ml-1.5 font-mono text-xs text-ink-muted">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        {tab === "overview" && (
          <div className="space-y-6">
            <div className="border border-border bg-surface px-6 py-4">
              <KvHead>Identity</KvHead>
              <dl>
                <Kv label="URL" value={siteUrl(site)} mono />
                <Kv label="Document root" value={site.docroot} mono />
                <Kv label="Server" value={`${serverLabel(site.web_server)} · ${serverLoopback(site.web_server)}:${site.https ? site.https_port : site.port}`} mono />
                <Kv label="Aliases" value={aliasesText} mono />
              </dl>
              <KvHead>Runtime</KvHead>
              <dl>
                <Kv label="PHP" value={site.php_version ? `${site.php_version}${pool ? ` · ${pool.workers} workers` : ""}` : "Static"} mono />
                <Kv label="Endpoint" value={site.php_endpoint ?? "—"} mono />
              </dl>
              <KvHead>Trust</KvHead>
              <dl>
                <Kv label="Certificate" value={cert} />
                <Kv label="DNS" value={dnsValue} mono />
              </dl>
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
