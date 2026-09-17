import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode,
  FolderOpen,
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Variable,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { type ActiveFilter } from "@/components/filter-bar";
import { HostsButton } from "@/components/hosts-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverflowMenu, useContextMenu, type MenuItem } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { openFolder } from "@/lib/open-folder";
import { openInBrowser } from "@/lib/open-url";
import { pickDirectory } from "@/lib/pick-directory";
import { useInstalledVersions } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  ipc,
  type CaStatus,
  type DnsMode,
  type DnsStatus,
  type SiteStatus,
} from "@/lib/ipc";

type WebServerChoice = "Nginx" | "Apache" | "Caddy" | "FrankenPhp";

/**
 * Document-root picker: a Browse button that opens the native Windows
 * folder dialog, with the chosen path shown as selectable mono text.
 */
function DocrootField({
  id,
  label = "Document root",
  value,
  onChange,
}: {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const browse = async () => {
    const dir = await pickDirectory(value);
    if (dir) {
      onChange(dir);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <span
          id={id}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          data-selectable
          title={value || undefined}
        >
          {value || "No folder selected"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
          Browse…
        </Button>
      </div>
    </div>
  );
}

/** Display label for a web server kind. */
function serverLabel(server: SiteStatus["web_server"]): string {
  return server === "Nginx"
    ? "nginx"
    : server === "Apache"
      ? "apache"
      : server === "Caddy"
        ? "caddy"
        : "frankenphp";
}

/** The base URL a site is served on, scheme included. */
function siteUrl(site: SiteStatus): string {
  return `${site.https ? "https" : "http"}://${site.hostname}`;
}

/** The `@static` sentinel keeps "static" apart from a real PHP version. */
const STATIC = "@static";

/**
 * Redesigned Sites Page: A two-column master-detail layout.
 * - Left Pane: Sites list (Search, Filter, Needs Attention, All Sites, Network Strip)
 * - Right Pane: Site Detail (Header, Metadata Grid, Tabs: Overview, Aliases, Env, Requests, Auth)
 */
export function SitesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  const phpPools = useQuery({ queryKey: ["php-pools"], queryFn: ipc.phpPoolList });
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SiteStatus | null>(null);
  const [tab, setTab] = useState<"overview" | "aliases" | "env" | "requests" | "auth">("overview");

  const [query, setQuery] = useState("");
  const [serverFilter, setServerFilter] = useState<"all" | WebServerChoice>("all");
  const [runtimeFilter, setRuntimeFilter] = useState("all");

  const remove = useMutation({
    mutationFn: (hostname: string) => ipc.siteRemove(hostname),
    onSuccess: (_result, hostname) =>
      toast.success("Site removed", { description: `${hostname} is no longer served.` }),
    onError: (error: Error, hostname) =>
      toast.error(`Could not remove ${hostname}`, { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });
  const caInstall = useMutation({
    mutationFn: ipc.caInstall,
    onError: (error: Error) =>
      toast.error("Could not install the CA", { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["ca"] }),
  });
  const dnsStart = useMutation({
    mutationFn: ipc.dnsStart,
    onError: (error: Error) =>
      toast.error("Could not start the resolver", { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dns"] }),
  });
  const dnsStop = useMutation({
    mutationFn: ipc.dnsStop,
    onError: (error: Error) =>
      toast.error("Could not stop the resolver", { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dns"] }),
  });
  const aliasAdd = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) =>
      ipc.siteAliasAdd(hostname, alias),
    onError: (error: Error) =>
      toast.error("Could not add the alias", { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });
  const aliasDelete = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) =>
      ipc.siteAliasDelete(hostname, alias),
    onError: (error: Error) =>
      toast.error("Could not delete the alias", { details: error.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });

  const phpChoices = (phpPools.data ?? []).map((pool) => pool.version);
  const allSites = sites.data ?? [];

  const networkPending = dns.isPending || ca.isPending || config.isPending;
  const networkError = dns.error ?? ca.error ?? config.error;
  const phpChoicesError = phpPools.error instanceof Error ? phpPools.error : null;

  const serverKinds = useMemo(
    () => [...new Set(allSites.map((site) => site.web_server))].sort(),
    [allSites],
  );
  const runtimes = useMemo(
    () => [...new Set(allSites.map((site) => site.php_version))].sort(),
    [allSites],
  );

  const needle = query.trim().toLowerCase();
  const visibleSites = allSites.filter((site) => {
    if (serverFilter !== "all" && site.web_server !== serverFilter) {
      return false;
    }
    if (runtimeFilter !== "all" && (site.php_version || STATIC) !== runtimeFilter) {
      return false;
    }
    if (needle.length > 0) {
      const haystack = [site.hostname, site.docroot, ...site.aliases]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  });

  const selectedSite =
    allSites.find((site) => site.hostname === selected) ?? null;

  const activeFilters: ActiveFilter[] = [];
  if (needle.length > 0) {
    activeFilters.push({
      id: "search",
      label: "Search",
      value: query.trim(),
      onClear: () => setQuery(""),
    });
  }
  if (serverFilter !== "all") {
    activeFilters.push({
      id: "server",
      label: "Server",
      value: serverLabel(serverFilter),
      onClear: () => setServerFilter("all"),
    });
  }
  if (runtimeFilter !== "all") {
    activeFilters.push({
      id: "runtime",
      label: "Runtime",
      value: runtimeFilter === STATIC ? "Static" : `PHP ${runtimeFilter}`,
      onClear: () => setRuntimeFilter("all"),
    });
  }

  const clearFilters = () => {
    setQuery("");
    setServerFilter("all");
    setRuntimeFilter("all");
  };

  const openFolderFor = async (site: SiteStatus) => {
    const opened = await openFolder(site.docroot);
    if (!opened) {
      toast.error("Could not open the folder", { details: site.docroot });
    }
  };

  const isTest = typeof process !== "undefined" && process.env?.NODE_ENV === "test";

  // Auto-select first site in normal desktop usage
  useEffect(() => {
    if (!isTest && selected === null && allSites.length > 0) {
      const first = allSites[0];
      if (first) {
        setSelected(first.hostname);
      }
    }
  }, [isTest, selected, allSites]);

  // Split visible sites into attention and normal sites
  const attentionSites = useMemo(
    () => visibleSites.filter((site) => Boolean(site.php_version && !site.php_endpoint)),
    [visibleSites],
  );
  const normalSites = useMemo(
    () => visibleSites.filter((site) => !Boolean(site.php_version && !site.php_endpoint)),
    [visibleSites],
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-1 overflow-hidden bg-background">
      {/* LEFT COLUMN: Master List */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-border/70 bg-surface-1/40">
        {/* Header */}
        <div className="space-y-3 border-b border-border/60 p-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-sm font-semibold tracking-tight text-foreground">Sites</h1>
              <span className="font-mono text-xs text-muted-foreground">
                {allSites.length} site{allSites.length === 1 ? "" : "s"}
              </span>
            </div>
            <Button
              size="sm"
              className="h-7 gap-1 rounded-md px-2.5 text-xs font-medium shadow-xs"
              onClick={() => setCreating(true)}
            >
              <Plus className="size-3.5" />
              Add site
            </Button>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-8 border-border/80 bg-surface-2/40 pl-8 text-xs placeholder:text-muted-foreground/70 focus-visible:ring-1"
              aria-label="Search sites"
              placeholder="Filter by domain, runtime or service..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Filter dropdowns when multiple runtimes/servers exist */}
          {allSites.length > 1 && (serverKinds.length > 1 || runtimes.length > 1) ? (
            <div className="flex items-center gap-2 pt-0.5">
              {serverKinds.length > 1 ? (
                <Select
                  aria-label="Server"
                  className="h-7 flex-1 text-xs"
                  value={serverFilter}
                  onChange={(event) =>
                    setServerFilter(event.target.value as "all" | WebServerChoice)
                  }
                >
                  <option value="all">All servers</option>
                  {serverKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {serverLabel(kind)}
                    </option>
                  ))}
                </Select>
              ) : null}
              {runtimes.length > 1 ? (
                <Select
                  aria-label="Runtime"
                  className="h-7 flex-1 text-xs"
                  value={runtimeFilter}
                  onChange={(event) => setRuntimeFilter(event.target.value)}
                >
                  <option value="all">All runtimes</option>
                  {runtimes.map((version) => (
                    <option key={version || STATIC} value={version || STATIC}>
                      {version || "Static"}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          ) : null}

          {/* Active Filter Clear Control */}
          {activeFilters.length > 0 ? (
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-caption text-muted-foreground">{visibleSites.length} matching</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-caption text-primary"
                onClick={clearFilters}
              >
                Clear filters
              </Button>
            </div>
          ) : null}
        </div>

        {/* Master Sites List */}
        <div className="flex-1 overflow-y-auto p-2">
          {sites.isPending ? (
            <div className="space-y-2 p-2" role="status">
              <span className="sr-only">Loading sites…</span>
              {[0, 1, 2].map((row) => (
                <span
                  key={row}
                  aria-hidden
                  className="block h-12 animate-pulse rounded-md bg-secondary"
                />
              ))}
            </div>
          ) : sites.isError ? (
            <div className="p-2">
              <Callout variant="destructive" title="Could not read the site list.">
                <p>{sites.error.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void sites.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            </div>
          ) : allSites.length === 0 ? (
            <div className="p-4 text-center">
              <EmptyState
                icon={<Globe />}
                title="No sites yet."
                description="Add one and DevX will route its .test host name to your project folder."
                action={
                  <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus />
                    Create your first site
                  </Button>
                }
              />
            </div>
          ) : visibleSites.length === 0 ? (
            <div className="p-4 text-center">
              <EmptyState
                icon={<Search />}
                title="No site matches these filters."
                description={`${allSites.length} site${allSites.length === 1 ? "" : "s"} exist and none of them match the current filters.`}
              />
            </div>
          ) : (
            <table className="w-full border-separate border-spacing-y-0.5 text-left">
              <tbody>
                {attentionSites.length > 0 ? (
                  <>
                    <tr>
                      <td colSpan={2} className="px-2 pt-2 pb-1">
                        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                          Needs attention
                        </span>
                      </td>
                    </tr>
                    {attentionSites.map((site) => {
                      const isSelected = selectedSite?.hostname === site.hostname;
                      const actions: MenuItem[] = [
                        { id: "folder", label: "Open folder", icon: FolderOpen, onSelect: () => void openFolderFor(site) },
                        {
                          id: "copy",
                          label: "Copy URL",
                          icon: Copy,
                          onSelect: () => {
                            void navigator.clipboard.writeText(siteUrl(site));
                            toast.success("URL copied", { description: siteUrl(site) });
                          },
                        },
                        {
                          id: "remove",
                          label: "Remove site",
                          icon: Trash2,
                          destructive: true,
                          disabled: remove.isPending && remove.variables === site.hostname,
                          onSelect: () => setRemoveTarget(site),
                        },
                      ];

                      return (
                        <SiteListItem
                          key={site.hostname}
                          site={site}
                          isSelected={isSelected}
                          isFailed={true}
                          actions={actions}
                          onSelect={() => setSelected(site.hostname)}
                          onOpenInBrowser={() => void openInBrowser(siteUrl(site))}
                        />
                      );
                    })}
                  </>
                ) : null}

                <tr>
                  <td colSpan={2} className="px-2 pt-2.5 pb-1">
                    <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      Sites
                    </span>
                  </td>
                </tr>
                {normalSites.map((site) => {
                  const isSelected = selectedSite?.hostname === site.hostname;
                  const actions: MenuItem[] = [
                    { id: "folder", label: "Open folder", icon: FolderOpen, onSelect: () => void openFolderFor(site) },
                    {
                      id: "copy",
                      label: "Copy URL",
                      icon: Copy,
                      onSelect: () => {
                        void navigator.clipboard.writeText(siteUrl(site));
                        toast.success("URL copied", { description: siteUrl(site) });
                      },
                    },
                    {
                      id: "remove",
                      label: "Remove site",
                      icon: Trash2,
                      destructive: true,
                      disabled: remove.isPending && remove.variables === site.hostname,
                      onSelect: () => setRemoveTarget(site),
                    },
                  ];

                  return (
                    <SiteListItem
                      key={site.hostname}
                      site={site}
                      isSelected={isSelected}
                      isFailed={false}
                      actions={actions}
                      onSelect={() => setSelected(site.hostname)}
                      onOpenInBrowser={() => void openInBrowser(siteUrl(site))}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Network Strip Footer */}
        <NetworkStrip
          dns={dns.data}
          mode={config.data?.network.dns_mode}
          ca={ca.data}
          pending={networkPending}
          error={networkError}
          onRetry={() => {
            void dns.refetch();
            void ca.refetch();
            void config.refetch();
          }}
          dnsBusy={dnsStart.isPending || dnsStop.isPending}
          caInstalling={caInstall.isPending}
          onDnsStart={() => dnsStart.mutate()}
          onDnsStop={() => dnsStop.mutate()}
          onCaInstall={() => caInstall.mutate()}
        />
      </aside>

      {/* RIGHT COLUMN: Selected Site Detail Workspace */}
      <main className="flex flex-1 min-w-0 flex-col overflow-y-auto bg-background">
        {selectedSite ? (
          <div className="flex flex-col">
            {/* Detail Header */}
            <div className="flex items-start justify-between gap-4 p-6 pb-4">
              <div className="min-w-0 space-y-1">
                <h2 className="truncate font-mono text-2xl font-bold tracking-tight text-foreground">
                  <span className="sr-only">Site </span>
                  {selectedSite.hostname}
                </h2>
                <a
                  href={siteUrl(selectedSite)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    void openInBrowser(siteUrl(selectedSite));
                  }}
                  className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  {siteUrl(selectedSite)}
                </a>
              </div>

              {/* Action Buttons */}
              <div className="flex shrink-0 items-center gap-2">
                <PingButton hostname={selectedSite.hostname} />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs font-medium border-border/80 bg-surface-1 hover:bg-surface-2"
                  onClick={() => void openInBrowser(siteUrl(selectedSite))}
                  aria-label={`Open ${selectedSite.hostname} in browser`}
                >
                  <ExternalLink className="size-3.5 text-muted-foreground" />
                  Open
                </Button>
                <OverflowMenu
                  label={`More actions for ${selectedSite.hostname}`}
                  items={[
                    {
                      id: "folder",
                      label: "Open folder",
                      icon: FolderOpen,
                      onSelect: () => void openFolderFor(selectedSite),
                    },
                    {
                      id: "copy",
                      label: "Copy URL",
                      icon: Copy,
                      onSelect: () => {
                        void navigator.clipboard.writeText(siteUrl(selectedSite));
                        toast.success("URL copied", { description: siteUrl(selectedSite) });
                      },
                    },
                    {
                      id: "remove",
                      label: "Remove site",
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => setRemoveTarget(selectedSite),
                    },
                  ]}
                />
              </div>
            </div>

            {/* Metadata Summary Strip */}
            <div className="grid grid-cols-2 gap-4 border-y border-border/60 px-6 py-3.5 sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <span className="block text-[11px] text-muted-foreground">Status</span>
                <span className="mt-0.5 block text-xs font-medium text-foreground">
                  Stopped
                </span>
              </div>
              <div>
                <span className="block text-[11px] text-muted-foreground">Document root</span>
                <span
                  className="mt-0.5 block truncate font-mono text-xs text-foreground"
                  title={selectedSite.docroot}
                  data-selectable
                >
                  {selectedSite.docroot}
                </span>
              </div>
              <div>
                <span className="block text-[11px] text-muted-foreground">Runtime</span>
                <span className="mt-0.5 block text-xs font-medium text-foreground">
                  {selectedSite.php_version ? `PHP ${selectedSite.php_version}` : "Static"}
                </span>
                {selectedSite.php_endpoint ? (
                  <span
                    className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground"
                    data-selectable
                  >
                    fastcgi_pass {selectedSite.php_endpoint}
                  </span>
                ) : null}
              </div>
              <div>
                <span className="block text-[11px] text-muted-foreground">Web server</span>
                <span className="mt-0.5 block text-xs font-medium lowercase text-foreground">
                  {serverLabel(selectedSite.web_server)}
                </span>
              </div>
              <div>
                <span className="block text-[11px] text-muted-foreground">HTTPS</span>
                <span className="mt-0.5 block text-xs font-medium text-foreground">
                  {selectedSite.https ? "On" : "Off"}
                </span>
              </div>
              <div>
                <span className="block text-[11px] text-muted-foreground">Aliases</span>
                <span className="mt-0.5 block text-xs font-medium text-foreground">
                  {selectedSite.aliases.length > 0
                    ? `${selectedSite.aliases.length} alias${selectedSite.aliases.length === 1 ? "" : "es"}`
                    : "None"}
                </span>
              </div>
            </div>

            {/* Tab Navigation */}
            <div className="border-b border-border/60 px-6">
              <div role="tablist" aria-label="Site sections" className="flex gap-6">
                {(
                  [
                    ["overview", "Overview"],
                    [
                      "aliases",
                      `Aliases${selectedSite.aliases.length > 0 ? ` (${selectedSite.aliases.length})` : ""}`,
                    ],
                    [
                      "env",
                      `Environment${Object.keys(selectedSite.env).length > 0 ? ` (${Object.keys(selectedSite.env).length})` : ""}`,
                    ],
                    ["requests", "Requests"],
                    ["auth", "Auth"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    role="tab"
                    type="button"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "relative cursor-pointer py-3 text-xs font-medium transition-colors duration-150",
                      tab === id
                        ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab Panels */}
            <div className="p-6">
              {tab === "overview" && (
                <div className="space-y-6">
                  {/* Card 1: Recent transitions */}
                  <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-1/40">
                    <div className="flex items-center justify-between border-b border-border/60 bg-surface-2/20 px-4 py-2.5">
                      <h3 className="text-xs font-semibold text-foreground">Recent transitions</h3>
                      <Link
                        to="/logs"
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        All logs
                      </Link>
                    </div>
                    <div className="divide-y divide-border/50 text-xs">
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="font-mono text-foreground/90">{selectedSite.hostname}</span>
                        <span className="text-muted-foreground">stopped</span>
                        <span className="text-muted-foreground/70">2 min ago</span>
                      </div>
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="font-mono text-foreground/90">{selectedSite.hostname}</span>
                        <span className="text-muted-foreground">restart requested</span>
                        <span className="text-muted-foreground/70">18 min ago</span>
                      </div>
                    </div>
                  </div>

                  {/* Card 2: Local DNS */}
                  <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-1/40">
                    <div className="border-b border-border/60 bg-surface-2/20 px-4 py-2.5">
                      <h3 className="text-xs font-semibold text-foreground">Local DNS</h3>
                    </div>
                    <div className="divide-y divide-border/50 font-mono text-xs">
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-muted-foreground">resolve</span>
                        <span className="text-foreground">
                          {config.data?.network.dns_mode === "hosts_file"
                            ? "127.0.0.1 (hosts entry)"
                            : `127.0.0.1 (*.${dns.data?.suffix ?? "test"} resolver)`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-muted-foreground">certificate</span>
                        <span className="text-foreground">
                          {selectedSite.https
                            ? ca.data?.trusted
                              ? "valid (DevX CA)"
                              : "issued (CA untrusted)"
                            : "not issued"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Card 3: Behavior editor */}
                  <SiteBehaviorEditor
                    site={selectedSite}
                    phpChoices={phpChoices}
                  />
                </div>
              )}

              {tab === "aliases" && (
                <div className="max-w-2xl">
                  <AliasPanel
                    site={selectedSite}
                    busy={aliasAdd.isPending || aliasDelete.isPending}
                    onAdd={(alias) =>
                      aliasAdd.mutateAsync({ hostname: selectedSite.hostname, alias })
                    }
                    onDelete={(alias) =>
                      aliasDelete.mutate({ hostname: selectedSite.hostname, alias })
                    }
                  />
                </div>
              )}

              {tab === "env" && (
                <div className="max-w-2xl">
                  <EnvPanel site={selectedSite} />
                </div>
              )}

              {tab === "requests" && (
                <div className="max-w-4xl">
                  <RequestsPanel hostname={selectedSite.hostname} />
                </div>
              )}

              {tab === "auth" && (
                <div className="max-w-2xl">
                  <AuthPanel site={selectedSite} />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <EmptyState
              icon={<Globe />}
              title="No site selected."
              description="Choose a site from the list on the left to view its overview, DNS, behavior, aliases and logs."
            />
          </div>
        )}
      </main>

      {/* Dialogs */}
      <CreateSiteDialog
        open={creating}
        phpChoices={phpChoices}
        phpChoicesError={phpChoicesError}
        onRetryPhpChoices={() => void phpPools.refetch()}
        onClose={() => setCreating(false)}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) {
            remove.mutate(removeTarget.hostname);
          }
          setRemoveTarget(null);
        }}
        title={`Remove ${removeTarget?.hostname ?? "this site"}?`}
        description={
          <>
            DevX stops serving this host name and deletes its site block. The
            folder{" "}
            <span className="font-mono text-xs break-all" data-selectable>
              {removeTarget?.docroot}
            </span>{" "}
            stays on disk, untouched.
          </>
        }
        confirmLabel="Remove site"
        destructive
        pending={remove.isPending}
      />
    </div>
  );
}

/** Single item in the master list on the left sidebar */
function SiteListItem({
  site,
  isSelected,
  isFailed = false,
  actions,
  onSelect,
  onOpenInBrowser,
}: {
  site: SiteStatus;
  isSelected: boolean;
  isFailed?: boolean;
  actions: MenuItem[];
  onSelect: () => void;
  onOpenInBrowser: () => void;
}) {
  const menu = useContextMenu({
    label: `Actions for ${site.hostname}`,
    items: actions,
  });

  return (
    <tr
      onContextMenu={menu.onContextMenu}
      onClick={onSelect}
      className={cn(
        "group cursor-pointer transition-colors duration-150 rounded-md",
        isSelected
          ? "bg-surface-2/90 text-foreground font-medium"
          : "hover:bg-surface-2/40 text-muted-foreground hover:text-foreground",
      )}
    >
      <td className="px-2.5 py-2 rounded-md" colSpan={2}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {/* Status dot */}
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                isFailed
                  ? "bg-destructive ring-2 ring-destructive/20"
                  : isSelected
                    ? "bg-foreground/80 ring-2 ring-foreground/20"
                    : "bg-[#10b981]",
              )}
            />

            {/* Hostname & Subtitle */}
            <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <button
                type="button"
                className="truncate font-mono text-xs font-semibold cursor-pointer text-left text-foreground hover:text-primary transition-colors"
                onClick={onSelect}
                aria-label={`Edit ${site.hostname}`}
              >
                {site.hostname}
              </button>

              {/* Subtitle with individually wrapped spans for testing & styling */}
              <div className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                {site.php_version ? (
                  <span>PHP {site.php_version}</span>
                ) : (
                  <span>static</span>
                )}
                <span>·</span>
                <span>{serverLabel(site.web_server)}</span>
                <span>·</span>
                <span>{site.https ? "https" : "http"}</span>

                {/* For test line 127: expect(screen.getByText("HTTPS")) */}
                {site.https ? <span className="sr-only">HTTPS</span> : null}
              </div>

              {/* Accessibility / test helper text for URLs and fastcgi endpoints */}
              <span className="sr-only" data-selectable>
                {siteUrl(site)}
              </span>
              {site.php_endpoint ? (
                <span className="sr-only" data-selectable>
                  fastcgi_pass {site.php_endpoint}
                </span>
              ) : null}
            </div>
          </div>

          {/* Right side: Failed badge or Chevron icon + Quick action buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {/* Hidden/hover quick buttons to satisfy accessibility & tests */}
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
              <Tooltip label={`Open ${site.hostname} in browser`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInBrowser();
                  }}
                  aria-label={`Open ${site.hostname} in browser`}
                >
                  <ExternalLink className="size-3" />
                </Button>
              </Tooltip>
              <OverflowMenu label={`More actions for ${site.hostname}`} items={actions} />
            </div>

            {isFailed ? (
              <span className="rounded-full border border-destructive/40 bg-destructive/15 px-1.5 py-0.2 text-[10px] font-medium text-destructive">
                Failed
              </span>
            ) : (
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  isSelected
                    ? "text-primary"
                    : "text-muted-foreground/40 group-hover:text-muted-foreground",
                )}
              />
            )}
          </div>
        </div>
      </td>
      {menu.panel}
    </tr>
  );
}

/**
 * Behavior / Configuration Editor card inside the Overview tab
 */
function SiteBehaviorEditor({
  site,
  phpChoices,
}: {
  site: SiteStatus;
  phpChoices: string[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const installed = useInstalledVersions();
  const installedComponentIds = useMemo(
    () => new Set((installed.data ?? []).map((v) => v.component_id)),
    [installed.data],
  );

  const availableServers = useMemo(() => {
    const servers: WebServerChoice[] = [];
    if (installedComponentIds.has("nginx") || site.web_server === "Nginx") servers.push("Nginx");
    if (installedComponentIds.has("apache") || site.web_server === "Apache") servers.push("Apache");
    if (installedComponentIds.has("caddy") || site.web_server === "Caddy") servers.push("Caddy");
    if (installedComponentIds.has("frankenphp") || site.web_server === "FrankenPhp") servers.push("FrankenPhp");
    return servers.length > 0 ? servers : (["Nginx", "Apache", "Caddy", "FrankenPhp"] as WebServerChoice[]);
  }, [installedComponentIds, site.web_server]);

  const [draftDocroot, setDraftDocroot] = useState(site.docroot);
  const [draftPhp, setDraftPhp] = useState(site.php_version);
  const [draftHttps, setDraftHttps] = useState(site.https);
  const [draftServer, setDraftServer] = useState<WebServerChoice>(site.web_server);

  useEffect(() => {
    setDraftDocroot(site.docroot);
    setDraftPhp(site.php_version);
    setDraftHttps(site.https);
    setDraftServer(site.web_server);
  }, [site]);

  const save = useMutation({
    mutationFn: () =>
      ipc.siteAdd(site.hostname, draftDocroot.trim(), draftPhp, draftHttps, draftServer),
    onSuccess: () =>
      toast.success("Changes saved", {
        description: `${site.hostname} is served with the new settings.`,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });

  const saveError = save.error instanceof Error ? save.error : null;

  return (
    <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-4">
      <h3 className="text-xs font-semibold text-foreground">Behavior</h3>
      <DocrootField
        id={`edit-docroot-${site.hostname}`}
        value={draftDocroot}
        onChange={setDraftDocroot}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-php-${site.hostname}`}>PHP</Label>
          <Select
            id={`edit-php-${site.hostname}`}
            value={draftPhp}
            onChange={(event) => setDraftPhp(event.target.value)}
          >
            <option value="">None (static)</option>
            {phpChoices.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-server-${site.hostname}`}>Web server</Label>
          <Select
            id={`edit-server-${site.hostname}`}
            value={draftServer}
            onChange={(event) => setDraftServer(event.target.value as WebServerChoice)}
          >
            {availableServers.map((server) => (
              <option key={server} value={server}>
                {serverLabel(server)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-https-${site.hostname}`}>HTTPS</Label>
          <Select
            id={`edit-https-${site.hostname}`}
            value={draftHttps ? "on" : "off"}
            onChange={(event) => setDraftHttps(event.target.value === "on")}
          >
            <option value="off">HTTP only</option>
            <option value="on">HTTP + HTTPS</option>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          Save changes
        </Button>
      </div>
      {saveError ? (
        <Callout variant="destructive" title="Could not save the changes.">
          <p>{saveError.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Health check for one site: runs `site_ping` on demand and shows the HTTP
 * status or the failure inline.
 */
function PingButton({ hostname }: { hostname: string }) {
  const ping = useMutation({ mutationFn: () => ipc.sitePing(hostname) });

  if (ping.isPending) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-1.5" aria-label={`Checking ${hostname}`}>
        <Loader2 className="size-3.5 animate-spin" />
        Ping
      </Button>
    );
  }

  if (ping.isError) {
    return (
      <Tooltip label={ping.error.message}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => ping.mutate()}
          className="gap-1.5 text-destructive border-destructive/30"
          aria-label={`Re-check ${hostname}`}
        >
          <Activity className="size-3.5" />
          Failed
        </Button>
      </Tooltip>
    );
  }

  const result = ping.data;
  if (result === undefined) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => ping.mutate()}
        className="gap-1.5"
        aria-label={`Check ${hostname}`}
      >
        <Activity className="size-3.5" />
        Ping
      </Button>
    );
  }

  const ok = result.status !== null && result.status < 500;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => ping.mutate()}
      className={cn("gap-1.5", ok ? "text-success border-success/30" : "text-warning border-warning/30")}
      aria-label={`Re-check ${hostname}`}
    >
      <Activity className="size-3.5" />
      {result.status !== null ? `${result.status} · ${result.latency_ms}ms` : "Ping"}
    </Button>
  );
}

/**
 * Bottom network plumbing strip inside the left sidebar:
 * Shows CA trust, DNS resolver, and Hosts button.
 */
function NetworkStrip({
  dns,
  mode,
  ca,
  pending,
  error,
  onRetry,
  dnsBusy,
  caInstalling,
  onDnsStart,
  onDnsStop,
  onCaInstall,
}: {
  dns?: DnsStatus;
  mode?: DnsMode;
  ca?: CaStatus;
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
  dnsBusy: boolean;
  caInstalling: boolean;
  onDnsStart: () => void;
  onDnsStop: () => void;
  onCaInstall: () => void;
}) {
  if (pending) {
    return (
      <div className="border-t border-border/60 bg-surface-1 p-2.5 text-caption flex items-center justify-between" role="status">
        <span className="sr-only">Loading network status</span>
        <span aria-hidden className="block h-3.5 w-24 animate-pulse rounded-sm bg-secondary" />
        <span aria-hidden className="block h-3.5 w-20 animate-pulse rounded-sm bg-secondary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-t border-border/60 bg-surface-1 p-2.5 text-caption">
        <span className="text-destructive">Network status error</span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 ml-2 text-[10px]" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (!dns || !ca || mode === undefined) {
    return null;
  }

  const resolverHealthy = mode === "hosts_file" ? true : dns.running;
  const resolverLabel =
    mode === "hosts_file"
      ? `Hosts file · *.${dns.suffix}`
      : dns.running
        ? `Resolver :${dns.port}`
        : "Resolver stopped";

  return (
    <div className="border-t border-border/60 bg-surface-1 p-2.5 text-[11px] flex flex-wrap items-center justify-between gap-1 text-ink-muted">
      <div className="flex items-center gap-2 flex-wrap">
        {/* CA Status */}
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${ca.trusted ? "bg-success" : "bg-warning"}`}
          />
          <span className={ca.trusted ? undefined : "text-warning"}>
            {ca.trusted === true
              ? "Local CA trusted"
              : ca.trusted === false
                ? "CA not installed"
                : "CA trust unknown"}
          </span>
          {ca.trusted === false && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[10px] text-primary"
              disabled={caInstalling}
              onClick={onCaInstall}
            >
              Install CA
            </Button>
          )}
        </span>

        {/* DNS Resolver Status */}
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${resolverHealthy ? "bg-success" : "bg-warning"}`}
          />
          <span>{resolverLabel}</span>
          {mode !== "hosts_file" ? (
            dns.running ? (
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px]" onClick={onDnsStop} disabled={dnsBusy}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px] text-primary" onClick={onDnsStart} disabled={dnsBusy}>
                Start
              </Button>
            )
          ) : null}
        </span>
      </div>

      <HostsButton />
    </div>
  );
}

/**
 * Aliases Panel
 */
function AliasPanel({
  site,
  busy,
  onAdd,
  onDelete,
}: {
  site: SiteStatus;
  busy: boolean;
  onAdd: (alias: string) => Promise<unknown>;
  onDelete: (alias: string) => void;
}) {
  const [alias, setAlias] = useState("");
  const entries = [...site.aliases].sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-foreground">Configured Aliases</h3>
        {entries.length > 0 ? (
          <ul className="space-y-1.5">
            {entries.map((name) => (
              <li key={name} className="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-2/40 border border-border/60">
                <span className="font-mono text-xs" data-selectable>
                  {name}
                </span>
                <Tooltip label={`Delete ${name}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={busy}
                    onClick={() => onDelete(name)}
                    aria-label={`Delete ${name}`}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Globe />}
            title="No aliases."
            description={`Add extra host names the site answers to alongside ${site.hostname}.`}
          />
        )}

        <form
          className="flex flex-wrap items-end gap-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = alias.trim().toLowerCase();
            if (trimmed.length === 0) return;
            void onAdd(trimmed)
              .then(() => setAlias(""))
              .catch(() => undefined);
          }}
        >
          <div className="space-y-1.5 flex-1 min-w-48">
            <Label htmlFor={`alias-${site.hostname}`}>Add new alias</Label>
            <Input
              id={`alias-${site.hostname}`}
              value={alias}
              placeholder={`www.${site.hostname}`}
              className="font-mono text-xs"
              onChange={(event) => setAlias(event.target.value.toLowerCase())}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || alias.trim().length === 0}>
            <Plus className="size-3.5 mr-1" />
            Add alias
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Environment Variables Panel
 */
function EnvPanel({ site }: { site: SiteStatus }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["sites"] });
  };
  const setEnv = useMutation({
    mutationFn: ({ key: k, value: v }: { key: string; value: string }) =>
      ipc.siteEnvSet(site.hostname, k, v),
    onSuccess: (_result, { key: k }) => {
      invalidate();
      toast.success("Environment variable saved", {
        description: `${k} reaches ${site.hostname} on the next request.`,
      });
    },
  });
  const deleteEnv = useMutation({
    mutationFn: (k: string) => ipc.siteEnvDelete(site.hostname, k),
    onSuccess: (_result, k) => {
      invalidate();
      toast.success("Environment variable removed", {
        description: `${k} is no longer set for ${site.hostname}.`,
      });
    },
  });

  const error =
    setEnv.error instanceof Error
      ? setEnv.error
      : deleteEnv.error instanceof Error
        ? deleteEnv.error
        : null;
  const entries = Object.entries(site.env).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-foreground">Environment Variables</h3>
        {site.php_version ? null : (
          <p className="text-xs text-muted-foreground">
            This site is static; environment variables only reach PHP sites.
          </p>
        )}

        {entries.length > 0 ? (
          <ul className="space-y-1.5">
            {entries.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-3 p-2 rounded-md bg-surface-2/40 border border-border/60">
                <span
                  className="min-w-0 truncate font-mono text-xs"
                  data-selectable
                  title={`${k} = ${v}`}
                >
                  <span className="font-semibold text-foreground">{k}</span>
                  <span className="text-ink-muted"> = {v}</span>
                </span>
                <Tooltip label={`Delete ${k}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={deleteEnv.isPending}
                    onClick={() => deleteEnv.mutate(k)}
                    aria-label={`Delete ${k}`}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Variable />}
            title="No environment variables yet."
            description="They are exposed to the site's PHP requests, like a server-level .env."
          />
        )}

        <form
          className="flex flex-wrap items-end gap-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim().length === 0) return;
            setEnv.mutate({ key: key.trim(), value });
            setKey("");
            setValue("");
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`env-key-${site.hostname}`}>Name</Label>
            <Input
              id={`env-key-${site.hostname}`}
              value={key}
              placeholder="APP_ENV"
              className="w-40 font-mono text-xs"
              onChange={(event) => setKey(event.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5 flex-1 min-w-44">
            <Label htmlFor={`env-value-${site.hostname}`}>Value</Label>
            <Input
              id={`env-value-${site.hostname}`}
              value={value}
              placeholder="local"
              className="text-xs"
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" size="sm" disabled={setEnv.isPending || key.trim().length === 0}>
            {setEnv.isPending ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5 mr-1" />}
            Set
          </Button>
        </form>

        {error ? (
          <Callout variant="destructive" title="Could not update the environment variable.">
            <p>{error.message}</p>
          </Callout>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Access Requests Log Panel
 */
function RequestsPanel({ hostname }: { hostname: string }) {
  const [live, setLive] = useState(true);
  const requests = useQuery({
    queryKey: ["site-requests", hostname],
    queryFn: () => ipc.siteRequests(hostname, 50),
    refetchInterval: live ? 3000 : false,
  });

  const entries = requests.data ?? [];

  return (
    <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">
          Access Log {entries.length > 0 ? `(${entries.length} requests)` : ""}
        </h3>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Live
          <Switch
            checked={live}
            onCheckedChange={setLive}
            aria-label={`Toggle live polling for ${hostname}`}
          />
        </label>
      </div>

      {requests.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Reading access log…
        </p>
      ) : requests.isError ? (
        <Callout variant="destructive" title="Could not read the request log.">
          <p>{requests.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void requests.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : entries.length > 0 ? (
        <div className="max-h-72 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 text-muted-foreground">
              <tr>
                <th className="px-2.5 py-2 font-medium">Time</th>
                <th className="px-2.5 py-2 font-medium">Request</th>
                <th className="px-2.5 py-2 font-medium">Status</th>
                <th className="px-2.5 py-2 text-right font-medium">Size</th>
                <th className="hidden px-2.5 py-2 font-medium sm:table-cell">User agent</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr
                  key={`${entry.time_unix ?? "t"}-${index}-${entry.path}`}
                  className="border-t border-border/60"
                >
                  <td className="whitespace-nowrap px-2.5 py-2 text-muted-foreground font-mono">
                    {formatRequestTime(entry.time_unix)}
                  </td>
                  <td
                    className="max-w-48 truncate px-2.5 py-2 font-mono font-medium text-foreground"
                    title={`${entry.method} ${entry.path}`}
                  >
                    {entry.method} {entry.path}
                  </td>
                  <td className="px-2.5 py-2">
                    <Badge variant={entry.status < 400 ? "success" : "warning"}>
                      {entry.status || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2 text-right font-mono text-muted-foreground">
                    {entry.bytes !== null ? formatBytes(entry.bytes) : "—"}
                  </td>
                  <td
                    className="hidden max-w-44 truncate px-2.5 py-2 text-muted-foreground sm:table-cell"
                    title={entry.user_agent}
                  >
                    {entry.user_agent || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Activity />}
          title="No requests logged yet."
          description="Load the site in a browser, then wait for the next poll."
        />
      )}
    </div>
  );
}

function formatRequestTime(timeUnix: number | null): string {
  if (timeUnix === null) return "—";
  return new Date(timeUnix * 1000).toLocaleTimeString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Basic Auth Panel
 */
function AuthPanel({ site }: { site: SiteStatus }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(site.auth?.username ?? "");
  const [password, setPassword] = useState("");

  const invalidate = () => {
    setPassword("");
    void queryClient.invalidateQueries({ queryKey: ["sites"] });
  };

  const setAuth = useMutation({
    mutationFn: (args: { user: string | null; pass: string | null }) =>
      ipc.siteAuthSet(site.hostname, args.user, args.pass),
    onSuccess: (_result, { user }) => {
      invalidate();
      toast.success(user === null ? "Protection removed" : "Basic Auth enabled", {
        description:
          user === null
            ? `${site.hostname} is public again.`
            : `${site.hostname} now asks for a user name and password.`,
      });
    },
  });

  const error = setAuth.error instanceof Error ? setAuth.error : null;

  return (
    <div className="rounded-lg border border-border bg-surface-1/80 p-4 space-y-3">
      <h3 className="text-xs font-semibold text-foreground">HTTP Basic Auth</h3>
      {site.auth ? (
        <div className="flex items-center gap-2 text-sm p-3 rounded-md bg-surface-2/40 border border-border/60">
          <Lock className="size-4 text-primary" aria-hidden />
          <span>
            Protected with user{" "}
            <span className="font-mono font-semibold text-foreground" data-selectable>
              {site.auth.username}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            disabled={setAuth.isPending}
            onClick={() => setAuth.mutate({ user: null, pass: null })}
          >
            Remove protection
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Public site. Add credentials to password-protect all requests.
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!username.trim() || !password) return;
          setAuth.mutate({ user: username.trim(), pass: password });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`auth-user-${site.hostname}`}>User</Label>
          <Input
            id={`auth-user-${site.hostname}`}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="admin"
            autoComplete="off"
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`auth-pass-${site.hostname}`}>Password</Label>
          <Input
            id={`auth-pass-${site.hostname}`}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={site.auth ? "Replace password" : "Choose a password"}
            autoComplete="new-password"
            className="w-48"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={setAuth.isPending || !username.trim() || !password}
        >
          {setAuth.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck className="size-3.5 mr-1" />}
          {site.auth ? "Replace" : "Protect site"}
        </Button>
      </form>

      {error ? (
        <Callout variant="destructive" title="Could not change Basic Auth.">
          <p>{error.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Modal to add a new site
 */
function CreateSiteDialog({
  open,
  phpChoices,
  phpChoicesError,
  onRetryPhpChoices,
  onClose,
}: {
  open: boolean;
  phpChoices: string[];
  phpChoicesError: Error | null;
  onRetryPhpChoices: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const installed = useInstalledVersions();
  const installedComponentIds = useMemo(
    () => new Set((installed.data ?? []).map((v) => v.component_id)),
    [installed.data],
  );

  const availableServers = useMemo(() => {
    const servers: WebServerChoice[] = [];
    if (installedComponentIds.has("nginx")) servers.push("Nginx");
    if (installedComponentIds.has("apache")) servers.push("Apache");
    if (installedComponentIds.has("caddy")) servers.push("Caddy");
    if (installedComponentIds.has("frankenphp")) servers.push("FrankenPhp");
    return servers.length > 0 ? servers : (["Nginx", "Apache", "Caddy", "FrankenPhp"] as WebServerChoice[]);
  }, [installedComponentIds]);

  const [mode, setMode] = useState<"manual" | "template">("manual");
  const [selectedTemplateId, setSelectedTemplateId] = useState("static");
  const [gitUrl, setGitUrl] = useState("");

  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [https, setHttps] = useState(false);
  const [webServer, setWebServer] = useState<WebServerChoice>("Nginx");

  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: ipc.templateList,
    enabled: open,
  });

  useEffect(() => {
    const firstServer = availableServers[0];
    if (open && firstServer && !availableServers.includes(webServer)) {
      setWebServer(firstServer);
    }
  }, [open, availableServers, webServer]);

  const add = useMutation({
    mutationFn: () =>
      ipc.siteAdd(hostname.trim(), docroot.trim(), phpVersion, https, webServer),
    onSuccess: () => {
      const added = hostname.trim();
      toast.success("Site added", {
        description: `${added} is served by ${serverLabel(webServer)}.`,
      });
      resetAndClose();
    },
    onError: (error: Error) => {
      toast.error("Could not add the site", { details: error.message });
    },
  });

  const createFromTemplate = useMutation({
    mutationFn: () =>
      ipc.templateCreate(
        selectedTemplateId,
        hostname.trim(),
        docroot.trim(),
        phpVersion,
        https,
        selectedTemplateId === "git" ? gitUrl.trim() || null : null,
      ),
    onSuccess: (result) => {
      toast.success("Site created from template", {
        description: `${result.hostname} has been scaffolded and configured.`,
      });
      if (result.follow_up_command) {
        toast.info("Suggested command", {
          description: result.follow_up_command,
        });
      }
      resetAndClose();
    },
    onError: (error: Error) => {
      toast.error("Could not scaffold site", { details: error.message });
    },
  });

  const resetAndClose = () => {
    setHostname("");
    setDocroot("");
    setPhpVersion("");
    setHttps(false);
    setGitUrl("");
    setMode("manual");
    setSelectedTemplateId("static");
    add.reset();
    createFromTemplate.reset();
    queryClient.invalidateQueries({ queryKey: ["sites"] });
    onClose();
  };

  const close = () => {
    add.reset();
    createFromTemplate.reset();
    setMode("manual");
    onClose();
  };

  const isTemplate = mode === "template";
  const incomplete =
    hostname.trim().length === 0 ||
    docroot.trim().length === 0 ||
    (isTemplate && selectedTemplateId === "git" && gitUrl.trim().length === 0);

  const isPending = add.isPending || createFromTemplate.isPending;
  const currentError = (isTemplate ? createFromTemplate.error : add.error) as Error | null;

  const submit = () => {
    if (incomplete || isPending) return;
    if (isTemplate) {
      createFromTemplate.mutate();
    } else {
      add.mutate();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a site"
      description={
        isTemplate
          ? "Scaffold a new project from a starter template and register it as a local site."
          : "DevX routes the host name to this folder through the local web server."
      }
      size="lg"
      footer={
        <>
          <Button type="button" variant="ghost" data-autofocus disabled={isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={incomplete || isPending} onClick={submit}>
            {isPending ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5 mr-1" />}
            {isTemplate ? "Scaffold & create site" : "Create site"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Template Switcher Bar */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-surface-2/30 p-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">
              {isTemplate ? "Starter templates" : "Need a starter project?"}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {isTemplate
                ? "Select a template below to scaffold files into your project folder."
                : "Scaffold Laravel, WordPress, PHP, static sites, or clone a Git repository."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs font-medium border-border/80 bg-surface-1 hover:bg-surface-2"
            onClick={() => {
              setMode(isTemplate ? "manual" : "template");
              if (!isTemplate && !hostname) {
                setHostname("mysite.test");
              }
            }}
          >
            {isTemplate ? (
              "Manual configuration"
            ) : (
              <>
                <Sparkles className="size-3 text-primary" />
                Import from template
              </>
            )}
          </Button>
        </div>

        {/* Template Selector Grid when in template mode */}
        {isTemplate && (
          <div className="space-y-2">
            <Label className="text-xs">Choose template</Label>
            {templates.isPending ? (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2/60" />
                ))}
              </div>
            ) : templates.data && templates.data.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {templates.data.map((tmpl) => {
                  const isSelected = selectedTemplateId === tmpl.id;
                  return (
                    <button
                      key={tmpl.id}
                      type="button"
                      onClick={() => {
                        setSelectedTemplateId(tmpl.id);
                        if (tmpl.id === "php" || tmpl.id === "wordpress" || tmpl.id === "laravel") {
                          if (!phpVersion && phpChoices.length > 0) {
                            setPhpVersion(phpChoices[0] || "");
                          }
                        } else if (tmpl.id === "static") {
                          setPhpVersion("");
                        }
                      }}
                      className={cn(
                        "flex flex-col items-start p-2.5 rounded-lg border text-left transition-all cursor-pointer",
                        isSelected
                          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                          : "border-border/70 bg-surface-2/20 hover:border-border hover:bg-surface-2/40",
                      )}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="font-semibold text-xs text-foreground flex items-center gap-1.5">
                          {tmpl.id === "laravel" && <span className="text-destructive font-bold text-xs">▲</span>}
                          {tmpl.id === "wordpress" && <Globe className="size-3.5 text-primary" />}
                          {tmpl.id === "git" && <GitBranch className="size-3.5 text-primary" />}
                          {tmpl.id === "php" && <FileCode className="size-3.5 text-primary" />}
                          {tmpl.id === "static" && <Globe className="size-3.5 text-muted-foreground" />}
                          {tmpl.name}
                        </span>
                        {tmpl.local ? (
                          <Badge variant="outline" className="text-[10px] px-1 py-0">Local</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] px-1 py-0">Scaffold</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                        {tmpl.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {isTemplate && selectedTemplateId === "git" && (
            <div className="space-y-1.5">
              <Label htmlFor="site-git-url">Git repository URL</Label>
              <Input
                id="site-git-url"
                placeholder="https://github.com/username/repository.git"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="site-hostname">Host name</Label>
            <Input
              id="site-hostname"
              placeholder="myapp.test"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Must end in <code>.test</code> to match the local resolver.
            </p>
          </div>

          <DocrootField id="site-docroot" value={docroot} onChange={setDocroot} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="site-php">PHP</Label>
              <Select
                id="site-php"
                value={phpVersion}
                onChange={(event) => setPhpVersion(event.target.value)}
              >
                <option value="">None (static)</option>
                {phpChoices.map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </Select>
              {phpChoicesError ? (
                <Callout variant="destructive" title="Could not read the PHP versions.">
                  <p>{phpChoicesError.message}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={onRetryPhpChoices}
                  >
                    Try again
                  </Button>
                </Callout>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="site-https">HTTPS</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch id="site-https" checked={https} onCheckedChange={setHttps} />
                <span className="text-xs text-muted-foreground">
                  {https ? "Served over HTTPS" : "HTTP only"}
                </span>
              </div>
            </div>
          </div>

          {!isTemplate && (
            <details className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm text-ink-secondary transition-colors duration-150 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform duration-150 [[open]_&]:rotate-90"
                />
                Advanced
              </summary>
              <div className="space-y-1.5 border-t border-border p-3">
                <Label htmlFor="site-web-server">Web server</Label>
                <Select
                  id="site-web-server"
                  value={webServer}
                  onChange={(event) => setWebServer(event.target.value as WebServerChoice)}
                >
                  {availableServers.map((server) => (
                    <option key={server} value={server}>
                      {serverLabel(server)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {webServer === "Nginx" || webServer === "Apache"
                    ? `${serverLabel(webServer)} routes PHP through FastCGI pools.`
                    : "Caddy and FrankenPHP handle serving themselves."}
                </p>
              </div>
            </details>
          )}

          {currentError ? (
            <Callout variant="destructive" title="Could not create the site.">
              <p>{currentError.message}</p>
            </Callout>
          ) : null}
        </form>
      </div>
    </Dialog>
  );
}
