import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ipc, type SiteStatus, type TunnelStatus } from "@/lib/ipc";

/** A rejection that is not an `Error` still has to say something (§131 Rule 18). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Share page: put a local site on a public URL with a quick tunnel. */
export function SharePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
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
    onSuccess: (_status, hostname) => toast.success(`Sharing ${hostname}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
  });
  const stop = useMutation({
    mutationFn: (hostname: string) => ipc.tunnelStop(hostname),
    onSuccess: (_status, hostname) => toast.success(`Stopped sharing ${hostname}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
  });

  const allSites = sites.data ?? [];
  const sharedCount = allSites.filter(
    (site) => tunnels.data?.[site.hostname]?.running === true,
  ).length;

  const failure =
    start.error != null
      ? { title: "Could not start sharing this site.", message: errorText(start.error) }
      : stop.error != null
        ? { title: "Could not stop sharing this site.", message: errorText(stop.error) }
        : null;

  return (
    <>

      <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
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

        {failure ? (
          <Callout variant="destructive" title={failure.title}>
            <p>{failure.message}</p>
          </Callout>
        ) : null}

        {tunnels.isError ? (
          /* One query answers for every row, so its failure is stated once
             instead of repeated on each card. The rows stay usable: sharing a
             site does not need the status read. */
          <Callout variant="destructive" title="Could not read the share status.">
            <p>DevX asked about these sites and got no answer, so each card says unknown.</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void tunnels.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : null}

        {sites.isError ? (
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
        ) : sites.isPending ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">Loading sites…</span>
            {[0, 1].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-20 shimmer-skeleton rounded-lg"
              />
            ))}
          </div>
        ) : allSites.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No sites to share yet."
            description="Create one on the Sites page first, then come back to put it online."
            action={
              <Link to="/sites" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Open Sites
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {allSites.map((site) => (
              <ShareRow
                key={site.hostname}
                site={site}
                tunnel={tunnels.data?.[site.hostname]}
                checking={tunnels.isPending}
                busy={
                  (start.isPending && start.variables === site.hostname) ||
                  (stop.isPending && stop.variables === site.hostname)
                }
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
  checking,
  busy,
  onStart,
  onStop,
}: {
  site: SiteStatus;
  tunnel?: TunnelStatus;
  /** The status check for this row is still in flight. */
  checking: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const shared = tunnel?.running === true;
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation clears itself; stopping the share can unmount the row
  // before that happens, so the timer goes with the component.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
    },
    [],
  );

  const copyUrl = async () => {
    if (!tunnel?.url) {
      return;
    }
    try {
      await navigator.clipboard.writeText(tunnel.url);
      setCopied(true);
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch (cause) {
      // §131 Rule 18: the URL stays selectable on screen, but a copy that
      // failed must not look like one that worked.
      toast.error("Could not copy the public URL", { details: errorText(cause) });
    }
  };

  return (
    <li>
      <Card
        className={
          shared ? "border-line-strong" : undefined
        }
      >
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${
                  shared ? "bg-success" : "bg-muted-foreground/40"
                }`}
              />
              <span
                className="truncate font-mono text-sm font-medium"
                title={site.hostname}
                data-selectable
              >
                {site.hostname}
              </span>
              {shared ? (
                <Badge variant="default" className="shrink-0">
                  <Share2 className="size-3" aria-hidden /> shared
                </Badge>
              ) : (
                <Badge variant="outline" className="shrink-0">
                  local only
                </Badge>
              )}
            </div>
            {tunnel?.running ? (
              tunnel.url ? (
                <p className="mt-1 flex min-w-0 items-center gap-1 pl-4 text-xs font-medium text-foreground">
                  <span
                    className="min-w-0 break-all font-mono"
                    title={tunnel.url}
                    data-selectable
                  >
                    {tunnel.url}
                  </span>
                  <Tooltip label="Open the public URL">
                    <a
                      href={tunnel.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${tunnel.url}`}
                      className="shrink-0 hover:underline"
                    >
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </Tooltip>
                  <Tooltip label={copied ? "Copied" : "Copy the public URL"}>
                    <button
                      type="button"
                      onClick={() => void copyUrl()}
                      className="ml-1 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={copied ? "Copied to the clipboard" : "Copy the public URL"}
                    >
                      {copied ? (
                        <span className="text-success">Copied!</span>
                      ) : (
                        <Copy className="size-3" aria-hidden />
                      )}
                    </button>
                  </Tooltip>
                  {/* The visible "Copied!" is for sighted users only, so the
                      same confirmation is announced through a live region. */}
                  <span role="status" className="sr-only">
                    {copied ? "The public URL is on the clipboard." : ""}
                  </span>
                </p>
              ) : (
                <p className="mt-1 flex items-center gap-1 pl-4 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Assigning a public URL…
                </p>
              )
            ) : checking ? (
              <p className="mt-1 flex items-center gap-1 pl-4 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Checking the share status…
              </p>
            ) : tunnel === undefined ? (
              <p className="mt-1 pl-4 text-xs text-muted-foreground">
                Share status unknown; the last check did not answer.
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
