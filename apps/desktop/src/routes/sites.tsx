import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Variable,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { FilterBar, type ActiveFilter } from "@/components/filter-bar";
import { HostsButton } from "@/components/hosts-panel";
import { PageHeader } from "@/components/page-header";
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
 * folder dialog, with the chosen path shown as selectable mono text. The
 * path comes from the dialog, never from typing, so it is always a real
 * existing directory.
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
        <Button type="button" variant="outline" onClick={() => void browse()}>
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
      ? "Apache"
      : server === "Caddy"
        ? "Caddy"
        : "FrankenPHP";
}

/** The base URL a site is served on, scheme included. */
function siteUrl(site: SiteStatus): string {
  return `${site.https ? "https" : "http"}://${site.hostname}`;
}

/** The `@static` sentinel keeps "static" apart from a real PHP version. */
const STATIC = "@static";

/**
 * Sites page: the local domains DevX serves, as one dense table (§60) with a
 * compact filter row (§61) and the per-site actions attached to the row they
 * affect (§91).
 *
 * The table shows what the backend actually knows: host name, the URL with its
 * scheme, the runtime and web server rendering it, the docroot, and a health
 * check the user runs on demand. §23 also lists Restart and Disable; neither
 * has a command behind it, so neither appears here.
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
  const selectedSite = allSites.find((site) => site.hostname === selected) ?? null;

  // §131 Rule 17: the strip reports the mode the backend gave it, so until the
  // three probes answer it stays in a loading state instead of guessing one.
  const networkPending = dns.isPending || ca.isPending || config.isPending;
  const networkError = dns.error ?? ca.error ?? config.error;
  const phpChoicesError = phpPools.error instanceof Error ? phpPools.error : null;

  // §61: a control only exists when the data gives it something to do.
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

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          sites.isSuccess
            ? allSites.length === 0
              ? "Your local network is empty."
              : `${allSites.length} site${allSites.length === 1 ? "" : "s"} served locally.`
            : "Local sites"
        }
        description={
          dns.data
            ? `Anything under *.${dns.data.suffix} resolves to this machine: the resolver covers every subdomain.`
            : "Local host names served from this machine."
        }
        primaryAction={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            Add site
          </Button>
        }
      >
        {/* Below one site there is nothing to narrow down, so the row stays
            away entirely rather than sitting there inert. */}
        {allSites.length > 1 ? (
          <FilterBar active={activeFilters} onClear={clearFilters}>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="h-8 w-64 pl-8 text-xs"
                aria-label="Search sites"
                placeholder="Host name or path"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {serverKinds.length > 1 ? (
              <Select
                aria-label="Server"
                className="h-8 w-36 text-xs"
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
                className="h-8 w-36 text-xs"
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
          </FilterBar>
        ) : null}
      </PageHeader>

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

      <CreateSiteDialog
        open={creating}
        phpChoices={phpChoices}
        phpChoicesError={phpChoicesError}
        onRetryPhpChoices={() => void phpPools.refetch()}
        onClose={() => setCreating(false)}
      />

      {sites.isPending ? (
        /* §37/§121: the table's shape is known, so it loads as skeleton rows.
           The sentence the spinner used to carry stays for screen readers. */
        <div className="space-y-2 rounded-md border border-border p-3" role="status">
          <span className="sr-only">Loading sites…</span>
          {[0, 1, 2].map((row) => (
            <span
              key={row}
              aria-hidden
              className="block h-6 animate-pulse rounded-sm bg-secondary"
            />
          ))}
        </div>
      ) : sites.isError ? (
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
      ) : allSites.length === 0 ? (
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
      ) : visibleSites.length === 0 ? (
        /* The reset control is the filter row's own: a second "Clear filters"
           here would be the same button twice on one screen. */
        <EmptyState
          icon={<Search />}
          title="No site matches these filters."
          description={`${allSites.length} site${allSites.length === 1 ? "" : "s"} exist and none of them match the current filters.`}
        />
      ) : (
        /* §60: a bounded scroll area, so the header can stay put on a long
           list instead of scrolling away with the rows. */
        <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Site</th>
                <th className="px-3 py-2 font-medium">URL</th>
                <th className="px-3 py-2 font-medium">Serves</th>
                <th className="hidden px-3 py-2 font-medium xl:table-cell">
                  Document root
                </th>
                <th className="px-3 py-2 font-medium">Health</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleSites.map((site) => (
                <SiteRow
                  key={site.hostname}
                  site={site}
                  open={selected === site.hostname}
                  removing={remove.isPending && remove.variables === site.hostname}
                  onToggle={() =>
                    setSelected((current) =>
                      current === site.hostname ? null : site.hostname,
                    )
                  }
                  onOpenFolder={() => void openFolderFor(site)}
                  onCopyUrl={() => {
                    void navigator.clipboard.writeText(siteUrl(site));
                    toast.success("URL copied", { description: siteUrl(site) });
                  }}
                  onRemove={() => setRemoveTarget(site)}
                >
                  {selectedSite !== null && selectedSite.hostname === site.hostname ? (
                    <SiteDetail
                      site={selectedSite}
                      phpChoices={phpChoices}
                      onAliasAdd={(alias) =>
                        // The panel clears the field only once this resolves,
                        // so a failed add keeps the typed name (§54).
                        aliasAdd.mutateAsync({ hostname: site.hostname, alias })
                      }
                      onAliasDelete={(alias) =>
                        aliasDelete.mutate({ hostname: site.hostname, alias })
                      }
                      aliasBusy={aliasAdd.isPending || aliasDelete.isPending}
                    />
                  ) : null}
                </SiteRow>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TemplatesSection phpChoices={phpChoices} />

      {/* §35/§78: the confirmation names the host and the docroot, and says
          what is not touched. Removing a site never deletes files. */}
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
            {/* §96: a Windows path has no spaces to break on, so `break-all`
                is what keeps it inside the 400px confirmation. */}
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

/**
 * One flat strip of background plumbing: name resolution and certificate
 * trust as dot + label + inline action. Reads as a status line, not as two
 * side-quest cards competing with the site table.
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
      <div
        className="flex items-center gap-6 rounded-md border border-border bg-card px-3 py-2"
        role="status"
      >
        <span className="sr-only">Loading network status</span>
        <span aria-hidden className="block h-4 w-40 animate-pulse rounded-sm bg-secondary" />
        <span aria-hidden className="block h-4 w-24 animate-pulse rounded-sm bg-secondary" />
      </div>
    );
  }

  // §131 Rule 18: an unreadable probe is an error the user can act on, not an
  // empty strip that vanishes off the page.
  if (error) {
    return (
      <Callout variant="destructive" title="Could not read the network status.">
        <p>{error.message}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      </Callout>
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
        ? `Resolver :${dns.port} · *.${dns.suffix}`
        : "Resolver stopped";
  const resolverProblem =
    mode !== "hosts_file" && (!dns.running || dns.nrpt_active === false);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${resolverHealthy ? "bg-success" : "bg-warning"}`}
        />
        <span className={resolverProblem ? "text-warning" : undefined}>{resolverLabel}</span>
        {mode !== "hosts_file" ? (
          dns.running ? (
            <Button size="sm" variant="ghost" onClick={onDnsStop} disabled={dnsBusy}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onDnsStart} disabled={dnsBusy}>
              Start
            </Button>
          )
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${ca.trusted ? "bg-success" : "bg-warning"}`}
        />
        <span className={ca.trusted ? undefined : "text-warning"}>
          {ca.trusted === true
            ? "CA trusted"
            : ca.trusted === false
              ? "CA not installed"
              : "CA trust unknown"}
        </span>
        {ca.trusted === false ? (
          <Button size="sm" variant="ghost" onClick={onCaInstall} disabled={caInstalling}>
            {caInstalling ? <Loader2 className="animate-spin" /> : null}
            Install CA
          </Button>
        ) : null}
      </span>
      <span className="ml-auto hidden text-xs text-muted-foreground xl:block">
        {mode === "hosts_file"
          ? "Names resolve through the Windows hosts file."
          : dns.running
            ? "The bundled resolver answers every subdomain."
            : "Start the resolver to cover subdomains too."}
      </span>
      {/* §111: the hosts manager is reached from here because this strip is
          where name resolution is already explained. It stays reachable in
          resolver mode too — entries written earlier are still on disk. */}
      <HostsButton />
    </div>
  );
}

/**
 * Create Site (§24) as a modal (§34).
 *
 * The dialog carries exactly the five things `site_add` accepts. §24 also
 * sketches Project, Certificate, Port, a custom index and proxy headers; there
 * is no command behind any of them, so none of them is drawn as a control that
 * cannot work. The one supported choice that is not in the common path, the
 * web server, sits in §90's Advanced section, closed by default.
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

  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [https, setHttps] = useState(false);
  const [webServer, setWebServer] = useState<WebServerChoice>("Nginx");

  useEffect(() => {
    if (open && availableServers.length > 0 && !availableServers.includes(webServer)) {
      setWebServer(availableServers[0]);
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
      setHostname("");
      setDocroot("");
      setPhpVersion("");
      setHttps(false);
      setWebServer(availableServers[0] ?? "Nginx");
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
    onError: (error: Error) => {
      // §77: the backend's own words, both where the user is looking and in
      // the notification stack for the "View Details" path.
      toast.error("Could not add the site", { details: error.message });
    },
  });

  const incomplete = hostname.trim().length === 0 || docroot.trim().length === 0;
  const error = add.error instanceof Error ? add.error : null;

  const close = () => {
    // A stale error must not greet the user on the next open.
    add.reset();
    onClose();
  };

  const submit = () => {
    if (!incomplete && !add.isPending) {
      add.mutate();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a site"
      description="DevX routes the host name to this folder through the local web server."
      size="lg"
      footer={
        <>
          <Button type="button" variant="ghost" data-autofocus disabled={add.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={incomplete || add.isPending} onClick={submit}>
            {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Create site
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
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
            {/* An empty list here means "no PHP pool", unless the pool list
                itself failed: then saying so beats a fake static-only choose. */}
            {phpChoicesError ? (
              /* §39: the dialog is where the missing list is felt, so the retry
                 is here rather than only on the page behind it. */
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

        {error ? (
          <Callout variant="destructive" title="Could not create the site.">
            <p>{error.message}</p>
          </Callout>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * One site in the monitor table. The row is the summary; clicking its name
 * opens the full editor directly beneath, spanning the table width, and the
 * row keeps the §60 selected surface while it is open.
 */
function SiteRow({
  site,
  open,
  removing,
  onToggle,
  onOpenFolder,
  onCopyUrl,
  onRemove,
  children,
}: {
  site: SiteStatus;
  open: boolean;
  removing: boolean;
  onToggle: () => void;
  onOpenFolder: () => void;
  onCopyUrl: () => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  // §23's action list minus the two entries with no command behind them
  // (Restart, Disable). §91: the everyday one stays on the row, the rest sit
  // one click away (§62). §47 hands the same list to the row's context menu,
  // destructive entry last.
  const actions: MenuItem[] = [
    { id: "folder", label: "Open folder", icon: FolderOpen, onSelect: onOpenFolder },
    { id: "copy", label: "Copy URL", icon: Copy, onSelect: onCopyUrl },
    {
      id: "remove",
      label: "Remove site",
      icon: Trash2,
      destructive: true,
      disabled: removing,
      onSelect: onRemove,
    },
  ];
  const menu = useContextMenu({
    label: `Actions for ${site.hostname}`,
    items: actions,
  });

  return (
    <>
      <tr
        onContextMenu={menu.onContextMenu}
        className={`border-t border-border transition-colors duration-150 ${
          open ? "bg-primary-soft" : "hover:bg-hover"
        }`}
      >
        <td className="px-3 py-2">
          <button
            type="button"
            className="flex max-w-[18rem] cursor-pointer items-center gap-2 text-left"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`Edit ${site.hostname}`}
          >
            <ChevronRight
              aria-hidden
              className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${
                open ? "rotate-90" : ""
              }`}
            />
            {/* §95: a long host name shortens in the cell, not on the click. */}
            <span
              className="min-w-0 truncate font-mono text-sm font-medium"
              title={site.hostname}
              data-selectable
            >
              {site.hostname}
            </span>
            {site.auth ? (
              <Lock className="size-3 text-muted-foreground" aria-label="Basic auth on" />
            ) : null}
          </button>
        </td>
        <td className="px-3 py-2">
          <span
            className="font-mono text-xs text-ink-secondary"
            data-selectable
            title={siteUrl(site)}
          >
            {siteUrl(site)}
          </span>
        </td>
        <td className="px-3 py-2">
          <span className="flex flex-wrap items-center gap-1.5">
            {site.php_version ? (
              <Badge variant="secondary">PHP {site.php_version}</Badge>
            ) : (
              <Badge variant="outline">static</Badge>
            )}
            <Badge variant="outline">{serverLabel(site.web_server)}</Badge>
            {site.https ? (
              <Badge variant="outline">
                <Lock className="size-3" aria-hidden /> HTTPS
              </Badge>
            ) : null}
            {site.aliases.length > 0 ? (
              <Badge variant="outline">+{site.aliases.length} alias</Badge>
            ) : null}
            {Object.keys(site.env).length > 0 ? (
              <Badge variant="outline">{Object.keys(site.env).length} env</Badge>
            ) : null}
          </span>
          {site.php_endpoint ? (
            <span
              className="mt-0.5 block font-mono text-xs text-muted-foreground"
              data-selectable
            >
              fastcgi_pass {site.php_endpoint}
            </span>
          ) : null}
        </td>
        <td
          className="hidden max-w-56 truncate px-3 py-2 font-mono text-xs text-muted-foreground xl:table-cell"
          data-selectable
          title={site.docroot}
        >
          {site.docroot}
        </td>
        <td className="px-3 py-2">
          <PingButton hostname={site.hostname} />
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            <Tooltip label={`Open ${site.hostname} in browser`}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openInBrowser(siteUrl(site))}
                aria-label={`Open ${site.hostname} in browser`}
              >
                <ExternalLink />
              </Button>
            </Tooltip>
            <OverflowMenu label={`More actions for ${site.hostname}`} items={actions} />
          </div>
        </td>
        {/* A portal: it renders to the body, so the row's markup is unchanged. */}
        {menu.panel}
      </tr>
      {open ? (
        <tr className="border-t border-border bg-background">
          <td className="p-0" colSpan={6}>
            {children}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The full editor for one site, spanning the table width as a two-column
 * workspace: serving behavior on the left; aliases, env, auth and requests
 * on the right behind tabs, so only one per-site surface shows at a time.
 */
function SiteDetail({
  site,
  phpChoices,
  onAliasAdd,
  onAliasDelete,
  aliasBusy,
}: {
  site: SiteStatus;
  phpChoices: string[];
  onAliasAdd: (alias: string) => Promise<unknown>;
  onAliasDelete: (alias: string) => void;
  aliasBusy: boolean;
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
  const [section, setSection] = useState<"aliases" | "env" | "auth" | "requests">(
    "aliases",
  );

  // Re-adding the hostname is the edit path: `site_add` replaces the
  // location/behavior while carrying the env vars and aliases over.
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
    <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground">Behavior</h3>
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
          {/* §95: the path gives way to the button instead of pushing it off
              the row; the full value stays one hover away. */}
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            data-selectable
            title={site.docroot}
          >
            {site.docroot}
          </span>
        </div>
        {saveError ? (
          <Callout variant="destructive" title="Could not save the changes.">
            <p>{saveError.message}</p>
          </Callout>
        ) : null}
      </section>

      <section className="space-y-3">
        <div
          role="tablist"
          aria-label="Site sections"
          className="flex gap-1 border-b border-border"
        >
          {(
            [
              [
                "aliases",
                `Aliases${site.aliases.length > 0 ? ` (${site.aliases.length})` : ""}`,
              ],
              [
                "env",
                `Env${Object.keys(site.env).length > 0 ? ` (${Object.keys(site.env).length})` : ""}`,
              ],
              ["auth", site.auth ? "Auth on" : "Auth"],
              ["requests", "Requests"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={`relative cursor-pointer px-3 py-2 text-sm transition-colors duration-150 ${
                section === id
                  ? "font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {section === "aliases" ? (
          <AliasPanel
            site={site}
            busy={aliasBusy}
            onAdd={onAliasAdd}
            onDelete={onAliasDelete}
          />
        ) : null}
        {section === "env" ? <EnvPanel site={site} /> : null}
        {section === "auth" ? <AuthPanel site={site} /> : null}
        {section === "requests" ? <RequestsPanel hostname={site.hostname} /> : null}
      </section>
    </div>
  );
}

/**
 * Health check for one site: runs `site_ping` on demand and shows the HTTP
 * status or the failure inline as a badge, replacing itself while in flight.
 */
function PingButton({ hostname }: { hostname: string }) {
  const ping = useMutation({ mutationFn: () => ipc.sitePing(hostname) });

  if (ping.isPending) {
    return (
      <Tooltip label={`Checking ${hostname}`}>
        <Button variant="ghost" size="sm" disabled aria-label={`Checking ${hostname}`}>
          <Loader2 className="animate-spin" />
        </Button>
      </Tooltip>
    );
  }

  // §39/§94: the badge names the failure; the backend's own words sit behind
  // the same tooltip a truncated cell uses, since `title` alone reaches
  // neither the keyboard nor the screen reader.
  if (ping.isError) {
    return (
      <Tooltip label={ping.error.message}>
        <Badge
          variant="warning"
          className="max-w-40 truncate"
          title={ping.error.message}
        >
          check failed
        </Badge>
      </Tooltip>
    );
  }

  const result = ping.data;
  if (result === undefined) {
    return (
      <Tooltip label={`Check ${hostname}`}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => ping.mutate()}
          aria-label={`Check ${hostname}`}
        >
          <Activity />
        </Button>
      </Tooltip>
    );
  }

  const ok = result.status !== null && result.status < 500;
  const detail =
    result.error ?? `HTTP ${result.status} in ${result.latency_ms} ms. Click to re-check.`;
  return (
    <Tooltip label={detail}>
      <button
        type="button"
        onClick={() => ping.mutate()}
        title={detail}
        className="cursor-pointer"
        aria-label={`Re-check ${hostname}`}
      >
        <Badge variant={ok ? "success" : "warning"}>
          {result.status !== null ? `${result.status} · ${result.latency_ms} ms` : "no response"}
        </Badge>
      </button>
    </Tooltip>
  );
}

/**
 * Edits a site's alias host names: the nginx `server_name` list. Each alias
 * resolves like the primary name and shows up in the same server block.
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
    <div className="space-y-3">
      {entries.length > 0 ? (
        <ul className="space-y-1.5">
          {entries.map((name) => (
            <li key={name} className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs" data-selectable>
                {name}
              </span>
              <Tooltip label={`Delete ${name}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDelete(name)}
                  aria-label={`Delete ${name}`}
                >
                  <Trash2 />
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
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = alias.trim().toLowerCase();
          if (trimmed.length === 0) {
            return;
          }
          // §54: the field clears only after the backend took the alias, so a
          // rejected add keeps the typed name for a one-click retry; the
          // mutation's own toast has already reported the failure.
          void onAdd(trimmed)
            .then(() => setAlias(""))
            .catch(() => undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`alias-${site.hostname}`}>Alias host name</Label>
          <Input
            id={`alias-${site.hostname}`}
            value={alias}
            placeholder={`www.${site.hostname}`}
            className="w-64 font-mono text-xs"
            onChange={(event) => setAlias(event.target.value.toLowerCase())}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy || alias.trim().length === 0}>
          <Plus />
          Add alias
        </Button>
      </form>
    </div>
  );
}

/**
 * Edits a site's environment variables: one row per var, plus an add form.
 *
 * Saving re-renders the block and restarts the server, so the values reach
 * the site's PHP as `fastcgi_param`s immediately.
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
    <div className="space-y-3">
      {site.php_version ? null : (
        <p className="text-xs text-muted-foreground">
          This site is static; environment variables only reach PHP sites.
        </p>
      )}

      {entries.length > 0 ? (
        <ul className="space-y-1.5">
          {entries.map(([k, v]) => (
            <li key={k} className="flex items-center justify-between gap-3">
              {/* §95: the row truncates, so the full assignment stays in the
                  native tooltip rather than being lost behind the ellipsis. */}
              <span
                className="min-w-0 truncate font-mono text-xs"
                data-selectable
                title={`${k} = ${v}`}
              >
                <span className="font-medium">{k}</span>
                <span className="text-muted-foreground"> = {v}</span>
              </span>
              <Tooltip label={`Delete ${k}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deleteEnv.isPending}
                  onClick={() => deleteEnv.mutate(k)}
                  aria-label={`Delete ${k}`}
                >
                  <Trash2 />
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
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim().length === 0) {
            return;
          }
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
        <div className="space-y-1.5">
          <Label htmlFor={`env-value-${site.hostname}`}>Value</Label>
          <Input
            id={`env-value-${site.hostname}`}
            value={value}
            placeholder="local"
            className="w-56"
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" size="sm" disabled={setEnv.isPending || key.trim().length === 0}>
          {setEnv.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          Set
        </Button>
      </form>

      {error ? (
        <Callout variant="destructive" title="Could not update the environment variable.">
          <p>{error.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * The site's recent requests, parsed live from its access log. Polls while
 * the tab is open — it is an inspector, not a dashboard chart.
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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {/* The empty case is the body's own EmptyState (§38), so the header
            carries the count only when there is one; `ml-auto` keeps the
            toggle on the right either way. */}
        {entries.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {entries.length} most recent request{entries.length === 1 ? "" : "s"}
          </p>
        ) : null}
        <label className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
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
        <div className="max-h-64 overflow-y-auto rounded-sm border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">Time</th>
                <th className="px-2 py-1.5 font-medium">Request</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
                <th className="px-2 py-1.5 text-right font-medium">Size</th>
                <th className="hidden px-2 py-1.5 font-medium sm:table-cell">User agent</th>
              </tr>
            </thead>
            <tbody className="data-value">
              {entries.map((entry, index) => (
                <tr
                  key={`${entry.time_unix ?? "t"}-${index}-${entry.path}`}
                  className="border-t border-border/60"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                    {formatRequestTime(entry.time_unix)}
                  </td>
                  <td
                    className="max-w-48 truncate px-2 py-1.5 font-mono"
                    title={`${entry.method} ${entry.path}`}
                  >
                    {entry.method} {entry.path}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge variant={entry.status < 400 ? "success" : "warning"}>
                      {entry.status || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right text-muted-foreground">
                    {entry.bytes !== null ? formatBytes(entry.bytes) : "—"}
                  </td>
                  <td
                    className="hidden max-w-40 truncate px-2 py-1.5 text-muted-foreground sm:table-cell"
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

/** Formats a Unix-seconds timestamp as a local HH:MM:SS. */
function formatRequestTime(timeUnix: number | null): string {
  if (timeUnix === null) {
    return "—";
  }
  return new Date(timeUnix * 1000).toLocaleTimeString();
}

/** Formats a byte count for the request table. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Toggles HTTP Basic Auth on a site. The password is sent once to the
 * backend, hashed to an htpasswd bcrypt hash, and never stored in plain
 * text; only the user name and a locked/unlocked state appear in the UI.
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
    <div className="space-y-3">
      {site.auth ? (
        <p className="flex items-center gap-2 text-sm">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Protected. User{" "}
            <span className="font-mono text-xs" data-selectable>
              {site.auth.username}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={setAuth.isPending}
            onClick={() => setAuth.mutate({ user: null, pass: null })}
          >
            Remove protection
          </Button>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Public site. Add a user name and password to require HTTP Basic Auth
          for every request.
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
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
          {setAuth.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
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
 * New site from template: scaffold the docroot and register the site in one
 * step. Download-based templates (WordPress, Laravel) return a suggested
 * terminal command instead of fetching anything without a checksum.
 */
function TemplatesSection({ phpChoices }: { phpChoices: string[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const templates = useQuery({ queryKey: ["templates"], queryFn: ipc.templateList });

  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState("static");
  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [gitUrl, setGitUrl] = useState("");

  const create = useMutation({
    mutationFn: () =>
      ipc.templateCreate(
        templateId,
        hostname.trim(),
        docroot.trim(),
        phpVersion,
        false,
        templateId === "git" ? gitUrl.trim() || null : null,
      ),
    onSuccess: () => {
      const created = hostname.trim();
      toast.success("Site created", {
        description: `${created} was scaffolded and registered.`,
      });
      setHostname("");
      setDocroot("");
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const chosen = (templates.data ?? []).find((template) => template.id === templateId);
  const error = create.error instanceof Error ? create.error : null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <Plus className="size-4" aria-hidden />
        Create from template…
        <span className="ml-auto hidden text-xs xl:block">
          WordPress, Laravel, static or a git clone, scaffolded and registered in one step.
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <form
        className="grid items-end gap-3 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_9rem]"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="template-id">Template</Label>
          <Select
            id="template-id"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            {(templates.data ?? []).map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="template-hostname">Site host name</Label>
          <Input
            id="template-hostname"
            value={hostname}
            placeholder="myapp.test"
            onChange={(event) => setHostname(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <DocrootField
          id="template-docroot"
          label="Document root (new folder)"
          value={docroot}
          onChange={setDocroot}
        />
        <div className="space-y-1.5">
          <Label htmlFor="template-php">PHP version</Label>
          <Select
            id="template-php"
            value={phpVersion}
            onChange={(event) => setPhpVersion(event.target.value)}
            disabled={templateId === "static"}
          >
            <option value="">None (static)</option>
            {phpChoices.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </Select>
        </div>
        {templateId === "git" ? (
          <div className="space-y-1.5 md:col-span-4">
            <Label htmlFor="template-git-url">Repository URL</Label>
            <Input
              id="template-git-url"
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              placeholder="https://github.com/user/repo.git"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        ) : null}
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            create.isPending ||
            hostname.trim().length === 0 ||
            docroot.trim().length === 0 ||
            (templateId === "git" && gitUrl.trim().length === 0)
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          Create from template
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
        <span className="text-xs text-muted-foreground">{chosen?.description}</span>
      </div>

      {create.data?.follow_up_command ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="mb-1 text-xs text-muted-foreground">
            Finish the scaffold in the Terminal (runtimes are already on
            PATH):
          </p>
          {/* §95: a scaffold command can be longer than the panel. */}
          <code className="block break-all font-mono text-xs" data-selectable>
            {create.data.follow_up_command}
          </code>
        </div>
      ) : null}
      {error ? (
        <Callout
          variant="destructive"
          title="Could not create the site from the template."
          className="mt-3"
        >
          <p>{error.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}
