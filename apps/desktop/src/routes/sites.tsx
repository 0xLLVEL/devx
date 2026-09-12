import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ipc, type CaStatus, type DnsStatus, type SiteStatus } from "@/lib/ipc";

/** Sites page: local .test domains routed to project folders. */
export function SitesPage() {
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  // Installed PHP versions feed the "runs on" choice; pools know their ports.
  const phpPools = useQuery({ queryKey: ["php-pools"], queryFn: ipc.phpPoolList });
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });

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
  const busy = add.isPending || remove.isPending;
  const error =
    add.error instanceof Error
      ? add.error
      : remove.error instanceof Error
        ? remove.error
        : null;

  return (
    <>
      <PageHeader
        title="Sites"
        description="Local .test domains backed by your project folders, served through nginx."
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <DnsCard
          status={dns.data}
          busy={dnsStart.isPending || dnsStop.isPending}
          onStart={() => dnsStart.mutate()}
          onStop={() => dnsStop.mutate()}
        />

        <CaCard status={ca.data} onInstall={() => caInstall.mutate()} installing={caInstall.isPending} />

        <Card>
          <CardHeader>
            <CardTitle>Add a site</CardTitle>
            <CardDescription>
              The host name must end in .test; pick the PHP version the site
              runs on, or none for a static site.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-[1fr_1.6fr_auto]"
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
              <div className="space-y-1.5">
                <Label htmlFor="site-docroot">Document root</Label>
                <Input
                  id="site-docroot"
                  placeholder="C:\dev\myapp\public"
                  value={docroot}
                  onChange={(event) => setDocroot(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-https">HTTPS</Label>
                <Select
                  id="site-https"
                  className="w-40"
                  value={https ? "on" : "off"}
                  onChange={(event) => setHttps(event.target.value === "on")}
                >
                  <option value="off">HTTP only</option>
                  <option value="on">HTTP + HTTPS</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-php">PHP</Label>
                <Select
                  id="site-php"
                  className="w-40"
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
              <div className="sm:col-span-4">
                <Button type="submit" size="sm" disabled={busy || add.isPending}>
                  {add.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  Add site
                </Button>
              </div>
            </form>

            {error ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
                <CircleAlert className="size-4" />
                {error.message}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <TemplatesCard phpChoices={phpChoices} />

        {sites.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading sites…
          </p>
        ) : (sites.data ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No sites yet. Add one above and DevX will route its .test host
            name through nginx to your project folder.
          </div>
        ) : (
          <ul className="space-y-2">
            {sites.data!.map((site) => (
              <SiteRow
                key={site.hostname}
                site={site}
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
    </>
  );
}

/**
 * The bundled DNS resolver card: wildcard `*.test` resolution for every
 * site, including subdomains the hosts file could never list.
 */
function DnsCard({
  status,
  busy,
  onStart,
  onStop,
}: {
  status?: DnsStatus;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  if (!status) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4 text-muted-foreground" aria-hidden />
          DNS resolver
          {status.running ? (
            <Badge variant="secondary">running :{status.port}</Badge>
          ) : (
            <Badge variant="outline">stopped</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {status.running
            ? `Answers *.${status.suffix} (including subdomains) with loopback.`
            : "Start it to resolve *." + status.suffix + " names, including subdomains."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status.running ? (
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

/** One configured site: host, docroot, PHP target, env vars, and remove. */
function SiteRow({
  site,
  removing,
  onRemove,
  onAliasAdd,
  onAliasDelete,
  aliasBusy,
}: {
  site: SiteStatus;
  removing: boolean;
  onRemove: () => void;
  onAliasAdd: (alias: string) => void;
  onAliasDelete: (alias: string) => void;
  aliasBusy: boolean;
}) {
  const [showEnv, setShowEnv] = useState(false);
  const [showAliases, setShowAliases] = useState(false);

  return (
    <li>
      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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
            </div>
            <p className="mt-1 truncate pl-6 text-xs text-muted-foreground" data-selectable>
              {site.docroot}
            </p>
            {site.php_endpoint ? (
              <p className="mt-0.5 pl-6 font-mono text-xs text-muted-foreground" data-selectable>
                fastcgi_pass {site.php_endpoint}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAliases((open) => !open)}
              aria-expanded={showAliases}
            >
              <Network />
              Aliases
            </Button>
            {site.php_version ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEnv((open) => !open)}
                aria-expanded={showEnv}
              >
                <Variable />
                Env
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={removing}
              onClick={onRemove}
              aria-label={`Remove ${site.hostname}`}
            >
              {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Remove
            </Button>
          </div>
        </CardContent>
        {showEnv ? <EnvPanel site={site} /> : null}
        {showAliases ? (
          <AliasPanel
            site={site}
            busy={aliasBusy}
            onAdd={onAliasAdd}
            onDelete={onAliasDelete}
          />
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
    mutationFn: () => ipc.templateCreate(templateId, hostname.trim(), docroot.trim(), phpVersion, false),
    onSuccess: () => {
      setHostname("");
      setDocroot("");
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const chosen = (templates.data ?? []).find((template) => template.id === templateId);
  const error =
    create.error instanceof Error ? create.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New site from template</CardTitle>
        <CardDescription>
          Scaffolds the folder and registers the .test site in one step.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="grid gap-3 sm:grid-cols-2"
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
          <div className="space-y-1.5">
            <Label htmlFor="template-docroot">Document root (new folder)</Label>
            <Input
              id="template-docroot"
              value={docroot}
              placeholder="C:\dev\myapp\public"
              onChange={(event) => setDocroot(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
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
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={create.isPending || hostname.trim().length === 0 || docroot.trim().length === 0}
            >
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              Create site
            </Button>
          </div>
        </form>

        {create.data?.follow_up_command ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
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
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
