import {
  Activity,
  CircleAlert,
  Globe,
  HardDrive,
  Loader2,
  Package,
  Play,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ipc, ipcEvents, type ServiceMetrics } from "@/lib/ipc";
import { summarizeMetrics, useServiceMetrics, useSites } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Landing page — a Real-Time Monitor (MASTER.md). The one decision here is
 * "is anything broken, and what do I click": the service monitor leads as a
 * dense table, failed services sort first, and the side summary stays
 * secondary with real numbers only.
 */
export function DashboardPage() {
  const sites = useSites();
  const metrics = useServiceMetrics();
  const queryClient = useQueryClient();

  const invalidateServices = () => {
    void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
  const startAll = useMutation({
    mutationFn: ipc.servicesStartAll,
    onSettled: invalidateServices,
  });
  const stopAll = useMutation({
    mutationFn: ipc.servicesStopAll,
    onSettled: invalidateServices,
  });

  const entries = metrics.data ?? [];
  const { runningCount, failed, cpu, memory } = summarizeMetrics(entries);
  const activity = useActivityFeed();
  const stoppedCount = entries.filter((entry) => entry.state === "stopped" || entry.state === "failed").length;
  const batchBusy = startAll.isPending || stopAll.isPending;

  return (
    <div className="space-y-5 p-5">
      <PageHeader
        title={
          entries.length === 0
            ? "Your environment is waiting."
            : failed.length > 0
              ? `${failed.length} service${failed.length === 1 ? "" : "s"} failed.`
              : runningCount === entries.length
                ? "Everything is running."
                : `${runningCount} of ${entries.length} services up.`
        }
        description={
          <>
            {sites.data?.length ?? 0} site
            {(sites.data?.length ?? 0) === 1 ? "" : "s"} served locally ·{" "}
            {cpu.toFixed(0)}% CPU · {formatBytes(memory)} resident
          </>
        }
        right={
          entries.length > 0 ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={batchBusy || stoppedCount === 0}
                onClick={() => startAll.mutate()}
              >
                {startAll.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                Start all
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={batchBusy || runningCount === 0}
                onClick={() => stopAll.mutate()}
              >
                {stopAll.isPending ? <Loader2 className="animate-spin" /> : <Square />}
                Stop all
              </Button>
            </div>
          ) : null
        }
      />

      {failed.length > 0 ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
              {failed.map((entry) => entry.id).join(", ")}{" "}
              {failed.length === 1 ? "is" : "are"} failing. Check its log on the
              Services page and restart it.
            </p>
            <Link
              to="/services"
              className="text-sm font-medium text-primary hover:underline"
            >
              Open Services
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <ServicesBoard entries={entries} />
        <div className="grid content-start gap-4">
          <StatStrip
            running={runningCount}
            total={entries.length}
            cpu={cpu}
            memory={memory}
            sites={sites.data?.length ?? 0}
          />
          <SitesSnapshot sites={sites.data ?? []} />
          <ActivityCard entries={activity} />
          <ResourcesCard />
        </div>
      </div>
    </div>
  );
}

/**
 * Disk use of the managed directories plus the port map: what DevX stores
 * and what it listens on, in one glance. Both numbers are real — the usage
 * is a recursive walk, the map comes from the supervisor's bound ports.
 */
function ResourcesCard() {
  const usage = useQuery({
    queryKey: ["disk-usage"],
    queryFn: ipc.diskUsage,
    refetchInterval: 60_000,
  });
  const ports = useQuery({
    queryKey: ["port-map"],
    queryFn: ipc.portMap,
    refetchInterval: 15_000,
  });

  const totalBytes = (usage.data ?? []).reduce((sum, entry) => sum + entry.size_bytes, 0);
  const entries = (ports.data ?? []).sort((a, b) => a.port - b.port);

  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <HardDrive className="size-4 text-muted-foreground" aria-hidden />
          Resources
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {formatBytes(totalBytes)} on disk
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {usage.isError ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <CircleAlert className="size-4" />
            Could not read disk usage.
          </p>
        ) : (
          <ul className="space-y-1">
            {(usage.data ?? []).map((entry) => (
              <li key={entry.label} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">{entry.label}</span>
                <span className="data-value ml-auto shrink-0">{formatBytes(entry.size_bytes)}</span>
              </li>
            ))}
            {usage.isPending ? (
              <li className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" />
                Measuring…
              </li>
            ) : null}
          </ul>
        )}
        <div className="border-t border-border pt-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Ports</p>
          {ports.isError ? null : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ports claimed yet.</p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={`${entry.owner}-${entry.port}`} className="flex items-center gap-2 text-sm">
                  <span className="data-value shrink-0">{entry.port}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{entry.owner}</span>
                  <StatusBadge
                    state={entry.active ? "running" : "stopped"}
                    label=""
                    className="ml-auto"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The primary surface: a dense monitor table of every supervised service. */
function ServicesBoard({ entries }: { entries: ServiceMetrics[] }) {
  const maxMemory = Math.max(...entries.map((entry) => entry.memory_bytes), 1);
  // Failed services first: the board answers "what's broken" before
  // "what's running". Within a state, keep the backend's order.
  const stateRank = (state: string): number =>
    state === "failed" ? 0 : state === "starting" || state === "stopping" ? 1 : 2;
  const sorted = [...entries].sort(
    (a, b) => stateRank(a.state) - stateRank(b.state),
  );

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Activity className="size-4 text-muted-foreground" aria-hidden />
          Service monitor
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            <Link to="/services" className="text-primary hover:underline">
              Manage
            </Link>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {entries.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Nothing supervised yet. Install a service from the Components page,
            then start it on the Services page and it will appear here.
          </p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">
              Supervised services with live state, CPU and memory
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-normal">Service</th>
                <th scope="col" className="px-4 py-2 font-normal">State</th>
                <th scope="col" className="px-4 py-2 font-normal">CPU</th>
                <th scope="col" className="px-4 pb-2 pl-4 pr-4 text-right font-normal">Memory</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/50"
                >
                  <td className="px-4 py-2">
                    <span className="data-value text-foreground" data-selectable>
                      {entry.id}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge state={toUiState(entry.state)} />
                  </td>
                  <td className="px-4 py-2">
                    {entry.state === "running" ? (
                      <span className="flex items-center gap-2">
                        <span className="data-value text-foreground" data-selectable>
                          {(entry.cpu_percent ?? 0).toFixed(0)}%
                        </span>
                        <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary/70 transition-[width] duration-500"
                            style={{ width: `${entry.cpu_percent ?? 0}%` }}
                          />
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {entry.state === "running" ? (
                      <span className="data-value text-foreground" data-selectable>
                        {formatBytes(entry.memory_bytes)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                    <span className="sr-only">
                      {entry.state === "running"
                        ? ""
                        : `${((entry.memory_bytes / maxMemory) * 100).toFixed(0)}% of peak`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** Secondary summary of real numbers only — no deltas, no invented trends. */
function StatStrip({
  running,
  total,
  cpu,
  memory,
  sites,
}: {
  running: number;
  total: number;
  cpu: number;
  memory: number;
  sites: number;
}) {
  const stats = [
    { label: "Services", value: `${running}/${total}` },
    { label: "CPU", value: `${cpu.toFixed(0)}%` },
    { label: "Memory", value: formatBytes(memory) },
    { label: "Sites", value: String(sites) },
  ];

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-4 py-3">
        {stats.map((stat) => (
          <div key={stat.label}>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="data-value text-base font-semibold text-foreground">
              {stat.value}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** A compact snapshot of configured sites. */
function SitesSnapshot({ sites }: { sites: { hostname: string; https: boolean }[] }) {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Globe className="size-4 text-muted-foreground" aria-hidden />
          Sites
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sites yet — scaffold one from the{" "}
            <Link to="/sites" className="text-primary hover:underline">
              Sites page
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {sites.slice(0, 6).map((site) => (
              <li key={site.hostname} className="flex items-center justify-between gap-4">
                <span className="data-value min-w-0 truncate text-foreground" data-selectable>
                  {site.hostname}
                </span>
                {site.https ? <Badge variant="success">https</Badge> : null}
              </li>
            ))}
            {sites.length > 6 ? (
              <li className="text-xs text-muted-foreground">
                and {sites.length - 6} more
              </li>
            ) : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Recent supervised-service events, kept client-side from the event bus. */
function ActivityCard({
  entries,
}: {
  entries: { id: string; state: string; at: string }[];
}) {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Package className="size-4 text-muted-foreground" aria-hidden />
          Activity
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            service events, persisted across restarts
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Quiet so far. Service state changes show up here as they happen.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {entries.map((entry, index) => (
              <li key={`${entry.at}-${entry.id}-${index}`} className="flex items-center gap-2">
                <StatusBadge state={toUiState(entry.state)} label="" className="sr-only" />
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    entry.state === "running"
                      ? "bg-success"
                      : entry.state === "failed"
                        ? "bg-destructive"
                        : "bg-warning",
                  )}
                />
                <span className="data-value min-w-0 truncate text-foreground">
                  {entry.id}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {entry.at}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Maps backend state strings onto the shared UI state set. */
function toUiState(state: string): "running" | "failed" | "starting" | "stopping" | "stopped" {
  const known = ["running", "failed", "starting", "stopping", "stopped"] as const;
  const match = known.find((candidate) => candidate === state);
  return match ?? "stopped";
}

/**
 * Recent service state transitions, newest first.
 *
 * Seeded from the persistent event log (`events.jsonl`) so the history
 * covers everything since the log began, then extended live by the push
 * event while the window is open.
 */
function useActivityFeed(): { id: string; state: string; at: string }[] {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ["events-recent"],
    queryFn: () => ipc.eventsRecent(6),
    refetchInterval: 30_000,
  });
  const [live, setLive] = useState<{ id: string; state: string; at: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;

    // Outside a Tauri runtime (tests) `listen` rejects; the feed then simply
    // stays empty, and the pages' own polling remains the data fallback.
    ipcEvents.serviceEventUpdate
      .listen((event) => {
        const { id, state } = event.payload.event;
        setLive((current) =>
          [{ id, state: String(state), at: new Date().toLocaleTimeString() }, ...current].slice(
            0,
            6,
          ),
        );
        void queryClient.invalidateQueries({ queryKey: ["events-recent"] });
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          off = unlisten;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Live entries first (they carry the newest clock reading), then history,
  // de-duplicated by id+state so a push that is already persisted hides.
  const merged: { id: string; state: string; at: string }[] = [];
  const seen = new Set<string>();
  for (const entry of [...live, ...(history.data ?? []).map((e) => ({ id: e.id, state: e.state, at: formatTimestamp(e.at_unix) }))]) {
    const key = `${entry.id}|${entry.state}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.slice(0, 6);
}

/** Formats Unix seconds as a local time string. */
function formatTimestamp(unixSeconds: number): string {
  if (unixSeconds === 0) {
    return "unknown";
  }
  return new Date(unixSeconds * 1000).toLocaleTimeString();
}

/** Formats a byte count for the dashboard. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}
