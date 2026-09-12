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

/** One configured site: host, docroot, PHP target, and a remove control. */
function SiteRow({
  site,
  removing,
  onRemove,
}: {
  site: SiteStatus;
  removing: boolean;
  onRemove: () => void;
}) {
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
        </CardContent>
      </Card>
    </li>
  );
}
