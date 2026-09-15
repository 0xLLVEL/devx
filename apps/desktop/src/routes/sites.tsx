import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { openInBrowser } from "@/lib/open-url";
import { pickDirectory } from "@/lib/pick-directory";
import {
  ipc,
  type CaStatus,
  type DnsMode,
  type DnsStatus,
  type SiteStatus,
} from "@/lib/ipc";

type WebServerChoice = "Nginx" | "Caddy" | "FrankenPhp";

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
  return server === "Nginx" ? "nginx" : server === "Caddy" ? "Caddy" : "FrankenPHP";
}

/** The base URL a site is served on, scheme included. */
function siteUrl(site: SiteStatus): string {
  return `${site.https ? "https" : "http"}://${site.hostname}`;
}

/** Sites page: the local network as one dense monitor table. */
export function SitesPage() {
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  const phpPools = useQuery({ queryKey: ["php-pools"], queryFn: ipc.phpPoolList });
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });

  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [https, setHttps] = useState(false);
  const [webServer, setWebServer] = useState<WebServerChoice>("Nginx");

  const add = useMutation({
    mutationFn: () =>
      ipc.siteAdd(hostname.trim(), docroot.trim(), phpVersion, https, webServer),
    onSuccess: () => {
      setHostname("");
      setDocroot("");
      setPhpVersion("");
      setHttps(false);
      setWebServer("Nginx");
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });
  const remove = useMutation({
    mutationFn: (hostname: string) => ipc.siteRemove(hostname),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });
  const caInstall = useMutation({
    mutationFn: ipc.caInstall,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["ca"] }),
  });
  const dnsStart = useMutation({
    mutationFn: ipc.dnsStart,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dns"] }),
  });
  const dnsStop = useMutation({
    mutationFn: ipc.dnsStop,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dns"] }),
  });
  const aliasAdd = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) =>
      ipc.siteAliasAdd(hostname, alias),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });
  const aliasDelete = useMutation({
    mutationFn: ({ hostname, alias }: { hostname: string; alias: string }) =>
      ipc.siteAliasDelete(hostname, alias),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });

  const phpChoices = (phpPools.data ?? []).map((pool) => pool.version);
  const allSites = sites.data ?? [];
  const selectedSite = allSites.find((site) => site.hostname === selected) ?? null;
  const error =
    add.error instanceof Error
      ? add.error
      : remove.error instanceof Error
        ? remove.error
        : null;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          allSites.length === 0
            ? "Your local network is empty."
            : `${allSites.length} site${allSites.length === 1 ? "" : "s"} served locally.`
        }
        description={`Anything under *.${dns.data?.suffix ?? "test"} resolves to this machine — the resolver covers every subdomain.`}
        right={
          <Button size="sm" onClick={() => setAdding((open) => !open)}>
            <Plus />
            {adding ? "Close form" : "Add site"}
          </Button>
        }
      />

      <NetworkStrip
        dns={dns.data}
        mode={config.data?.network.dns_mode ?? "hosts_file"}
        ca={ca.data}
        dnsBusy={dnsStart.isPending || dnsStop.isPending}
        caInstalling={caInstall.isPending}
        onDnsStart={() => dnsStart.mutate()}
        onDnsStop={() => dnsStop.mutate()}
        onCaInstall={() => caInstall.mutate()}
      />

      {adding ? (
        <AddSiteForm
          hostname={hostname}
          docroot={docroot}
          phpVersion={phpVersion}
          https={https}
          webServer={webServer}
          phpChoices={phpChoices}
          busy={add.isPending}
          onHostname={setHostname}
          onDocroot={setDocroot}
          onPhp={setPhpVersion}
          onHttps={setHttps}
          onServer={setWebServer}
          onSubmit={() => add.mutate()}
          onClose={() => setAdding(false)}
          error={error}
        />
      ) : null}

      {sites.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading sites…
        </p>
      ) : allSites.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          title="No sites yet."
          description="Add one and DevX will route its .test host name to your project folder."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus />
              Create your first site
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Site</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Serves</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">Document root</th>
                <th className="px-3 py-2 font-medium">Health</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {allSites.map((site) => (
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
                  onRemove={() => remove.mutate(site.hostname)}
                >
                  {selectedSite !== null && selectedSite.hostname === site.hostname ? (
                    <SiteDetail
                      site={selectedSite}
                      phpChoices={phpChoices}
                      onAliasAdd={(alias) =>
                        aliasAdd.mutate({ hostname: site.hostname, alias })
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
  dnsBusy,
  caInstalling,
  onDnsStart,
  onDnsStop,
  onCaInstall,
}: {
  dns?: DnsStatus;
  mode: DnsMode;
  ca?: CaStatus;
  dnsBusy: boolean;
  caInstalling: boolean;
  onDnsStart: () => void;
  onDnsStop: () => void;
  onCaInstall: () => void;
}) {
  if (!dns || !ca) {
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
    </div>
  );
}

/** The collapsed add-site form: one compact grid row of fields. */
function AddSiteForm({
  hostname,
  docroot,
  phpVersion,
  https,
  webServer,
  phpChoices,
  busy,
  onHostname,
  onDocroot,
  onPhp,
  onHttps,
  onServer,
  onSubmit,
  onClose,
  error,
}: {
  hostname: string;
  docroot: string;
  phpVersion: string;
  https: boolean;
  webServer: WebServerChoice;
  phpChoices: string[];
  busy: boolean;
  onHostname: (value: string) => void;
  onDocroot: (value: string) => void;
  onPhp: (value: string) => void;
  onHttps: (value: boolean) => void;
  onServer: (value: WebServerChoice) => void;
  onSubmit: () => void;
  onClose: () => void;
  error: Error | null;
}) {
  return (
    <div className="rounded-md border border-primary/40 bg-card p-4">
      <form
        className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_9rem_9rem_8rem]"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="site-hostname">Host name</Label>
          <Input
            id="site-hostname"
            placeholder="myapp.test"
            value={hostname}
            onChange={(event) => onHostname(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <DocrootField id="site-docroot" value={docroot} onChange={onDocroot} />
        <div className="space-y-1.5">
          <Label htmlFor="site-php">PHP</Label>
          <Select
            id="site-php"
            value={phpVersion}
            onChange={(event) => onPhp(event.target.value)}
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
          <Label htmlFor="site-web-server">Web server</Label>
          <Select
            id="site-web-server"
            value={webServer}
            onChange={(event) => onServer(event.target.value as WebServerChoice)}
          >
            <option value="Nginx">nginx</option>
            <option value="Caddy">Caddy</option>
            <option value="FrankenPhp">FrankenPHP</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="site-https">HTTPS</Label>
          <Select
            id="site-https"
            value={https ? "on" : "off"}
            onChange={(event) => onHttps(event.target.value === "on")}
          >
            <option value="off">HTTP only</option>
            <option value="on">HTTP + HTTPS</option>
          </Select>
        </div>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onSubmit}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Add site
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One site in the monitor table. The row is the summary; clicking it opens
 * the full editor directly beneath, spanning the table width.
 */
function SiteRow({
  site,
  open,
  removing,
  onToggle,
  onRemove,
  children,
}: {
  site: SiteStatus;
  open: boolean;
  removing: boolean;
  onToggle: () => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <tr
        className={`border-t border-border transition-colors duration-150 ${
          open ? "bg-sidebar-accent/50" : "hover:bg-sidebar-accent/30"
        }`}
      >
        <td className="px-3 py-2">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2 text-left"
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
            <span className="font-mono text-sm font-medium" data-selectable>
              {site.hostname}
            </span>
            {site.auth ? (
              <Lock className="size-3 text-muted-foreground" aria-label="Basic auth on" />
            ) : null}
          </button>
        </td>
        <td className="hidden px-3 py-2 md:table-cell">
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
          className="hidden max-w-56 truncate px-3 py-2 font-mono text-xs text-muted-foreground lg:table-cell"
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openInBrowser(siteUrl(site))}
              aria-label={`Open ${site.hostname} in browser`}
            >
              <ExternalLink />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(siteUrl(site))}
              aria-label={`Copy ${site.hostname} URL`}
            >
              <Copy />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={removing}
              onClick={onRemove}
              aria-label={`Remove ${site.hostname}`}
            >
              {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-border bg-background">
          <td className="p-0" colSpan={5}>
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
  onAliasAdd: (alias: string) => void;
  onAliasDelete: (alias: string) => void;
  aliasBusy: boolean;
}) {
  const queryClient = useQueryClient();
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
              <option value="Nginx">nginx</option>
              <option value="Caddy">Caddy</option>
              <option value="FrankenPhp">FrankenPHP</option>
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
          <span className="font-mono text-xs text-muted-foreground" data-selectable>
            {site.docroot}
          </span>
        </div>
        {saveError ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {saveError.message}
          </p>
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
      <Button variant="ghost" size="sm" disabled aria-label={`Checking ${hostname}`}>
        <Loader2 className="animate-spin" />
      </Button>
    );
  }

  if (ping.isError) {
    return (
      <Badge variant="warning" className="max-w-40 truncate" title={String(ping.error)}>
        check failed
      </Badge>
    );
  }

  const result = ping.data;
  if (result === undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => ping.mutate()}
        aria-label={`Check ${hostname}`}
      >
        <Activity />
      </Button>
    );
  }

  const ok = result.status !== null && result.status < 500;
  return (
    <button
      type="button"
      onClick={() => ping.mutate()}
      title={
        result.error ?? `HTTP ${result.status} in ${result.latency_ms} ms — click to re-check`
      }
      className="cursor-pointer"
      aria-label={`Re-check ${hostname}`}
    >
      <Badge variant={ok ? "success" : "warning"}>
        {result.status !== null ? `${result.status} · ${result.latency_ms} ms` : "no response"}
      </Badge>
    </button>
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
  onAdd: (alias: string) => void;
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
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDelete(name)}
                aria-label={`Delete ${name}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No aliases. Add extra host names the site answers to alongside{" "}
          {site.hostname}.
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = alias.trim().toLowerCase();
          if (trimmed.length === 0) {
            return;
          }
          onAdd(trimmed);
          setAlias("");
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
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["sites"] });
  };
  const setEnv = useMutation({
    mutationFn: ({ key: k, value: v }: { key: string; value: string }) =>
      ipc.siteEnvSet(site.hostname, k, v),
    onSuccess: invalidate,
  });
  const deleteEnv = useMutation({
    mutationFn: (k: string) => ipc.siteEnvDelete(site.hostname, k),
    onSuccess: invalidate,
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
              <span className="min-w-0 truncate font-mono text-xs" data-selectable>
                <span className="font-medium">{k}</span>
                <span className="text-muted-foreground"> = {v}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={deleteEnv.isPending}
                onClick={() => deleteEnv.mutate(k)}
                aria-label={`Delete ${k}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No environment variables yet. They are exposed to the site's PHP
          requests, like a server-level .env.
        </p>
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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {error.message}
        </p>
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
        <p className="text-sm text-muted-foreground">
          {entries.length > 0
            ? `${entries.length} most recent request${entries.length === 1 ? "" : "s"}`
            : "No requests logged yet. Load the site in a browser, then wait for the next poll."}
        </p>
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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {requests.error.message}
        </p>
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
      ) : null}
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
  const [username, setUsername] = useState(site.auth?.username ?? "");
  const [password, setPassword] = useState("");

  const invalidate = () => {
    setPassword("");
    void queryClient.invalidateQueries({ queryKey: ["sites"] });
  };

  const setAuth = useMutation({
    mutationFn: (args: { user: string | null; pass: string | null }) =>
      ipc.siteAuthSet(site.hostname, args.user, args.pass),
    onSuccess: invalidate,
  });

  const error = setAuth.error instanceof Error ? setAuth.error : null;

  return (
    <div className="space-y-3">
      {site.auth ? (
        <p className="flex items-center gap-2 text-sm">
          <Lock className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Protected — user{" "}
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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {error.message}
        </p>
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
          WordPress, Laravel, static or a git clone — scaffolded and registered in one step.
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
          Create site
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
          <code className="font-mono text-xs" data-selectable>
            {create.data.follow_up_command}
          </code>
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
