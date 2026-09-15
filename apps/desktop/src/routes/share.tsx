import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ipc, type SiteStatus, type TunnelStatus } from "@/lib/ipc";

/** Share page: put a local site on a public URL with a quick tunnel. */
export function SharePage() {
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  // All tunnel statuses, refreshed on a short interval so the assigned
  // URL appears shortly after start without manual refreshing.
  const tunnels = useQuery({
    queryKey: ["tunnels", (sites.data ?? []).map((s) => s.hostname).join(",")],
    queryFn: async () => {
      const hostnames = sites.data ?? [];
      const statuses = await Promise.all(
        hostnames.map((site) => ipc.tunnelStatus(site.hostname)),
      );
      return Object.fromEntries(statuses.map((t) => [t.hostname, t]));
    },
    enabled: (sites.data ?? []).length > 0,
    refetchInterval: 3000,
  });

  const start = useMutation({
    mutationFn: (hostname: string) => ipc.tunnelStart(hostname),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
  });
  const stop = useMutation({
    mutationFn: (hostname: string) => ipc.tunnelStop(hostname),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
  });

  const allSites = sites.data ?? [];
  const sharedCount = allSites.filter(
    (site) => tunnels.data?.[site.hostname]?.running === true,
  ).length;

  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <>

      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        {allSites.length > 0 ? (
          <PageHeader
            title={
              sharedCount === 0
                ? "Everything is local only."
                : `${sharedCount} site${sharedCount === 1 ? "" : "s"} live on the internet.`
            }
            description={`${allSites.length} site${allSites.length === 1 ? "" : "s"} available to share. Quick tunnels are ephemeral — stop sharing and the URL dies with the process.`}
          />
        ) : null}

        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}

        {sites.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading sites…
          </p>
        ) : allSites.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No sites to share yet."
            description="Create one on the Sites page first, then come back to put it online."
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {allSites.map((site) => (
              <ShareRow
                key={site.hostname}
                site={site}
                tunnel={tunnels.data?.[site.hostname]}
                busy={busy}
                onStart={() => start.mutate(site.hostname)}
                onStop={() => stop.mutate(site.hostname)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** One site's share card: local host, tunnel state, public URL, and a copy button. */
function ShareRow({
  site,
  tunnel,
  busy,
  onStart,
  onStop,
}: {
  site: SiteStatus;
  tunnel?: TunnelStatus;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const shared = tunnel?.running === true;
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    if (!tunnel?.url) {
      return;
    }
    try {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied; the URL stays selectable on screen.
    }
  };

  return (
    <li>
      <Card
        className={
          shared
            ? "animate-in fade-in slide-in-from-bottom-2 border-primary/40 duration-300"
            : undefined
        }
      >
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${
                  shared ? "bg-success" : "bg-muted-foreground/40"
                }`}
              />
              <span className="font-mono text-sm font-medium" data-selectable>
                {site.hostname}
              </span>
              {shared ? (
                <Badge variant="secondary">
                  <Share2 className="size-3" aria-hidden /> shared
                </Badge>
              ) : (
                <Badge variant="outline">local only</Badge>
              )}
            </div>
            {shared && tunnel?.url ? (
              <p className="mt-1 flex items-center gap-1 pl-4 text-xs font-medium text-primary">
                <span className="font-mono" data-selectable>
                  {tunnel.url}
                </span>
                <a
                  href={tunnel.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${tunnel.url}`}
                  className="hover:underline"
                >
                  <ExternalLink className="size-3" aria-hidden />
                </a>
                <button
                  type="button"
                  onClick={() => void copyUrl()}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  aria-label="Copy the public URL"
                >
                  {copied ? <span className="text-success">Copied!</span> : <Copy className="size-3" />}
                </button>
              </p>
            ) : shared ? (
              <p className="mt-1 flex items-center gap-1 pl-4 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Assigning a public URL…
              </p>
            ) : (
              <p className="mt-1 pl-4 text-xs text-muted-foreground">
                Not shared. Anyone with the URL will see this site.
              </p>
            )}
          </div>
          {shared ? (
            <Button size="sm" variant="outline" onClick={onStop} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Stop sharing
            </Button>
          ) : (
            <Button size="sm" onClick={onStart} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Share2 />}
              Share
            </Button>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
