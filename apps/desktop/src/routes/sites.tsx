import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FolderOpen, Globe, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
import { NetworkStrip } from "@/components/sites/NetworkStrip";
import { RequestsSummary } from "@/components/sites/RequestsSummary";
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

  // Sites list portals into the shell rail column (Frame 3); fall back to the
  // inline aside when the rail element is absent (isolated tests / no shell).
  const [railEl, setRailEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRailEl(document.getElementById("shell-rail")); });

  const buildActions = (site: SiteStatus): MenuItem[] => [
    { id: "folder", label: "Open folder", icon: FolderOpen, onSelect: () => void openFolderFor(site) },
    { id: "copy", label: "Copy URL", icon: Copy, onSelect: () => copyUrl(site) },
    { id: "remove", label: "Remove site", icon: Trash2, destructive: true, disabled: remove.isPending && remove.variables === site.hostname, onSelect: () => setRemoveTarget(site) },
  ];

  const listPane = (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-surface min-h-0">
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold text-foreground">Sites</h1>
            <span className="font-mono text-[13px] text-ink-muted">{allSites.length} site{allSites.length === 1 ? "" : "s"}</span>
          </div>
          <Button size="sm" className="h-8 gap-1 px-3 text-[13px]" onClick={() => setCreating(true)}><Plus className="size-3.5" />Add site</Button>
        </div>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-muted" />
          <Input className="h-9 border-line-strong bg-transparent pl-9 text-[13px] focus-visible:ring-1" aria-label="Search sites" placeholder="Filter by domain, runtime or service…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {allSites.length > 1 && (serverKinds.length > 1 || runtimes.length > 1) ? (
          <div className="flex items-center gap-2">
            {serverKinds.length > 1 ? <Select aria-label="Server" className="h-8 flex-1 text-[13px]" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}><option value="all">All servers</option>{serverKinds.map((k) => <option key={k} value={k}>{serverLabel(k)}</option>)}</Select> : null}
            {runtimes.length > 1 ? <Select aria-label="Runtime" className="h-8 flex-1 text-[13px]" value={runtimeFilter} onChange={(e) => setRuntimeFilter(e.target.value)}><option value="all">All runtimes</option>{runtimes.map((v) => <option key={v || STATIC} value={v || STATIC}>{v || "Static"}</option>)}</Select> : null}
          </div>
        ) : null}
        {activeCount > 0 ? <div className="flex items-center justify-between"><span className="text-[13px] text-ink-muted">{visibleSites.length} matching</span><Button variant="ghost" size="sm" className="h-6 px-2 text-[13px]" onClick={clearFilters}>Clear filters</Button></div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sites.isPending ? <div className="space-y-2 p-4" role="status"><span className="sr-only">Loading sites…</span>{[0,1,2].map((r) => <span key={r} aria-hidden className="block h-14 shimmer-skeleton" />)}</div>
          : sites.isError ? <div className="p-4"><Callout variant="destructive" title="Could not read the site list."><p>{sites.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void sites.refetch()}>Try again</Button></Callout></div>
          : allSites.length === 0 ? <div className="p-4 text-center"><EmptyState icon={<Globe />} title="No sites yet." description="Add one and DevX will route its .test host name to your project folder." action={<Button size="sm" onClick={() => setCreating(true)}><Plus />Create your first site</Button>} /></div>
          : visibleSites.length === 0 ? <div className="p-4 text-center"><EmptyState icon={<Search />} title="No site matches these filters." description={`${allSites.length} site${allSites.length === 1 ? "" : "s"} exist and none of them match the current filters.`} /></div>
          : <SiteList sites={visibleSites} selectedHostname={selectedSite?.hostname ?? null} onSelect={setSelected} buildActions={buildActions} onOpenInBrowser={(s) => void openInBrowser(siteUrl(s))} />}
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-background">
      {railEl
        ? createPortal(
            <div className="flex h-full min-h-0 flex-col">{listPane}</div>,
            railEl,
          )
        : listPane}

      <main className="flex flex-1 min-w-0 flex-col overflow-y-auto bg-background p-6">
        <SiteDetail
          site={selectedSite}
          tab={tab}
          onTabChange={setTab}
          dns={dns.data}
          ca={ca.data}
          mode={config.data?.network.dns_mode}
          pool={
            selectedSite?.php_version
              ? (phpPools.data ?? []).find((p) => p.version === selectedSite.php_version) ?? null
              : null
          }
          onOpenInBrowser={(s) => void openInBrowser(siteUrl(s))}
          onOpenFolder={openFolderFor}
          onRemove={setRemoveTarget}
          onCopyUrl={copyUrl}
          networkStrip={
            <NetworkStrip
              dns={dns.data}
              mode={config.data?.network.dns_mode}
              ca={ca.data}
              pending={networkPending}
              error={networkError}
              onRetry={() => { void dns.refetch(); void ca.refetch(); void config.refetch(); }}
              dnsBusy={dnsStart.isPending || dnsStop.isPending}
              caInstalling={caInstall.isPending}
              onDnsStart={() => dnsStart.mutate()}
              onDnsStop={() => dnsStop.mutate()}
              onCaInstall={() => caInstall.mutate()}
            />
          }
          overviewSlot={
            selectedSite ? (
              <div className="space-y-6">
                <RequestsSummary hostname={selectedSite.hostname} />
                <SiteBehaviorEditor site={selectedSite} phpChoices={phpChoices} />
              </div>
            ) : null
          }
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
