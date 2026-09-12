import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Globe, Loader2, Share2, Trash2 } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <>
      <PageHeader
        title="Share"
        description="Expose a site on a public https://…trycloudflare.com URL — no account, no ports opened."
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
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
        ) : (sites.data ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No sites to share yet. Create one on the Sites page first.
          </div>
        ) : (
          <ul className="space-y-2">
            {(sites.data ?? []).map((site) => (
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

/** One site's share row: local host, tunnel state and public URL. */
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
              {shared ? (
                <Badge variant="secondary">
                  <Share2 className="size-3" aria-hidden /> shared
                </Badge>
              ) : (
                <Badge variant="outline">local only</Badge>
              )}
            </div>
            {shared && tunnel?.url ? (
              <a
                href={tunnel.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 flex items-center gap-1 pl-6 text-xs font-medium text-primary hover:underline"
              >
                <span className="font-mono" data-selectable>
                  {tunnel.url}
                </span>
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : shared ? (
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                Assigning a public URL…
              </p>
            ) : (
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
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
