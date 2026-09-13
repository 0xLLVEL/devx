import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleAlert,
  Globe,
  Loader2,
  Lock,
  Network,
  Plus,
  ShieldCheck,
  Trash2,
  Variable,
} from "lucide-react";
import { useState } from "react";

import { HeroBand } from "@/components/hero-band";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { pickDirectory } from "@/lib/pick-directory";
import {
  ipc,
  type CaStatus,
  type DnsMode,
  type DnsStatus,
  type SiteStatus,
} from "@/lib/ipc";

/** Document-root input with the native Windows folder picker beside it. */
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
    <div className="space-y-1.5" >
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2" >
        <Input
          id={id}
          value={value}
          placeholder="C:\dev\myapp\public"
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
        />
        <Button type="button" variant="outline" onClick={() => void browse()}>
          Browse…
        </Button>
      </div>
    </div>
  );
}

/** Sites page: local .test domains routed to project folders. */
export function SitesPage() {
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  // Installed PHP versions feed the "runs on" choice; pools know their ports.
  const phpPools = useQuery({ queryKey: ["php-pools"], queryFn: ipc.phpPoolList });
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });

  const [adding, setAdding] = useState(false);
  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");
  const [https, setHttps] = useState(false);

  const add = useMutation({
    mutationFn: () => ipc.siteAdd(hostname.trim(), docroot.trim(), phpVersion, https),
    onSuccess: () => {
      setHostname("");
      setDocroot("");
      setPhpVersion("");
      setHttps(false);
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
  const aliasCount = allSites.reduce((sum, site) => sum + site.aliases.length, 0);
  const envCount = allSites.reduce((sum, site) => sum + Object.keys(site.env).length, 0);
  const httpsCount = allSites.filter((site) => site.https).length;
  const busy = add.isPending || remove.isPending;
  const error =
    add.error instanceof Error
      ? add.error
      : remove.error instanceof Error
        ? remove.error
        : null;

  return (
    <>
      <div className="space-y-4 p-6">
        <HeroBand
          title={
            allSites.length === 0
              ? "Your local network is empty."
              : `${allSites.length} site${allSites.length === 1 ? "" : "s"} served locally.`
          }
          description={`Anything under *.${dns.data?.suffix ?? "test"} resolves to this machine — the resolver covers every subdomain.`}
        />

        {allSites.length > 0 ? (
          <div className="animate-in fade-in slide-in-from-bottom-2 grid gap-4 duration-300 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon={<Globe className="size-4" />}
              label="Sites"
              value={String(allSites.length)}
              sub="local domains"
            />
            <StatTile
              icon={<Network className="size-4" />}
              label="Aliases"
              value={String(aliasCount)}
              sub="extra host names"
            />
            <StatTile
              icon={<Variable className="size-4" />}
              label="Env vars"
              value={String(envCount)}
              sub="exposed to PHP"
            />
            <StatTile
              icon={<Lock className="size-4" />}
              label="HTTPS"
              value={String(httpsCount)}
              sub="behind the local CA"
            />
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          {/* Main column: the sites themselves. */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Configured sites</h2>
              <Button size="sm" onClick={() => setAdding((open) => !open)}>
                <Plus />
                {adding ? "Close form" : "Add site"}
              </Button>
            </div>

            {adding ? (
              <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Add a site</CardTitle>
                  <CardDescription>
                    The host name must end in .test; pick the PHP version the
                    site runs on, or none for a static site.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="grid gap-3 sm:grid-cols-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      add.mutate();
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
                    </div>
                    <DocrootField id="site-docroot" value={docroot} onChange={setDocroot} />
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
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="site-https">HTTPS</Label>
                      <Select
                        id="site-https"
                        value={https ? "on" : "off"}
                        onChange={(event) => setHttps(event.target.value === "on")}
                      >
                        <option value="off">HTTP only</option>
                        <option value="on">HTTP + HTTPS</option>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <Button type="submit" size="sm" disabled={busy || add.isPending}>
                        {add.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Plus />
                        )}
                        Add site
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAdding(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>

                  {error ? (
                    <p
                      className="mt-3 flex items-center gap-2 text-sm text-destructive"
                      role="alert"
                    >
                      <CircleAlert className="size-4" />
                      {error.message}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
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
                description="Add one and DevX will route its .test host name through nginx to your project folder."
                action={
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus />
                    Create your first site
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-2">
                {allSites.map((site) => (
                  <SiteRow
                    key={site.hostname}
                    site={site}
                    phpChoices={phpChoices}
                    removing={remove.isPending && remove.variables === site.hostname}
                    onRemove={() => remove.mutate(site.hostname)}
                    onAliasAdd={(alias) => aliasAdd.mutate({ hostname: site.hostname, alias })}
                    onAliasDelete={(alias) => aliasDelete.mutate({ hostname: site.hostname, alias })}
                    aliasBusy={aliasAdd.isPending || aliasDelete.isPending}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* Rail: local-network plumbing. */}
          <div className="space-y-4">
            <DnsCard
              status={dns.data}
              mode={config.data?.network.dns_mode ?? "hosts_file"}
              busy={dnsStart.isPending || dnsStop.isPending}
              onStart={() => dnsStart.mutate()}
              onStop={() => dnsStop.mutate()}
            />

            <CaCard
              status={ca.data}
              onInstall={() => caInstall.mutate()}
              installing={caInstall.isPending}
            />

            <TemplatesCard phpChoices={phpChoices} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The bundled DNS resolver card: wildcard `*.test` resolution for every
 * site, including subdomains the hosts file could never list.
 */
function DnsCard({
  status,
  mode,
  busy,
  onStart,
  onStop,
}: {
  status?: DnsStatus;
  mode: DnsMode;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const queryClient = useQueryClient();
  const repair = useMutation({
    mutationFn: ipc.dnsRepair,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dns"] }),
  });

  if (!status) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4 text-muted-foreground" aria-hidden />
          {mode === "hosts_file" ? "Hosts file" : "DNS resolver"}
          {mode === "hosts_file" ? (
            <Badge variant="secondary">active</Badge>
          ) : status.running ? (
            <Badge variant="secondary">running :{status.port}</Badge>
          ) : (
            <Badge variant="outline">stopped</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {mode === "hosts_file"
            ? "Every configured name is written to the Windows hosts file (127.0.0.1). Exact names only — no wildcard subdomains."
            : status.running
              ? `Answers *.${status.suffix} (including subdomains) with loopback.`
              : "Start it to resolve *." + status.suffix + " names, including subdomains."}
        </CardDescription>
        {mode !== "hosts_file" && status.running && status.nrpt_active === false ? (
          <div className="space-y-2">
            <p className="text-xs text-warning">
              Windows is not routing *.{status.suffix} to DevX (privileged
              helper unavailable) — names will not resolve until the rule is
              installed.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={repair.isPending}
              onClick={() => repair.mutate()}
            >
              {repair.isPending ? <Loader2 className="animate-spin" /> : null}
              Fix routing
            </Button>
          </div>
        ) : null}
        {mode !== "hosts_file" && status.running && status.nrpt_active === null ? (
          <p className="text-xs text-muted-foreground">
            NRPT status unknown: the privileged helper did not answer.
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {mode === "hosts_file" ? (
          <p className="text-sm text-muted-foreground">
            Adding or removing a site keeps the hosts file in sync
            automatically — no resolver, no NRPT rule, no extra service.
          </p>
        ) : status.running ? (
          <Button size="sm" variant="outline" onClick={onStop} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Stop resolver
          </Button>
        ) : (
          <Button size="sm" onClick={onStart} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Network />}
            Start resolver
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The local CA's status card: install it once and every HTTPS site works.
 *
 * `trusted === null` means the privileged helper is unavailable, so DevX
 * cannot know — the honest answer is "unknown", not "no".
 */
function CaCard({
  status,
  onInstall,
  installing,
}: {
  status?: CaStatus;
  onInstall: () => void;
  installing: boolean;
}) {
  if (!status) {
    return null;
  }

  const trusted = status.trusted;
  const label =
    trusted === true
      ? "Trusted by this machine"
      : trusted === false
        ? "Not installed in the trust store"
        : "Trust store unknown (helper unavailable)";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Local certificate authority
        </CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        {trusted === false ? (
          <Button size="sm" onClick={onInstall} disabled={installing}>
            {installing ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Install CA
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {status.exists
              ? "The CA signs a certificate for each HTTPS site automatically."
              : "The CA is created the first time a site enables HTTPS."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One configured site. Clicking the row opens the editor: the serving
 * behavior (docroot, PHP, HTTPS) plus the alias and env sections.
 */
function SiteRow({
  site,
  phpChoices,
  removing,
  onRemove,
  onAliasAdd,
  onAliasDelete,
  aliasBusy,
}: {
  site: SiteStatus;
  phpChoices: string[];
  removing: boolean;
  onRemove: () => void;
  onAliasAdd: (alias: string) => void;
  onAliasDelete: (alias: string) => void;
  aliasBusy: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftDocroot, setDraftDocroot] = useState(site.docroot);
  const [draftPhp, setDraftPhp] = useState(site.php_version);
  const [draftHttps, setDraftHttps] = useState(site.https);

  // Re-adding the hostname is the edit path: `site_add` replaces the
  // location/behavior while carrying the env vars and aliases over.
  const save = useMutation({
    mutationFn: () => ipc.siteAdd(site.hostname, draftDocroot.trim(), draftPhp, draftHttps),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sites"] }),
  });

  const saveError = save.error instanceof Error ? save.error : null;

  return (
    <li>
      <Card className={editing ? "border-primary/40" : undefined}>
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            aria-label={`Edit ${site.hostname}`}
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium" data-selectable>
                  {site.hostname}
                </span>
                {site.php_version ? (
                  <Badge variant="secondary">PHP {site.php_version}</Badge>
                ) : (
                  <Badge variant="outline">static</Badge>
                )}
                {site.https ? (
                  <Badge variant="outline">
                    <Lock className="size-3" aria-hidden /> HTTPS
                  </Badge>
                ) : null}
                {Object.keys(site.env).length > 0 ? (
                  <Badge variant="outline">
                    <Variable className="size-3" aria-hidden /> {Object.keys(site.env).length} env
                  </Badge>
                ) : null}
                {site.aliases.length > 0 ? (
                  <Badge variant="outline">+{site.aliases.length} alias</Badge>
                ) : null}
              </span>
              <span
                className="mt-1 block truncate text-xs text-muted-foreground"
                data-selectable
              >
                {site.docroot}
              </span>
              {site.php_endpoint ? (
                <span
                  className="mt-0.5 block truncate font-mono text-xs text-muted-foreground"
                  data-selectable
                >
                  fastcgi_pass {site.php_endpoint}
                </span>
              ) : null}
            </span>
            <ChevronDown
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                editing ? "rotate-180" : ""
              }`}
            />
          </button>
          <Button
            variant="ghost"
            size="sm"
            disabled={removing}
            onClick={onRemove}
            aria-label={`Remove ${site.hostname}`}
          >
            {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </CardContent>
        {editing ? (
          <div className="animate-in fade-in slide-in-from-bottom-2 space-y-4 border-t border-border p-4 duration-300">
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Behavior
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <DocrootField
                  id={`edit-docroot-${site.hostname}`}
                  value={draftDocroot}
                  onChange={setDraftDocroot}
                />
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraftDocroot(site.docroot);
                    setDraftPhp(site.php_version);
                    setDraftHttps(site.https);
                    setEditing(false);
                  }}
                >
                  Close
                </Button>
              </div>
              {saveError ? (
                <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
                  <CircleAlert className="size-4" />
                  {saveError.message}
                </p>
              ) : null}
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Aliases
              </h3>
              <AliasPanel
                site={site}
                busy={aliasBusy}
                onAdd={onAliasAdd}
                onDelete={onAliasDelete}
              />
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Environment
              </h3>
              <EnvPanel site={site} />
            </section>
          </div>
        ) : null}
      </Card>
    </li>
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
    <div className="space-y-3 border-t border-border p-4">
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
 * Saving re-renders the nginx block and restarts nginx, so the values reach
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
    <div className="space-y-3 border-t border-border p-4">
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
 * New site from template: scaffold the docroot and register the site in one
 * step. Download-based templates (WordPress, Laravel) return a suggested
 * terminal command instead of fetching anything without a checksum.
 */
function TemplatesCard({ phpChoices }: { phpChoices: string[] }) {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: ipc.templateList });

  const [templateId, setTemplateId] = useState("static");
  const [hostname, setHostname] = useState("");
  const [docroot, setDocroot] = useState("");
  const [phpVersion, setPhpVersion] = useState("");

  const create = useMutation({
    mutationFn: () =>
      ipc.templateCreate(templateId, hostname.trim(), docroot.trim(), phpVersion, false),
    onSuccess: () => {
      setHostname("");
      setDocroot("");
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const chosen = (templates.data ?? []).find((template) => template.id === templateId);
  const error = create.error instanceof Error ? create.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">From template</CardTitle>
        <CardDescription>Scaffold the folder and register the site in one step.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
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
            <p className="text-xs text-muted-foreground">{chosen?.description}</p>
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
          <DocrootField id="template-docroot" label="Document root (new folder)" value={docroot} onChange={setDocroot} />
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
          <Button
            type="submit"
            size="sm"
            disabled={create.isPending || hostname.trim().length === 0 || docroot.trim().length === 0}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Create site
          </Button>
        </form>

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
      </CardContent>
    </Card>
  );
}
