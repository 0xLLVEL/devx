import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  Database,
  Globe,
  Loader2,
  Play,
  Server,
  Square,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";

import { ActivityTimeline } from "@/components/activity-timeline";
import { PageHeader } from "@/components/page-header";
import { ResourcePanel } from "@/components/resource-panel";
import { StatusBadge } from "@/components/status-dot";
import { SummaryCard, type SummaryTone } from "@/components/summary-card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import {
  ipc,
  ipcEvents,
  type BatchStartOutcome,
  type DbServer,
  type PortEntry,
  type ServiceMetrics,
  type SiteStatus,
} from "@/lib/ipc";
import { navShortcutLabel } from "@/lib/navigation";
import {
  summarizeMetrics,
  useInstalledVersions,
  usePhpPools,
  useServiceMetrics,
  useSites,
} from "@/lib/queries";
import { useSystemStatus, type SystemState } from "@/lib/shell-data";
import { cn } from "@/lib/utils";

/**
 * Dashboard (§16) — the screen that answers "is anything broken, and what do I
 * click".
 *
 * Layout follows §16: the §17 header, the four §18 summary cards, then the
 * panels, with the right rail carrying quick actions, recent activity and the
 * §40 resource panel. Below 1280px the rail stacks under the main column
 * (§16's 1100–1300px collapse), which also keeps the whole page intact down to
 * the window's 940px minimum.
 *
 * Every figure on this page comes from a command the backend really answers.
 * Where it does not — system-wide CPU, disk capacity, a "project" concept —
 * the dashboard says nothing rather than guessing (§131 Rule 17).
 */
export function DashboardPage() {
  const sites = useSites();
  const metrics = useServiceMetrics();
  const installed = useInstalledVersions();
  const phpPools = usePhpPools();
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: ipc.catalogList,
    // The shipped catalog does not change while the app runs.
    staleTime: Infinity,
  });
  const servers = useQuery({ queryKey: ["db-servers"], queryFn: ipc.dbListServers });
  // Disk usage walks the managed directories, so it is measured on §106's slow
  // end and never in the background.
  const disk = useQuery({
    queryKey: ["disk-usage"],
    queryFn: ipc.diskUsage,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const ports = useQuery({
    queryKey: ["port-map"],
    queryFn: ipc.portMap,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const events = useServiceEventLog(6);
  const status = useSystemStatus();
  const queryClient = useQueryClient();
  const toast = useToast();

  const invalidateServices = () => {
    void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
  const startAll = useMutation({
    mutationFn: ipc.servicesStartAll,
    onSuccess: (outcomes) => reportFailedOutcomes(outcomes, "start", toast),
    onError: (error: Error) => {
      toast.error("Could not start services", { details: error.message });
    },
    onSettled: invalidateServices,
  });
  const stopAll = useMutation({
    mutationFn: ipc.servicesStopAll,
    onSuccess: (outcomes) => reportFailedOutcomes(outcomes, "stop", toast),
    onError: (error: Error) => {
      toast.error("Could not stop services", { details: error.message });
    },
    onSettled: invalidateServices,
  });

  const entries = metrics.data ?? [];
  const { runningCount, failed, cpu, memory } = summarizeMetrics(entries);
  const runningProcesses = entries
    .filter((entry) => entry.state === "running")
    .reduce((sum, entry) => sum + entry.processes, 0);
  const stoppedCount = entries.filter(
    (entry) => entry.state === "stopped" || entry.state === "failed",
  ).length;

  const siteList = sites.data ?? [];
  const httpsSites = siteList.filter((site) => site.https).length;
  const serverList = servers.data ?? [];
  const reachableServers = serverList.filter((server) => server.reachable).length;

  // "Runtimes" means language runtimes (§19), so installed components are
  // classified by the catalog's own kind rather than counted wholesale — a
  // Composer or a Mailpit install is not a runtime.
  const runtimeVersions = useMemo(() => {
    if (!installed.data || !catalog.data) {
      return null;
    }
    const kinds = new Map(catalog.data.map((component) => [component.id, component.kind]));
    return installed.data.filter((entry) => kinds.get(entry.component_id) === "runtime");
  }, [installed.data, catalog.data]);

  const portEntries = ports.data ?? [];
  const conflicts = countPortConflicts(portEntries);

  const batchBusy = startAll.isPending || stopAll.isPending;
  const problems = [
    failed.length > 0
      ? `${failed.length} failed`
      : null,
    conflicts > 0
      ? `${conflicts} port conflict${conflicts === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);

  const counts = [
    runtimeVersions === null ? null : `${runtimeVersions.length} runtimes`,
    `${entries.length} server${entries.length === 1 ? "" : "s"}`,
    `${siteList.length} site${siteList.length === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== null);

  /* §18's four cards. A count that could not be read is drawn as unknown, never
     as a zero (§131 Rule 17), and "nothing configured yet" is a fact rather
     than an alarm. */
  const runtimesCard: CardFacts = {
    value: runtimeVersions === null ? null : String(runtimeVersions.length),
    status:
      installed.isPending || catalog.isPending
        ? "Counting…"
        : runtimeVersions === null
          ? "Unavailable"
          : runtimeVersions.length === 0
            ? "None installed yet"
            : "Installed",
    tone: runtimeVersions === null && !installed.isPending && !catalog.isPending
      ? "warning"
      : "neutral",
    pending: installed.isPending || catalog.isPending,
  };
  const serversCard: CardFacts = {
    value: metrics.isError ? null : `${runningCount}/${entries.length}`,
    status: metrics.isError
      ? "Unavailable"
      : entries.length === 0
        ? "Nothing supervised yet"
        : failed.length > 0
          ? `${failed.length} failed`
          : runningCount === entries.length
            ? "All running"
            : `${runningCount} of ${entries.length} running`,
    tone: metrics.isError
      ? "warning"
      : failed.length > 0
        ? "destructive"
        : entries.length > 0 && runningCount < entries.length
          ? "warning"
          : entries.length === 0
            ? "neutral"
            : "success",
    pending: metrics.isPending,
  };
  const sitesCard: CardFacts = {
    value: sites.isPending || sites.isError ? null : String(siteList.length),
    status: sites.isError
      ? "Unavailable"
      : siteList.length === 0
        ? "None configured"
        : httpsSites > 0
          ? `${httpsSites} over HTTPS`
          : "Served over HTTP",
    tone: sites.isError ? "warning" : "neutral",
    pending: sites.isPending,
  };
  const databasesCard: CardFacts = {
    value: servers.isPending || servers.isError ? null : String(serverList.length),
    status: servers.isError
      ? "Unavailable"
      : serverList.length === 0
        ? "None configured"
        : reachableServers === serverList.length
          ? "All reachable"
          : `${reachableServers} of ${serverList.length} reachable`,
    tone: servers.isError
      ? "warning"
      : serverList.length === 0
        ? "neutral"
        : reachableServers === serverList.length
          ? "success"
          : "warning",
    pending: servers.isPending,
  };

  return (
    <div className="space-y-6 p-8">
      <PageHeader
        eyebrow={greeting()}
        title={verdict(entries.length, failed.length, runningCount, metrics.isError)}
        description={subtitle(
          siteList.length,
          entries.length,
          runningCount,
          cpu,
          memory,
          metrics.isError,
        )}
        right={
          status ? (
            <StatusSummary
              label={status.label}
              state={status.state}
              counts={counts.join(" · ")}
              problems={problems}
            />
          ) : metrics.isPending ? (
            /* §121: the placeholder is decoration, so the meaning of it is
               announced separately rather than lost with the skeleton. */
            <span role="status">
              <span className="sr-only">Reading service state…</span>
              <span
                aria-hidden
                className="block h-14 w-52 shimmer-skeleton rounded-lg"
              />
            </span>
          ) : null
        }
        primaryAction={
          entries.length > 0 ? (
            <>
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
            </>
          ) : null
        }
      />

      {failed.length > 0 ? (
        <Callout variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* §39: what is wrong, what to do about it, and one way there. */}
            <p>
              {failed.map((entry) => entry.id).join(", ")}{" "}
              {failed.length === 1 ? "is" : "are"} failing. Check its log on the
              Services page and restart it.
            </p>
            <Link
              to="/services"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
            >
              Open Services
            </Link>
          </div>
        </Callout>
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard to="/components" label="Runtimes" {...runtimesCard} />
        <SummaryCard to="/services" label="Servers" {...serversCard} />
        <SummaryCard to="/sites" label="Sites" {...sitesCard} />
        <SummaryCard to="/databases" label="Databases" {...databasesCard} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* Pools first — Frame 1's decision table. */}
          <PoolsPanel
            pools={phpPools.data ?? []}
            pending={phpPools.isPending}
            error={phpPools.isError ? phpPools.error : null}
            onRetry={() => void phpPools.refetch()}
            metrics={entries}
          />
          <ServicesPanel
            entries={entries}
            pending={metrics.isPending}
            error={metrics.isError ? metrics.error : null}
            onRetry={() => void metrics.refetch()}
          />
          <SitesPanel
            sites={siteList}
            pending={sites.isPending}
            error={sites.isError ? sites.error : null}
            onRetry={() => void sites.refetch()}
          />
          <DatabasesPanel
            servers={serverList}
            pending={servers.isPending}
            error={servers.isError ? servers.error : null}
            onRetry={() => void servers.refetch()}
          />
        </div>

        {/* §16's right rail; it stacks under the main column below 1280px. */}
        <aside className="min-w-0 space-y-6">
          <QuickActions />
          <Card>
            <CardHeader className="pb-1.5">
              <CardTitle className="flex items-center gap-2">
                Recent activity
                <span className="ml-auto text-[13px] font-normal text-ink-muted">
                  service events
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {events.isPending ? (
                // §37: a skeleton, like every other panel on the page, rather
                // than a spinner in the one spot a list is about to appear.
                <SkeletonLines label="Loading recent service events" />
              ) : events.isError ? (
                <Callout variant="destructive" title="Could not read the event log.">
                  <p>{events.error?.message}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void events.refetch()}
                  >
                    Try again
                  </Button>
                </Callout>
              ) : (
                <ActivityTimeline events={events.data ?? []} />
              )}
            </CardContent>
          </Card>
          <ResourcePanel
            cpuPercent={cpu}
            runningCount={runningCount}
            memoryBytes={memory}
            processCount={runningProcesses}
            metricsPending={metrics.isPending}
            metricsFailed={metrics.isError}
            disk={disk.data ?? []}
            diskPending={disk.isPending}
            diskFailed={disk.isError}
            portsClaimed={ports.data ? portEntries.length : null}
            portsActive={
              ports.data ? portEntries.filter((entry) => entry.active).length : null
            }
            portsPending={ports.isPending}
          />
        </aside>
      </div>
    </div>
  );
}

/** Everything a §18 card says about one entity group: its headline number and
 * the state behind it.
 */
type CardFacts = {
  value: string | null;
  status: string;
  tone: SummaryTone;
  pending: boolean;
};

/**
 * PHP pools as a dense table (preview Frame 1): pool, state badge, workers,
 * endpoint and a CPU meter. The meter's CPU comes from the service metrics
 * row that matches this pool's port — no invented number when absent.
 */
function PoolsPanel({
  pools,
  pending,
  error,
  onRetry,
  metrics,
}: {
  pools: readonly { id: string; version: string; workers: number; port: number; state: string }[];
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
  metrics: readonly ServiceMetrics[];
}) {
  const cpuFor = (port: number): number | null => {
    const match = metrics.find(
      (entry) => entry.id.includes("php") && entry.id.includes(String(port)),
    );
    // Pools report cpu on their own metrics row keyed by pool id; fall back
    // to matching the FastCGI port in the id when the shapes differ.
    if (match) return match.cpu_percent;
    const byPort = metrics.find((entry) => entry.id.endsWith(`:${port}`));
    return byPort ? byPort.cpu_percent : null;
  };

  const healthy = pools.filter((p) => p.state === "running").length;

  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2">
          PHP pools
          <span className="ml-auto text-[13px] font-normal text-ink-muted">
            {pools.length === 0
              ? "none installed"
              : `${healthy}/${pools.length} healthy`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0 pt-4">
        {pending ? (
          <div className="space-y-2 px-6 pb-6">
            <span className="sr-only">Loading PHP pools</span>
            {[0, 1, 2].map((row) => (
              <span key={row} aria-hidden className="block h-5 shimmer-skeleton" />
            ))}
          </div>
        ) : error ? (
          <div className="px-6 pb-6">
            <Callout variant="destructive" title="Could not read the PHP pools.">
              <p>{error.message}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
                Try again
              </Button>
            </Callout>
          </div>
        ) : pools.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={<Cpu />}
              title="No PHP pools yet."
              description="Install a PHP runtime to see pool health."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">PHP pools with state, workers, endpoint and CPU</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-6 py-2 font-normal">Pool</th>
                  <th scope="col" className="px-3 py-2 font-normal">State</th>
                  <th scope="col" className="px-3 py-2 font-normal">Workers</th>
                  <th scope="col" className="px-3 py-2 font-normal">Endpoint</th>
                  <th scope="col" className="px-6 py-2 text-right font-normal">CPU</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool, index) => {
                  const cpu = cpuFor(pool.port);
                  const failed = pool.state === "failed";
                  return (
                    <tr
                      key={pool.id}
                      className={cn(
                        "border-b border-border last:border-b-0",
                        (failed || index === 0) && "bg-surface-2",
                        failed && "shadow-[inset_2px_0_0_var(--danger)]",
                        index === 0 && !failed && "shadow-[inset_2px_0_0_var(--foreground)]",
                      )}
                    >
                      <td className="px-6 py-2.5 font-mono text-[13px] font-semibold" data-selectable>
                        {pool.version}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant={failed ? "destructive" : pool.state === "running" ? "success" : "default"}>
                          {stateLabel(pool.state)}
                        </Badge>
                      </td>
                      <td className={cn("px-3 py-2.5 font-mono text-[13px]", failed && "text-ink-muted")}>
                        {pool.workers}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-ink-muted" data-selectable>
                        127.0.0.1:{pool.port}
                      </td>
                      <td className="px-6 py-2.5 text-right">
                        {pool.state !== "running" || cpu === null ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <span className="inline-flex items-center justify-end gap-2">
                            <span className="font-mono text-[13px]">{cpu.toFixed(0)}%</span>
                            <span aria-hidden className="inline-block h-1.5 w-16 bg-surface-2 align-middle">
                              <span
                                className="block h-full bg-ink-muted"
                                style={{ width: `${Math.min(100, Math.max(0, cpu))}%` }}
                              />
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** `stopped` → `Stopped`, for a badge that shows the state as a word. */
function stateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/**
 * §17's status summary, opposite the headline.
 *
 * It carries the same verdict as the sidebar and the topbar because it reads
 * the same derivation (§118/§119), so the three can never disagree about
 * whether the system is ready.
 */
function StatusSummary({
  label,
  state,
  counts,
  problems,
}: {
  label: string;
  state: SystemState;
  counts: string;
  problems: string[];
}) {
  return (
    <div className="flex flex-col items-end gap-0.5 border border-border bg-surface px-4 py-3 text-right text-[13px]">
      <span className="flex items-center gap-2 font-semibold text-foreground">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", SYSTEM_TONE[state])}
        />
        {label}
      </span>
      <span className="text-xs text-ink-muted">{counts}</span>
      {problems.length > 0 ? (
        <span className="text-xs text-warning">{problems.join(" · ")}</span>
      ) : null}
    </div>
  );
}

/** §118's states, as a dot. The label beside it carries the meaning (§55). */
const SYSTEM_TONE: Record<SystemState, string> = {
  ready: "bg-success",
  attention: "bg-warning",
  error: "bg-destructive",
  starting: "bg-warning",
  stopping: "bg-warning",
  unknown: "bg-muted-foreground/40",
};

/**
 * §16/§117 quick actions.
 *
 * Only destinations that exist, and only shortcuts that are really installed:
 * the hint comes from the route registry the shell builds its keymap from, so
 * there is no `Ctrl + N` here to press and nothing happens.
 */
const QUICK_ACTIONS: {
  to: string;
  title: string;
  subtitle: string;
}[] = [
  {
    to: "/components",
    title: "Add a runtime",
    subtitle: "Install PHP, Node, Bun or Go",
  },
  { to: "/sites", title: "Add a site", subtitle: "Serve a folder locally" },
  {
    to: "/logs",
    title: "Open Logs",
    subtitle: "What DevX and services wrote",
  },
];

function QuickActions() {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle>Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {QUICK_ACTIONS.map(({ to, title, subtitle }) => {
          const shortcut = navShortcutLabel(to);
          return (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2.5 border-t border-border py-2.5 text-sm first:border-t-0 hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{title}</span>
                <span className="block truncate text-[13px] text-ink-muted">
                  {subtitle}
                </span>
              </span>
              {shortcut ? (
                <kbd className="shrink-0 border border-line-strong px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                  {shortcut}
                </kbd>
              ) : null}
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The primary surface: a dense monitor table of every supervised service. */
function ServicesPanel({
  entries,
  pending,
  error,
  onRetry,
}: {
  entries: ServiceMetrics[];
  pending: boolean;
  /** The metrics read that failed; null when it answered. */
  error: Error | null;
  onRetry: () => void;
}) {
  // Failed services first: the panel answers "what's broken" before
  // "what's running". Within a state, keep the backend's order.
  const stateRank = (state: string): number =>
    state === "failed" ? 0 : state === "starting" || state === "stopping" ? 1 : 2;
  const sorted = [...entries].sort((a, b) => stateRank(a.state) - stateRank(b.state));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          Supervised services
          <Link to="/services" className="ml-auto text-[13px] font-normal text-ink-muted hover:text-foreground">
            Manage
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {pending ? (
          <div className="space-y-2 px-4 pb-4">
            <span className="sr-only">Loading services</span>
            {[0, 1, 2].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-5 shimmer-skeleton rounded-sm"
              />
            ))}
          </div>
        ) : error ? (
          <div className="px-4 pb-4">
            {/* §39/Rule 17: an unread metric list is a failure, not an empty
                one — the empty state below would claim DevX supervises
                nothing. */}
            <Callout
              variant="destructive"
              title="Could not read the service metrics."
            >
              <p>{error.message}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
                Try again
              </Button>
            </Callout>
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 pb-4">
            {/* §38: what is missing, and the action that fills it. */}
            <EmptyState
              icon={<Server />}
              title="Nothing is supervised yet."
              description="Install a service from the component catalog, then start it on the Services page and it appears here."
              action={
                <Link
                  to="/components"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Open Components
                </Link>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Supervised services with live state, CPU and memory
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-normal">
                    Service
                  </th>
                  <th scope="col" className="px-4 py-2 font-normal">
                    State
                  </th>
                  <th scope="col" className="px-4 py-2 font-normal">
                    CPU
                  </th>
                  <th scope="col" className="py-2 pr-4 pl-4 text-right font-normal">
                    Memory
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-hover"
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
                          <span
                            aria-hidden
                            className="h-1 w-16 overflow-hidden rounded-full bg-muted"
                          >
                            <span
                              className="block h-full rounded-full bg-primary/70 transition-[width] duration-200"
                              style={{ width: `${entry.cpu_percent ?? 0}%` }}
                            />
                          </span>
                        </span>
                      ) : (
                        <NotReported />
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {entry.state === "running" ? (
                        <span className="data-value text-foreground" data-selectable>
                          {formatBytes(entry.memory_bytes)}
                        </span>
                      ) : (
                        <NotReported />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A metric a stopped service does not have yet — never a zero it did not report. */
function NotReported() {
  return (
    <>
      <span aria-hidden className="text-xs text-muted-foreground">
        —
      </span>
      <span className="sr-only">Not reported</span>
    </>
  );
}

/** The configured sites, at a glance (§23 condensed to a dashboard panel). */
function SitesPanel({
  sites,
  pending,
  error,
  onRetry,
}: {
  sites: readonly SiteStatus[];
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2">
          Sites
          <Link to="/sites" className="ml-auto text-[13px] font-normal text-ink-muted hover:text-foreground">
            Manage
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {pending ? (
          <SkeletonLines label="Loading sites" />
        ) : error ? (
          <PanelError
            title="Could not read the site list."
            error={error}
            onRetry={onRetry}
          />
        ) : sites.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No sites yet."
            description="Point a local domain at a folder and DevX serves it."
            action={
              <Link to="/sites" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Add a site
              </Link>
            }
          />
        ) : (
          <ul className="space-y-1">
            {sites.slice(0, 6).map((site) => (
              <li key={site.hostname} className="flex items-center gap-2 text-sm">
                <span
                  className="data-value min-w-0 truncate text-foreground"
                  title={site.hostname}
                  data-selectable
                >
                  {site.hostname}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption text-ink-muted">
                  {site.php_version ? `PHP ${site.php_version}` : "static"}
                  {site.https ? <span className="text-success">· HTTPS</span> : null}
                </span>
              </li>
            ))}
            {sites.length > 6 ? (
              <li className="text-caption text-ink-muted">and {sites.length - 6} more</li>
            ) : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The database servers DevX can connect to, with real reachability. */
function DatabasesPanel({
  servers,
  pending,
  error,
  onRetry,
}: {
  servers: readonly DbServer[];
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2">
          Databases
          <Link
            to="/databases"
            className="ml-auto text-[13px] font-normal text-ink-muted hover:text-foreground"
          >
            Manage
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {pending ? (
          <SkeletonLines label="Loading database servers" />
        ) : error ? (
          <PanelError
            title="Could not read the database servers."
            error={error}
            onRetry={onRetry}
          />
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<Database />}
            title="No database server yet."
            description="Install MariaDB, PostgreSQL or Redis to connect from here."
            action={
              <Link
                to="/databases"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Open Databases
              </Link>
            }
          />
        ) : (
          <ul className="space-y-1">
            {servers.map((server) => (
              <li key={server.service_id} className="flex items-center gap-2 text-sm">
                {/* §95: both strings are shortened to the column, so the full
                    value stays reachable on hover. */}
                <span
                  className="min-w-0 truncate text-foreground"
                  title={ENGINE_LABELS[server.engine] ?? server.engine}
                >
                  {ENGINE_LABELS[server.engine] ?? server.engine}
                </span>
                <span
                  className="data-value min-w-0 truncate text-ink-muted"
                  title={`${server.host}:${server.port}`}
                >
                  {server.host}:{server.port}
                </span>
                {/* §55: the dot has a label, so reachability is not colour-only. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption text-ink-muted">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      server.reachable ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  {server.reachable ? "reachable" : "not reachable"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const ENGINE_LABELS: Record<string, string> = {
  maria_db: "MariaDB",
  postgre_sql: "PostgreSQL",
  redis: "Redis",
};

function SkeletonLines({ label }: { label: string }) {
  return (
    <div className="space-y-2">
      <span className="sr-only">{label}</span>
      {[0, 1].map((row) => (
        <span
          key={row}
          aria-hidden
          className="block h-4 shimmer-skeleton rounded-sm"
        />
      ))}
    </div>
  );
}

/**
 * A secondary panel whose query failed.
 *
 * §39: the cause and the way out sit on the panel itself. It is not an empty
 * state — a first load and a genuinely empty list look different — and not a
 * silent gap either (§131 Rule 18).
 */
function PanelError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <Callout variant="destructive" title={title}>
      <p>{error.message}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </Callout>
  );
}

/**
 * The recent service transitions, from the persistent event log.
 *
 * The log is the source of truth, so the timeline is a plain query over it: a
 * push from the service watcher invalidates the query instead of the client
 * keeping a parallel history that could disagree with what Rust recorded.
 */
function useServiceEventLog(limit: number) {
  const queryClient = useQueryClient();
  const events = useQuery({
    queryKey: ["events", "recent", limit],
    queryFn: () => ipc.eventsRecent(limit),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;

    // Outside a Tauri runtime (tests) `listen` rejects; the poll above then
    // remains the data path.
    ipcEvents.serviceEventUpdate
      .listen(() => {
        void queryClient.invalidateQueries({ queryKey: ["events"] });
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
  }, [queryClient]);

  return events;
}

/**
 * How many ports the port map claims for more than one owner.
 *
 * That is the only conflict the backend's data can prove: two entries on the
 * same number cannot both bind it. A single owner per port — the normal case —
 * counts as zero.
 */
export function countPortConflicts(entries: readonly PortEntry[]): number {
  const owners = new Map<number, Set<string>>();
  for (const entry of entries) {
    const forPort = owners.get(entry.port) ?? new Set<string>();
    forPort.add(entry.owner);
    owners.set(entry.port, forPort);
  }
  let conflicts = 0;
  for (const forPort of owners.values()) {
    if (forPort.size > 1) {
      conflicts += 1;
    }
  }
  return conflicts;
}

/**
 * §54: `services_start_all` and `services_stop_all` are non-fatal per service,
 * so a batch that half-worked answers with the failures instead of rejecting.
 * A rejected call is reported by each mutation's `onError`; this covers the
 * other shape, with the backend's own message per service.
 */
function reportFailedOutcomes(
  outcomes: readonly BatchStartOutcome[],
  verb: "start" | "stop",
  toast: ReturnType<typeof useToast>,
) {
  const failedOutcomes = outcomes.filter((outcome) => outcome.error !== null);
  if (failedOutcomes.length === 0) {
    return;
  }
  toast.error(
    `${failedOutcomes.length} service${failedOutcomes.length === 1 ? "" : "s"} did not ${verb}`,
    {
      description: failedOutcomes.map((outcome) => outcome.id).join(", "),
      details: failedOutcomes
        .map((outcome) => `${outcome.id}: ${outcome.error ?? "unknown error"}`)
        .join("\n"),
    },
  );
}

/**
 * §17's headline: the worst thing that is true, said first.
 *
 * A failed metrics read is not a fact about the user's machine, so it is never
 * turned into a verdict about one (§131 Rule 17).
 */
function verdict(
  total: number,
  failed: number,
  running: number,
  unavailable: boolean,
): string {
  if (unavailable) {
    return "Could not read the service state.";
  }
  if (total === 0) {
    return "Your environment is waiting.";
  }
  if (failed > 0) {
    return `${failed} service${failed === 1 ? "" : "s"} failed.`;
  }
  if (running === total) {
    return "Everything is running.";
  }
  return `${running} of ${total} services up.`;
}

/**
 * §17's subtitle: what this machine holds right now.
 *
 * The CPU and memory figures are the supervised services' own — the backend
 * measures nothing else — so the line says so instead of implying a system
 * total. It is also omitted outright when those figures could not be read,
 * rather than reporting the zeros the summariser falls back to.
 */
function subtitle(
  sites: number,
  total: number,
  running: number,
  cpu: number,
  memory: number,
  unavailable: boolean,
): string {
  const sitePart = `${sites} site${sites === 1 ? "" : "s"} served locally`;
  if (unavailable) {
    return `${sitePart} · service state unavailable`;
  }
  if (total === 0) {
    return `${sitePart} · nothing supervised yet`;
  }
  return `${sitePart} · ${cpu.toFixed(0)}% across ${running} running service${
    running === 1 ? "" : "s"
  } · ${formatBytes(memory)} resident`;
}

/** §17's greeting. */
function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) {
    return "Good night, Developer";
  }
  if (hour < 12) {
    return "Good morning, Developer";
  }
  if (hour < 18) {
    return "Good afternoon, Developer";
  }
  return "Good evening, Developer";
}

/** Maps backend state strings onto the shared UI state set. */
function toUiState(state: string): "running" | "failed" | "starting" | "stopping" | "stopped" {
  const known = ["running", "failed", "starting", "stopping", "stopped"] as const;
  const match = known.find((candidate) => candidate === state);
  return match ?? "stopped";
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
