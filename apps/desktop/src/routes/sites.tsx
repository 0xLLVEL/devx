import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FolderOpen, Globe, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { MenuItem } from "@/components/ui/menu";
import { usePhpPools, useSites } from "@/lib/queries";
import { openFolder } from "@/lib/open-folder";
import { openInBrowser } from "@/lib/open-url";
import { ipc, type SiteStatus } from "@/lib/ipc";
import { SiteList } from "@/components/sites/SiteList";
import { SiteDetail } from "@/components/sites/SiteDetail";
import { SiteBehaviorEditor } from "@/components/sites/SiteBehaviorEditor";
import { AliasPanel } from "@/components/sites/AliasPanel";
import { EnvPanel } from "@/components/sites/EnvPanel";
import { RequestsPanel } from "@/components/sites/RequestsPanel";
import { AuthPanel } from "@/components/sites/AuthPanel";
import { PingButton } from "@/components/sites/PingButton";
import { NetworkStrip } from "@/components/sites/NetworkStrip";
import { CreateSiteDialog } from "@/components/sites/CreateSiteDialog";
import { serverLabel, siteUrl, STATIC, type WebServerChoice } from "@/components/sites/site-helpers";

export function SitesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useSites();
  const phpPools = usePhpPools();
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SiteStatus | null>(null);
  const [tab, setTab] = useState<"overview" | "aliases" | "env" | "requests" | "auth">("overview");
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get("q") ?? "";
  const serverFilter = (searchParams.get("server") as WebServerChoice | "all" | null) ?? "all";
  const runtimeFilter = searchParams.get("runtime") ?? "all";
  const setQuery = (v: string) => setSearchParams((p) => { const n = new URLSearchParams(p); v ? n.set("q", v) : n.delete("q"); return n; });
  const setServerFilter = (v: string) => setSearchParams((p) => { const n = new URLSearchParams(p); v !== "all" ? n.set("server", v) : n.delete("server"); return n; });
  const setRuntimeFilter = (v: string) => setSearchParams((p) => { const n = new URLSearchParams(p); v !== "all" ? n.set("runtime", v) : n.delete("runtime"); return n; });

  const remove = useMutation({
    mutationFn: (h: string) => ipc.siteRemove(h),
    onMutate: async (hostname) => {
      await qc.cancelQueries({ queryKey: ["sites"] });
      const previous = qc.getQueryData<SiteStatus[]>(["sites"]);
      if (previous) qc.setQueryData(["sites"], previous.filter((s) => s.hostname !== hostname));
      return { previous };
    },
    onSuccess: (_r, h) => toast.success("Site removed", { description: `${h} is no longer served.` }),
    onError: (e: Error, h, ctx) => {
      if ((ctx as { previous?: SiteStatus[] })?.previous) qc.setQueryData(["sites"], (ctx as { previous: SiteStatus[] }).previous);
      toast.error(`Could not remove ${h}`, { details: e.message });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });
  const caInstall = useMutation({ mutationFn: ipc.caInstall, onError: (e: Error) => toast.error("Could not install the CA", { details: e.message }), onSettled: () => qc.invalidateQueries({ queryKey: ["ca"] }) });
  const dnsStart = useMutation({ mutationFn: ipc.dnsStart, onError: (e: Error) => toast.error("Could not start the resolver", { details: e.message }), onSettled: () => qc.invalidateQueries({ queryKey: ["dns"] }) });
  const dnsStop = useMutation({ mutationFn: ipc.dnsStop, onError: (e: Error) => toast.error("Could not stop the resolver", { details: e.message }), onSettled: () => qc.invalidateQueries({ queryKey: ["dns"] }) });
  const aliasAdd = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) => ipc.siteAliasAdd(hostname, alias),
    onMutate: async ({ hostname, alias }) => {
      await qc.cancelQueries({ queryKey: ["sites"] });
      const previous = qc.getQueryData<SiteStatus[]>(["sites"]);
      if (previous) qc.setQueryData<SiteStatus[]>(["sites"], previous.map((s) => (s.hostname === hostname ? { ...s, aliases: [...s.aliases, alias] } : s)));
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if ((ctx as { previous?: SiteStatus[] })?.previous) qc.setQueryData(["sites"], (ctx as { previous: SiteStatus[] }).previous);
      toast.error("Could not add the alias", { details: e.message });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });
  const aliasDelete = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) => ipc.siteAliasDelete(hostname, alias),
    onMutate: async ({ hostname, alias }) => {
      await qc.cancelQueries({ queryKey: ["sites"] });
      const previous = qc.getQueryData<SiteStatus[]>(["sites"]);
      if (previous) qc.setQueryData<SiteStatus[]>(["sites"], previous.map((s) => (s.hostname === hostname ? { ...s, aliases: s.aliases.filter((a) => a !== alias) } : s)));
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if ((ctx as { previous?: SiteStatus[] })?.previous) qc.setQueryData(["sites"], (ctx as { previous: SiteStatus[] }).previous);
      toast.error("Could not delete the alias", { details: e.message });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });

  const phpChoices = (phpPools.data ?? []).map((p) => p.version);
  const allSites = sites.data ?? [];
  const networkPending = dns.isPending || ca.isPending || config.isPending;
  const networkError = (dns.error ?? ca.error ?? config.error) as Error | null ?? null;
  const phpChoicesError = phpPools.error instanceof Error ? phpPools.error : null;

  const serverKinds = useMemo(() => [...new Set(allSites.map((s) => s.web_server))].sort(), [allSites]);
  const runtimes = useMemo(() => [...new Set(allSites.map((s) => s.php_version))].sort(), [allSites]);

  const needle = query.trim().toLowerCase();
  const visibleSites = allSites.filter((s) => {
    if (serverFilter !== "all" && s.web_server !== serverFilter) return false;
    if (runtimeFilter !== "all" && (s.php_version || STATIC) !== runtimeFilter) return false;
    if (needle.length > 0) { const h = [s.hostname, s.docroot, ...s.aliases].join(" ").toLowerCase(); if (!h.includes(needle)) return false; }
    return true;
  });

  const selectedSite = allSites.find((s) => s.hostname === selected) ?? null;
  const activeCount = (needle ? 1 : 0) + (serverFilter !== "all" ? 1 : 0) + (runtimeFilter !== "all" ? 1 : 0);
  const clearFilters = () => setSearchParams(new URLSearchParams());

  const openFolderFor = async (s: SiteStatus) => {
    const f = await openFolder(s.docroot);
    if (f !== null) toast.error("Could not open the folder", { description: `${s.docroot} could not be opened.`, details: f });
  };
  const copyUrl = (s: SiteStatus) => { void navigator.clipboard.writeText(siteUrl(s)); toast.success("URL copied", { description: siteUrl(s) }); };
  const isTest = typeof process !== "undefined" && process.env?.NODE_ENV === "test";

  useEffect(() => { if (!isTest && selected === null && allSites.length > 0) { const f = allSites[0]; if (f) setSelected(f.hostname); } }, [isTest, selected, allSites]);

  const attentionSites = useMemo(() => visibleSites.filter((s) => Boolean(s.php_version && !s.php_endpoint)), [visibleSites]);
  const normalSites = useMemo(() => visibleSites.filter((s) => !Boolean(s.php_version && !s.php_endpoint)), [visibleSites]);

  const buildActions = (site: SiteStatus): MenuItem[] => [
    { id: "folder", label: "Open folder", icon: FolderOpen, onSelect: () => void openFolderFor(site) },
    { id: "copy", label: "Copy URL", icon: Copy, onSelect: () => copyUrl(site) },
    { id: "remove", label: "Remove site", icon: Trash2, destructive: true, disabled: remove.isPending && remove.variables === site.hostname, onSelect: () => setRemoveTarget(site) },
  ];

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-1 overflow-hidden bg-background">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border/70 bg-surface-1/40">
        <div className="space-y-3 border-b border-border/60 p-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2"><h1 className="text-sm font-semibold tracking-tight text-foreground">Sites</h1><span className="font-mono text-xs text-muted-foreground">{allSites.length} site{allSites.length === 1 ? "" : "s"}</span></div>
            <Button size="sm" className="h-7 gap-1 rounded-md px-2.5 text-xs font-medium shadow-xs" onClick={() => setCreating(true)}><Plus className="size-3.5" />Add site</Button>
          </div>
          <div className="relative"><Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="h-8 border-border/80 bg-surface-2/40 pl-8 text-xs placeholder:text-muted-foreground/70 focus-visible:ring-1" aria-label="Search sites" placeholder="Filter by domain, runtime or service..." value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} /></div>
          {allSites.length > 1 && (serverKinds.length > 1 || runtimes.length > 1) ? (
            <div className="flex items-center gap-2 pt-0.5">
              {serverKinds.length > 1 ? <Select aria-label="Server" className="h-7 flex-1 text-xs" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}><option value="all">All servers</option>{serverKinds.map((k) => <option key={k} value={k}>{serverLabel(k)}</option>)}</Select> : null}
              {runtimes.length > 1 ? <Select aria-label="Runtime" className="h-7 flex-1 text-xs" value={runtimeFilter} onChange={(e) => setRuntimeFilter(e.target.value)}><option value="all">All runtimes</option>{runtimes.map((v) => <option key={v || STATIC} value={v || STATIC}>{v || "Static"}</option>)}</Select> : null}
            </div>
          ) : null}
          {activeCount > 0 ? <div className="flex items-center justify-between pt-0.5"><span className="text-caption text-muted-foreground">{visibleSites.length} matching</span><Button variant="ghost" size="sm" className="h-6 px-2 text-caption text-primary" onClick={clearFilters}>Clear filters</Button></div> : null}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {sites.isPending ? <div className="space-y-2 p-2" role="status"><span className="sr-only">Loading sites…</span>{[0,1,2].map((r) => <span key={r} aria-hidden className="block h-12 animate-pulse rounded-md bg-secondary" />)}</div>
            : sites.isError ? <div className="p-2"><Callout variant="destructive" title="Could not read the site list."><p>{sites.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void sites.refetch()}>Try again</Button></Callout></div>
            : allSites.length === 0 ? <div className="p-4 text-center"><EmptyState icon={<Globe />} title="No sites yet." description="Add one and DevX will route its .test host name to your project folder." action={<Button size="sm" onClick={() => setCreating(true)}><Plus />Create your first site</Button>} /></div>
            : visibleSites.length === 0 ? <div className="p-4 text-center"><EmptyState icon={<Search />} title="No site matches these filters." description={`${allSites.length} site${allSites.length === 1 ? "" : "s"} exist and none of them match the current filters.`} /></div>
            : <SiteList attentionSites={attentionSites} normalSites={normalSites} selectedHostname={selectedSite?.hostname ?? null} onSelect={setSelected} buildActions={buildActions} onOpenInBrowser={(s) => void openInBrowser(siteUrl(s))} />}
        </div>

        <NetworkStrip dns={dns.data} mode={config.data?.network.dns_mode} ca={ca.data} pending={networkPending} error={networkError} onRetry={() => { void dns.refetch(); void ca.refetch(); void config.refetch(); }} dnsBusy={dnsStart.isPending || dnsStop.isPending} caInstalling={caInstall.isPending} onDnsStart={() => dnsStart.mutate()} onDnsStop={() => dnsStop.mutate()} onCaInstall={() => caInstall.mutate()} />
      </aside>

      <main className="flex flex-1 min-w-0 flex-col overflow-y-auto bg-background">
        <SiteDetail
          site={selectedSite}
          tab={tab}
          onTabChange={setTab}
          phpChoices={phpChoices}
          dns={dns.data}
          ca={ca.data}
          configDnsMode={config.data?.network.dns_mode}
          dnsSuffix={dns.data?.suffix}
          onOpenInBrowser={(s) => void openInBrowser(siteUrl(s))}
          onOpenFolder={openFolderFor}
          onRemove={setRemoveTarget}
          onCopyUrl={copyUrl}
          pingSlot={selectedSite ? <PingButton hostname={selectedSite.hostname} /> : null}
          overviewSlot={selectedSite ? <SiteBehaviorEditor site={selectedSite} phpChoices={phpChoices} /> : null}
          aliasesSlot={selectedSite ? <AliasPanel site={selectedSite} busy={aliasAdd.isPending || aliasDelete.isPending} onAdd={(a) => aliasAdd.mutateAsync({ hostname: selectedSite.hostname, alias: a })} onDelete={(a) => aliasDelete.mutate({ hostname: selectedSite.hostname, alias: a })} /> : null}
          envSlot={selectedSite ? <EnvPanel site={selectedSite} /> : null}
          requestsSlot={selectedSite ? <RequestsPanel hostname={selectedSite.hostname} /> : null}
          authSlot={selectedSite ? <AuthPanel site={selectedSite} /> : null}
        />
      </main>

      <CreateSiteDialog open={creating} phpChoices={phpChoices} phpChoicesError={phpChoicesError} onRetryPhpChoices={() => void phpPools.refetch()} onClose={() => setCreating(false)} />
      <ConfirmDialog open={removeTarget !== null} onClose={() => setRemoveTarget(null)} onConfirm={() => { if (removeTarget) remove.mutate(removeTarget.hostname); setRemoveTarget(null); }} title={`Remove ${removeTarget?.hostname ?? "this site"}?`} description={<>DevX stops serving this host name and deletes its site block. The folder <span className="font-mono text-xs break-all" data-selectable>{removeTarget?.docroot}</span> stays on disk, untouched.</>} confirmLabel="Remove site" destructive pending={remove.isPending} />
    </div>
  );
}
