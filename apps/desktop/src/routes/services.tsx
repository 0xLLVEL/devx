import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  CalendarClock,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Gauge,
  Globe,
  Loader2,
  Package,
  Pencil,
  Play,
  Plug,
  Plus,
  Puzzle,
  RotateCcw,
  RotateCw,
  Search,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { FilterBar, type ActiveFilter } from "@/components/filter-bar";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { PageHeader } from "@/components/page-header";
import { PortInspectorButton } from "@/components/port-inspector";
import { StatusBadge } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
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
import {
  useInstalledVersions,
  usePhpPools,
  useServiceComponentIds,
  useServiceMetrics,
  useSites,
} from "@/lib/queries";
import {
  ipc,
  IpcError,
  type InstalledVersion,
  type LimitConfig,
  type LogEntry,
  type PhpPoolStatus,
  type PortEntry,
  type ServiceMetrics,
  type ServiceState,
  type SiteStatus,
  type WorkerStatus,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * Services — the Server Manager (§21) plus the PHP pools, queue workers and
 * scheduled tasks that are supervised the same way.
 *
 * The page is one dense table (§60) of every service DevX supervises, with the
 * row's own actions attached to it (§91) and §21's detail view behind the row:
 * Overview, Logs (§22), Ports, Sites and Configuration — only the tabs that
 * have data behind them for that particular server. A PHP pool gets all five
 * because the pool commands really answer for all five; nginx gets Overview,
 * Logs and Sites; nothing gets an Environment tab, because no command reads or
 * writes one.
 *
 * Everything on a row comes from a command that answers it: state, CPU and
 * memory from `service_metrics`, ports from `port_map`, the config location
 * from `paths_get`. Where the backend reports nothing — a service the
 * supervisor has never registered, a metric it did not sample — the row says
 * so instead of guessing (§131 Rule 17).
 */
export function ServicesPage() {
  const installed = useInstalledVersions();
  // Which installed components DevX knows how to supervise comes from the
  // backend, so the two never drift.
  const serviceIds = useServiceComponentIds();
  const phpPools = usePhpPools();
  const metrics = useServiceMetrics();
  const paths = useQuery({ queryKey: ["paths"], queryFn: ipc.pathsGet });
  // The port map is the backend's own answer to "what claims which port"; it
  // is polled as slowly as the dashboard polls it.
  const ports = useQuery({
    queryKey: ["port-map"],
    queryFn: ipc.portMap,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const [tab, setTab] = useState<"services" | "workers" | "scheduler">("services");
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | ServiceState>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const pending = installed.isPending || phpPools.isPending || serviceIds.isPending;
  // These three decide which services exist, so a failed read here makes the
  // list a lie rather than merely incomplete (§121, §131 Rule 17).
  const listFailure = installed.isError
    ? {
        title: "Could not read the installed components.",
        error: installed.error,
        retry: installed.refetch,
      }
    : phpPools.isError
      ? {
          title: "Could not read the PHP pools.",
          error: phpPools.error,
          retry: phpPools.refetch,
        }
      : serviceIds.isError
        ? {
            title: "Could not read the supervisable components.",
            error: serviceIds.error,
            retry: serviceIds.refetch,
          }
        : null;
  const supervisable = useMemo(
    () => new Set(serviceIds.data ?? []),
    [serviceIds.data],
  );
  const servers = useMemo(
    () => toServers(installed.data ?? [], phpPools.data ?? [], supervisable),
    [installed.data, phpPools.data, supervisable],
  );

  // One sample of every service's state serves the whole table, so the page
  // polls once instead of once per row. A failed sample is not the same as
  // "stopped" (§2), so it reads as unknown.
  const states = useMemo(() => {
    const live = new Map<string, ServiceState>();
    for (const entry of metrics.data ?? []) {
      live.set(entry.id, entry.state);
    }
    return live;
  }, [metrics.data]);
  const stateOf = (server: ServerEntry): ServiceState | null =>
    metrics.isError ? null : (states.get(server.id) ?? "stopped");

  const portEntries = ports.data ?? [];
  const dataDir = paths.data?.data_dir ?? null;

  const needle = query.trim().toLowerCase();
  const visibleServers = servers.filter((server) => {
    if (stateFilter !== "all" && stateOf(server) !== stateFilter) {
      return false;
    }
    return (
      needle === "" ||
      server.name.toLowerCase().includes(needle) ||
      server.id.toLowerCase().includes(needle)
    );
  });

  const statesPresent = [...new Set(servers.map((server) => stateOf(server) ?? "unknown"))];
  const filters: ActiveFilter[] = [];
  if (query.trim() !== "") {
    filters.push({
      id: "query",
      label: "Search",
      value: query.trim(),
      onClear: () => setQuery(""),
    });
  }
  if (stateFilter !== "all") {
    filters.push({
      id: "state",
      label: "State",
      value: stateLabel(stateFilter),
      onClear: () => setStateFilter("all"),
    });
  }
  const clearFilters = () => {
    setQuery("");
    setStateFilter("all");
  };

  const commands = useServerCommands();
  const startAll = useBulkCommand(commands.start, "start", "started");
  const stopAll = useBulkCommand(commands.stop, "stop", "stopped");

  // §54: a bulk action reports per service, because the backend lets one
  // failure stand while the rest come up and the outcome is otherwise lost.
  const startableServers = servers.filter((server) => {
    const state = stateOf(server);
    return state === null || state === "stopped" || state === "failed";
  });
  const activeServers = servers.filter((server) => {
    const state = stateOf(server);
    return state === "running" || state === "starting" || state === "stopping";
  });
  const bulkBusy = startAll.isPending || stopAll.isPending;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          servers.length === 0
            ? "Services"
            : `${servers.length} service${servers.length === 1 ? "" : "s"} supervised.`
        }
        description="Supervised background services, PHP pools, workers and scheduled tasks."
        primaryAction={
          servers.length > 0 ? (
            <>
              <Button
                size="sm"
                disabled={bulkBusy || startableServers.length === 0}
                onClick={() => startAll.mutate(startableServers)}
              >
                {startAll.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                Start all
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkBusy || activeServers.length === 0}
                onClick={() => stopAll.mutate(activeServers)}
              >
                {stopAll.isPending ? <Loader2 className="animate-spin" /> : <Square />}
                Stop all
              </Button>
            </>
          ) : null
        }
      >
        {/* Below two servers there is nothing to narrow down, so the row stays
            away rather than sitting there inert (§61). */}
        {servers.length > 1 ? (
          <FilterBar active={filters} onClear={clearFilters}>
            <Input
              className="h-8 w-64 text-xs"
              aria-label="Search services"
              placeholder="Service name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {statesPresent.length > 1 ? (
              <Select
                className="h-8 w-36 text-xs"
                aria-label="State"
                value={stateFilter}
                onChange={(event) =>
                  setStateFilter(event.target.value as "all" | ServiceState)
                }
              >
                <option value="all">All states</option>
                {statesPresent.map((state) => (
                  <option key={state} value={state}>
                    {stateLabel(state)}
                  </option>
                ))}
              </Select>
            ) : null}
          </FilterBar>
        ) : null}
      </PageHeader>

      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading installed components…
        </p>
      ) : listFailure ? (
        <Callout variant="destructive" title={listFailure.title}>
          <p>{listFailure.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void listFailure.retry()}
          >
            Try again
          </Button>
        </Callout>
      ) : servers.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title="No supervisable service is installed yet."
          description="Install Mailpit or PHP from the Components page to start one here."
          action={
            <Link to="/components" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open Components
            </Link>
          }
        />
      ) : (
        <>
          <TabBar
            tabs={[
              { id: "services", label: "Services" },
              { id: "workers", label: "Workers" },
              { id: "scheduler", label: "Scheduled tasks" },
            ]}
            active={tab}
            onSelect={setTab}
          />

          {tab === "services" ? (
            visibleServers.length === 0 ? (
              /* The reset control is the filter row's own chip above: a second
                 "Clear filters" here would be the same button twice on one
                 screen. */
              <EmptyState
                icon={<Search />}
                title="No service matches these filters."
                description={`${servers.length} service${
                  servers.length === 1 ? "" : "s"
                } exist and none of them match the current filters.`}
              />
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[46rem] text-left text-sm">
                  <thead className="bg-surface-2 text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Server
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        State
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Port
                      </th>
                      <th
                        scope="col"
                        className="hidden px-3 py-2 font-medium xl:table-cell"
                      >
                        Configuration
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleServers.map((server) => (
                      <ServerRow
                        key={server.id}
                        server={server}
                        state={stateOf(server)}
                        open={expanded === server.id}
                        onToggle={() =>
                          setExpanded((current) =>
                            current === server.id ? null : server.id,
                          )
                        }
                        dataDir={dataDir}
                        metrics={metrics.data?.find((entry) => entry.id === server.id)}
                        metricsFailed={metrics.isError}
                        portsError={ports.error}
                        onRetryPorts={() => void ports.refetch()}
                        ports={portEntries.filter((entry) => entry.owner === server.id)}
                        commands={commands}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          {tab === "workers" ? (
            <WorkersSection
              phpVersions={(phpPools.data ?? []).map((pool) => pool.version)}
            />
          ) : null}

          {tab === "scheduler" ? (
            <SchedulerSection
              phpVersions={(phpPools.data ?? []).map((pool) => pool.version)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** Border-bottom tab row; the active tab carries the amber marker. */
export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  label = "Sections",
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  /** Accessible name for the tab list; every tab list on a page needs its own. */
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((item) => (
        <button
          key={item.id}
          role="tab"
          type="button"
          aria-selected={active === item.id}
          onClick={() => onSelect(item.id)}
          className={cn(
            "relative cursor-pointer px-3 py-2 text-sm transition-colors duration-150",
            active === item.id
              ? "font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One supervised service as the table and its detail view need it.
 *
 * `id` is the supervisor's own identifier, which is also what `service_start`,
 * `service_stop`, `service_logs` and `port_map` key on; a PHP pool
 * additionally carries the worker count and FastCGI port its plan reported.
 */
type ServerEntry = {
  id: string;
  /** What the row is called — `nginx`, `PHP 8.4.25`. */
  name: string;
  version: string;
  /** Non-null for a PHP FastCGI pool, which has its own commands. */
  pool: { workers: number; port: number } | null;
  /** The web server kind sites are routed to, when the backend has one. */
  webServer: SiteStatus["web_server"] | null;
};

/** Component ids that sites can be routed to, in the sites' own vocabulary. */
const WEB_SERVER_ID: Record<string, SiteStatus["web_server"]> = {
  nginx: "Nginx",
  caddy: "Caddy",
  frankenphp: "FrankenPhp",
};

/** Default ports for supervisable components when no override is configured. */
export const DEFAULT_SERVICE_PORTS: Record<string, number> = {
  nginx: 80,
  apache: 80,
  caddy: 80,
  frankenphp: 80,
  mariadb: 3306,
  postgresql: 5432,
  redis: 6379,
  mailpit: 1025,
  meilisearch: 7700,
  "nats-server": 4222,
  etcd: 2379,
  mongodb: 27017,
};

/** Joins a managed root with path segments, keeping the root's own separator. */
function joinPath(root: string, ...segments: string[]): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...segments].join(separator);
}

/**
 * Where DevX renders this service's configuration.
 *
 * `paths_get` exposes the two managed roots, not the per-service directory, so
 * the path mirrors `AppPaths::service_config_dir()` — `<data_dir>/service-config
 * /<id>` — which is where every plan in `src-tauri/src/services.rs` writes. It
 * is shown as data (§96) and opened through the OS, so a service that has never
 * started (and has no directory yet) says so instead of pretending.
 */
function configPathFor(dataDir: string, id: string): string {
  return joinPath(dataDir, "service-config", id);
}

/** The file the supervisor appends this service's output to. */
function logPathFor(dataDir: string, id: string): string {
  return joinPath(dataDir, "logs", `${id}.log`);
}

function toServers(
  installed: readonly InstalledVersion[],
  pools: readonly PhpPoolStatus[],
  supervisable: ReadonlySet<string>,
): ServerEntry[] {
  const servers = new Map<string, ServerEntry>();

  for (const pool of pools) {
    servers.set(pool.id, {
      id: pool.id,
      name: `PHP ${pool.version}`,
      version: pool.version,
      pool: { workers: pool.workers, port: pool.port },
      webServer: null,
    });
  }

  for (const entry of installed) {
    // The supervisor registers one service per component id, so a second
    // installed version of the same component has no separate lifecycle to
    // manage; the first one listed is the row that speaks for it.
    if (!supervisable.has(entry.component_id) || servers.has(entry.component_id)) {
      continue;
    }
    servers.set(entry.component_id, {
      id: entry.component_id,
      name: entry.component_id,
      version: entry.version,
      pool: null,
      webServer: WEB_SERVER_ID[entry.component_id] ?? null,
    });
  }

  return [...servers.values()];
}

/** `stopped` → `Stopped`, for a control that shows the state as a word. */
function stateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/**
 * The lifecycle commands every server shares.
 *
 * A pool and a component are started by different commands, so this is the one
 * place that knows which is which: the row's inline Start and the page's Start
 * all run the same call, and a failure is the caller's to report, never
 * swallowed here.
 *
 * There is no `service_restart` on the backend. Restart is composed below from
 * stop-then-start, and says so: if the start half fails, the service is left
 * stopped, which is exactly what the user would have ended up with doing it by
 * hand.
 */
function useServerCommands() {
  return useMemo(
    () => ({
      start: (server: ServerEntry): Promise<unknown> =>
        server.pool
          ? ipc.phpPoolStart(server.version, server.pool.workers)
          : ipc.serviceStart(server.id, server.version),
      stop: (server: ServerEntry): Promise<unknown> =>
        server.pool ? ipc.phpPoolStop(server.version) : ipc.serviceStop(server.id),
      restart: async (server: ServerEntry): Promise<void> => {
        await (server.pool
          ? ipc.phpPoolStop(server.version)
          : ipc.serviceStop(server.id));
        await (server.pool
          ? ipc.phpPoolStart(server.version, server.pool.workers)
          : ipc.serviceStart(server.id, server.version));
      },
    }),
    [],
  );
}

type ServerCommands = ReturnType<typeof useServerCommands>;

/** What a batch of starts or stops actually did, per service. */
type BatchReport = {
  done: string[];
  failed: { id: string; message: string }[];
};

/** Every part of the page that shows live service state reads one cache. */
function invalidateServerState(queryClient: ReturnType<typeof useQueryClient>) {
  // The state itself lives in the metrics sample; the pool list carries the
  // worker counts a start can update, and the port map gains an entry the
  // first time a service is planned.
  for (const key of [["service-metrics"], ["php-pools"], ["port-map"]]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/**
 * Runs one command over many servers.
 *
 * Failures are collected rather than aborting the rest, matching what
 * `services_start_all` does on the backend — except that the pools, which the
 * batch command does not know about, are covered here too.
 */
function useBulkCommand(
  run: (server: ServerEntry) => Promise<unknown>,
  action: string,
  done: string,
) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (servers: readonly ServerEntry[]): Promise<BatchReport> => {
      const settled = await Promise.allSettled(servers.map((server) => run(server)));
      const report: BatchReport = { done: [], failed: [] };
      settled.forEach((outcome, index) => {
        const server = servers[index];
        if (!server) {
          return;
        }
        if (outcome.status === "fulfilled") {
          report.done.push(server.name);
        } else {
          report.failed.push({ id: server.name, message: messageOf(outcome.reason) });
        }
      });
      return report;
    },
    onSettled: () => invalidateServerState(queryClient),
    onSuccess: (report) => {
      if (report.failed.length === 0) {
        const only = report.done.length === 1 ? report.done[0] : null;
        toast.success(
          only ? `${only} ${done}` : `${report.done.length} services ${done}`,
          { description: report.done.join(", ") },
        );
        return;
      }
      toast.error(
        `${report.failed.length} of ${
          report.done.length + report.failed.length
        } could not be ${done}`,
        {
          description:
            report.done.length > 0
              ? `${report.done.join(", ")} did change state; the rest did not.`
              : "No service changed state.",
          details: report.failed
            .map((failure) => `${failure.id}: ${failure.message}`)
            .join("\n"),
        },
      );
    },
    onError: (error) => {
      toast.error(`Could not ${action} the services`, { details: messageOf(error) });
    },
  });
}

/** One row of the §60 table, with §21's detail view underneath it. */
function ServerRow({
  server,
  state,
  open,
  onToggle,
  dataDir,
  metrics,
  metricsFailed,
  portsError,
  onRetryPorts,
  ports,
  commands,
}: {
  server: ServerEntry;
  state: ServiceState | null;
  open: boolean;
  onToggle: () => void;
  dataDir: string | null;
  metrics: ServiceMetrics | undefined;
  metricsFailed: boolean;
  portsError: Error | null;
  onRetryPorts: () => void;
  ports: readonly PortEntry[];
  commands: ServerCommands;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const active =
    state === "running" || state === "starting" || state === "stopping";

  const start = useMutation({
    mutationFn: () => commands.start(server),
    onSettled: () => invalidateServerState(queryClient),
    onSuccess: () =>
      toast.success(`${server.name} started`, {
        description: server.pool
          ? `FastCGI pool answering on 127.0.0.1:${server.pool.port}.`
          : "The supervisor reports it running.",
      }),
    onError: (error) =>
      toast.error(`${server.name} did not start`, { details: messageOf(error) }),
  });

  const stop = useMutation({
    mutationFn: () => commands.stop(server),
    onSettled: () => invalidateServerState(queryClient),
    onSuccess: () => toast.success(`${server.name} stopped`),
    onError: (error) =>
      toast.error(`${server.name} did not stop`, { details: messageOf(error) }),
  });

  const restart = useMutation({
    mutationFn: () => commands.restart(server),
    onSettled: () => invalidateServerState(queryClient),
    onSuccess: () => toast.success(`${server.name} restarted`),
    // §54: the restart's failure mode is named, because a failed start leaves
    // the service down and the button that would fix it is right there.
    onError: (error) =>
      toast.error(`${server.name} stopped but did not come back up`, {
        description:
          "Restart runs Stop and then Start. The start failed, so the service is not running. Press Start to try again.",
        details: messageOf(error),
      }),
  });

  const busy = start.isPending || stop.isPending || restart.isPending;
  const configPath = dataDir ? configPathFor(dataDir, server.id) : null;
  const logPath = dataDir ? logPathFor(dataDir, server.id) : null;

  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => (ipc.configGet ? ipc.configGet() : Promise.resolve(null as any)),
  });
  const [quickEditing, setQuickEditing] = useState(false);
  const [portInput, setPortInput] = useState("");

  const defaultPort = server.pool
    ? 9100
    : (DEFAULT_SERVICE_PORTS[server.id] ?? (server.id === "nginx" ? (config.data?.network.http_port ?? 80) : null));

  const configuredPort =
    config.data?.service_ports?.[server.id] ??
    (server.pool ? config.data?.service_ports?.[server.version] : null) ??
    (server.pool ? server.pool.port : defaultPort);

  const activePort = ports.find((entry) => entry.active)?.port ?? (active ? (ports[0]?.port ?? configuredPort) : null);
  const displayPort = active ? (activePort ?? configuredPort) : configuredPort;

  const setPortMutation = useMutation({
    mutationFn: (newPort: number | null) => ipc.serviceSetPort(server.id, newPort),
    onSuccess: () => {
      toast.success("Port updated", {
        description: `Port for ${server.name} has been updated.${active ? " Service restarted." : ""}`,
      });
      setQuickEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["port-map"] });
      void queryClient.invalidateQueries({ queryKey: ["php-pools"] });
      void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    },
    onError: (err: Error) => {
      toast.error("Failed to update port", { details: err.message });
    },
  });

  const savePort = () => {
    const val = portInput.trim();
    if (val === "") {
      setPortMutation.mutate(null);
    } else {
      const num = Number(val);
      if (!isNaN(num) && num > 0 && num <= 65535) {
        setPortMutation.mutate(num);
      } else {
        toast.error("Invalid port number", { description: "Port must be between 1 and 65535." });
      }
    }
  };

  const actions: MenuItem[] = [
    {
      id: "config-folder",
      label: "Open config folder",
      icon: FolderOpen,
      disabled: configPath === null,
      onSelect: () => {
        void (async () => {
          if (!configPath) {
            return;
          }
          // The backend command validates the path is under a DevX-managed
          // root, creates it when it does not exist yet (a service that has
          // never run has no config directory), and opens it — one call that
          // cannot fail on a folder DevX simply has not written yet.
          try {
            await ipc.revealManagedDir(configPath);
          } catch {
            // Outside the managed roots (or an older backend), fall back to
            // opening it directly from the webview.
            const fallback = await openFolder(configPath);
            if (fallback !== null) {
              toast.error("Could not open the config folder", {
                details: fallback === "missing" ? configPath : fallback,
              });
            }
          }
        })();
      },
    },
    {
      id: "copy-config",
      label: "Copy config path",
      icon: Copy,
      disabled: configPath === null,
      onSelect: () => {
        if (configPath) {
          void copyText(toast, configPath, "Config path copied");
        }
      },
    },
    {
      id: "copy-log",
      label: "Copy log path",
      icon: Copy,
      disabled: logPath === null,
      onSelect: () => {
        if (logPath) {
          void copyText(toast, logPath, "Log path copied");
        }
      },
    },
  ];
  const menu = useContextMenu({
    label: `Actions for ${server.name}`,
    items: actions,
  });

  return (
    <>
      <tr
        onContextMenu={menu.onContextMenu}
        className={cn(
          "border-t border-border transition-colors duration-150",
          open ? "bg-primary-soft" : "hover:bg-hover",
        )}
      >
        <td className="px-3 py-2">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2 text-left"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`Show details for ${server.name}`}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0">
              <span className="data-value block truncate font-medium" data-selectable>
                {server.name}
              </span>
              <span className="data-value block truncate text-ink-muted">
                {server.pool
                  ? `fastcgi · ${server.pool.workers} workers`
                  : `v${server.version}`}
              </span>
            </span>
          </button>
        </td>
        <td className="px-3 py-2">
          <ServerState state={state} />
        </td>
        <td className="px-3 py-2">
          {quickEditing ? (
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <Input
                type="number"
                min={1}
                max={65535}
                className="h-7 w-20 text-xs px-1.5 py-0 font-mono"
                placeholder={defaultPort ? String(defaultPort) : "Port"}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    savePort();
                  } else if (e.key === "Escape") {
                    setQuickEditing(false);
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={setPortMutation.isPending}
                onClick={savePort}
                title="Save port"
              >
                {setPortMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Check className="size-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-xs"
                onClick={() => setQuickEditing(false)}
                title="Cancel"
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : (
            <div className="group flex items-center gap-1.5">
              {displayPort === null ? (
                <NotReported what={portsError ? "Could not be read" : "Not reported"} />
              ) : (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                  {active ? (
                    <span
                      className="size-1.5 rounded-full bg-emerald-500 shrink-0"
                      title="Listening"
                    />
                  ) : (
                    <span
                      className="size-1.5 rounded-full bg-muted-foreground/30 shrink-0"
                      title="Configured (stopped)"
                    />
                  )}
                  <span
                    className={cn(
                      "data-value font-mono",
                      active ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                    data-selectable
                  >
                    {displayPort}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPortInput(displayPort ? String(displayPort) : "");
                  setQuickEditing(true);
                }}
                title={`Change port for ${server.name}`}
                aria-label={`Change port for ${server.name}`}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-muted/80 rounded text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}
        </td>

        <td className="hidden px-3 py-2 xl:table-cell">
          {configPath ? (
            <span
              className="data-value block max-w-[22rem] truncate text-ink-secondary"
              title={configPath}
              data-selectable
            >
              {configPath}
            </span>
          ) : (
            <NotReported />
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-2">
            {active ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => stop.mutate()}
              >
                {stop.isPending || restart.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Square />
                )}
                Stop
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => start.mutate()}>
                {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                Start
              </Button>
            )}
            {state === "running" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                // §91 wants the action on the item; §131 Rule 17 wants it
                // honest, so the tooltip says what a restart really is here.
                title="Stops the service, then starts it again. If the start fails it stays stopped."
                onClick={() => restart.mutate()}
              >
                {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
                {restart.isPending ? "Restarting…" : "Restart"}
              </Button>
            ) : null}
            <OverflowMenu label={`More actions for ${server.name}`} items={actions} />
          </div>
        </td>
        {/* A portal: it renders to the body, so the row's markup is unchanged. */}
        {menu.panel}
      </tr>

      {open ? (
        <tr className="border-t border-border bg-surface-2/60">
          <td colSpan={5} className="px-3 py-4">
            <ServerDetail
              server={server}
              state={state}
              configPath={configPath}
              logPath={logPath}
              metrics={metrics}
              metricsFailed={metricsFailed}
              portsError={portsError}
              onRetryPorts={onRetryPorts}
              ports={ports}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** §65: state is a dot plus a written label, never a colour on its own. */
function ServerState({ state }: { state: ServiceState | null }) {
  if (state === null) {
    // Not "stopped": the state could not be read, and §2 keeps those apart.
    return <Badge variant="outline">state unknown</Badge>;
  }
  return <StatusBadge state={state} />;
}

/** A value the backend has not reported — never a zero it never sent. */
function NotReported({ what = "Not reported" }: { what?: string }) {
  return (
    <>
      <span aria-hidden className="text-xs text-muted-foreground">
        —
      </span>
      <span className="sr-only">{what}</span>
    </>
  );
}

/** The tabs one server really has data for. */
type ServerTab = "overview" | "logs" | "ports" | "sites" | "configuration";

function serverTabs(
  server: ServerEntry,
  ports: readonly PortEntry[],
): { id: ServerTab; label: string }[] {
  const tabs: { id: ServerTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs" },
  ];
  // A pool always knows its FastCGI port; a component only appears in the port
  // map once the backend has planned it, so anything else gets no Ports tab
  // rather than an empty one.
  if (server.pool !== null || ports.length > 0) {
    tabs.push({ id: "ports", label: "Ports" });
  }
  // Sites are routed by web server or by PHP version, and only for the servers
  // the sites' own vocabulary can name.
  if (server.pool !== null || server.webServer !== null) {
    tabs.push({ id: "sites", label: "Sites" });
  }
  // Configuration needs commands that read and write it; only the PHP pool
  // tools have them.
  if (server.pool !== null) {
    tabs.push({ id: "configuration", label: "Configuration" });
  }
  return tabs;
}

/** §21's detail view for one server: Overview, Logs, Ports, Sites, Config. */
function ServerDetail({
  server,
  state,
  configPath,
  logPath,
  metrics,
  metricsFailed,
  portsError,
  onRetryPorts,
  ports,
}: {
  server: ServerEntry;
  state: ServiceState | null;
  configPath: string | null;
  logPath: string | null;
  metrics: ServiceMetrics | undefined;
  metricsFailed: boolean;
  portsError: Error | null;
  onRetryPorts: () => void;
  ports: readonly PortEntry[];
}) {
  const tabs = serverTabs(server, ports);
  const [tab, setTab] = useState<ServerTab>("overview");
  // A tab can disappear when its data does — the port map empties when a
  // service stops being planned. Falling back to Overview keeps the panel
  // from rendering a tab that is no longer there.
  const active = tabs.some((item) => item.id === tab) ? tab : "overview";

  return (
    <div className="space-y-4">
      <TabBar
        tabs={tabs}
        active={active}
        onSelect={setTab}
        label={`${server.name} sections`}
      />

      {active === "overview" ? (
        <ServerOverview
          server={server}
          state={state}
          configPath={configPath}
          metrics={metrics}
          metricsFailed={metricsFailed}
          port={server.pool ? server.pool.port : (ports[0]?.port ?? null)}
        />
      ) : null}
      {active === "logs" ? <ServerLogs server={server} logPath={logPath} /> : null}
      {active === "ports" ? (
        <ServerPorts
          server={server}
          ports={ports}
          portsError={portsError}
          onRetryPorts={onRetryPorts}
        />
      ) : null}
      {active === "sites" ? <ServerSites server={server} /> : null}
      {active === "configuration" ? (
        <PhpConfiguration version={server.version} />
      ) : null}
    </div>
  );
}

/** §21's Overview: what this server is, where it is configured, what it uses. */
function ServerOverview({
  server,
  state,
  configPath,
  port,
  metrics,
  metricsFailed,
}: {
  server: ServerEntry;
  state: ServiceState | null;
  configPath: string | null;
  port: number | null;
  metrics: ServiceMetrics | undefined;
  metricsFailed: boolean;
}) {
  const running = state === "running";

  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="State">
        <ServerState state={state} />
      </Fact>
      <Fact label="Version">
        <span className="data-value text-foreground" data-selectable>
          {server.version}
        </span>
      </Fact>
      <Fact label={server.pool ? "FastCGI endpoint" : "Port"}>
        {port === null ? (
          <NotReported />
        ) : (
          <span className="data-value text-foreground" data-selectable>
            {server.pool ? `127.0.0.1:${port}` : port}
          </span>
        )}
      </Fact>
      {server.pool ? (
        <Fact label="Workers">
          <span className="data-value text-foreground" data-selectable>
            {server.pool.workers}
          </span>
        </Fact>
      ) : null}
      <Fact label="Configuration">
        {configPath ? (
          <span
            className="data-value break-all text-ink-secondary"
            title={configPath}
            data-selectable
          >
            {configPath}
          </span>
        ) : (
          <NotReported />
        )}
      </Fact>
      <Fact label="CPU">
        {running && metrics?.cpu_percent != null ? (
          <span className="data-value text-foreground" data-selectable>
            {metrics.cpu_percent.toFixed(0)}%
          </span>
        ) : (
          <NotReported what={metricsFailed ? "Could not be read" : "Not reported"} />
        )}
      </Fact>
      <Fact label="Memory">
        {running && metrics ? (
          <span className="data-value text-foreground" data-selectable>
            {formatBytes(metrics.memory_bytes)}
          </span>
        ) : (
          <NotReported />
        )}
      </Fact>
      <Fact label="Processes">
        {running && metrics ? (
          <span className="data-value text-foreground" data-selectable>
            {metrics.processes}
          </span>
        ) : (
          <NotReported />
        )}
      </Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

function ServerPorts({
  server,
  ports,
  portsError,
  onRetryPorts,
}: {
  server: ServerEntry;
  ports: readonly PortEntry[];
  portsError: Error | null;
  onRetryPorts: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const config = useQuery({ queryKey: ["config"], queryFn: () => (ipc.configGet ? ipc.configGet() : Promise.resolve(null as any)) });

  const defaultPort = server.pool
    ? 9100
    : (DEFAULT_SERVICE_PORTS[server.id] ?? (server.id === "nginx" ? (config.data?.network.http_port ?? 80) : null));

  const configuredPort =
    config.data?.service_ports?.[server.id] ??
    (server.pool ? config.data?.service_ports?.[server.version] : null) ??
    (server.pool ? server.pool.port : defaultPort);

  const [editingPort, setEditingPort] = useState(false);
  const [portInput, setPortInput] = useState("");

  const setPortMutation = useMutation({
    mutationFn: (newPort: number | null) => ipc.serviceSetPort(server.id, newPort),
    onSuccess: () => {
      toast.success("Port updated", {
        description: `Port for ${server.name} has been updated.`,
      });
      setEditingPort(false);
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["port-map"] });
      void queryClient.invalidateQueries({ queryKey: ["php-pools"] });
      void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    },
    onError: (err: Error) => {
      toast.error("Failed to update port", { details: err.message });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3 text-sm">
        <div className="space-y-0.5">
          <span className="font-medium text-foreground">
            {server.pool ? "PHP FastCGI Socket:" : "Configured Port:"}
          </span>
          {server.pool ? (
            <p className="text-xs text-muted-foreground">
              The socket this pool serves PHP requests on.
            </p>
          ) : null}
        </div>

        {editingPort ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={65535}
              className="h-8 w-28 text-xs font-mono"
              placeholder={defaultPort ? String(defaultPort) : "Default"}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              autoFocus
            />
            <Button
              size="sm"
              className="h-8"
              disabled={setPortMutation.isPending}
              onClick={() => {
                const val = portInput.trim();
                if (val === "") {
                  setPortMutation.mutate(null);
                } else {
                  const num = Number(val);
                  if (!isNaN(num) && num > 0 && num <= 65535) {
                    setPortMutation.mutate(num);
                  } else {
                    toast.error("Invalid port number", { description: "Port must be between 1 and 65535." });
                  }
                }
              }}
            >
              Save
            </Button>
            {configuredPort !== defaultPort ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={setPortMutation.isPending}
                onClick={() => setPortMutation.mutate(null)}
                title="Reset to default port"
              >
                <RotateCcw className="size-3 mr-1" />
                Reset
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setEditingPort(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="data-value text-foreground font-mono font-medium" data-selectable>
              {server.pool
                ? `127.0.0.1:${configuredPort ?? server.pool.port}`
                : (configuredPort ?? "Default")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setPortInput(configuredPort ? String(configuredPort) : "");
                setEditingPort(true);
              }}
            >
              <Pencil className="size-3 mr-1" />
              Change port
            </Button>
          </div>
        )}
      </div>

      {ports.length > 0 ? (
        <table className="w-full max-w-lg text-left text-sm">
          <caption className="sr-only">Ports the port map attributes to this service</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Port
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Claimed by
              </th>
              <th scope="col" className="py-1.5 font-medium">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {ports.map((entry) => (
              <tr key={`${entry.owner}-${entry.port}`} className="border-t border-border">
                <td className="py-1.5 pr-3">
                  <span className="data-value text-foreground" data-selectable>
                    {entry.port}
                  </span>
                </td>
                <td className="py-1.5 pr-3">
                  <span className="data-value text-ink-secondary">{entry.owner}</span>
                </td>
                <td className="py-1.5">
                  {/* §55: the dot is labelled — "claim" only becomes "listen"
                      while the process is actually up. */}
                  <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        entry.active ? "bg-success" : "bg-muted-foreground/40",
                      )}
                    />
                    {entry.active ? "listening" : "claimed"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : portsError ? (
        // §131 Rule 18: a failed port-map read is not the same as a service
        // that claims no ports, so the tab says which one happened.
        <Callout variant="destructive" title="Could not read the port map.">
          <p>{portsError.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={onRetryPorts}>
            Try again
          </Button>
        </Callout>
      ) : (
        <EmptyState
          icon={<Plug />}
          title="The port map attributes no other port to this service."
        />
      )}

      {ports.length > 0 ? (
        <p className="text-xs text-ink-muted">
          A claimed port is reserved for this service; it listens only while the
          service runs.
        </p>
      ) : null}

      {/* §110: this tab is DevX's own ports for one service. The machine's
          whole listener table — including other software's ports — is in the
          inspector, reached from here rather than given a tab of its own. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-ink-muted">
          DevX's ports for this service only. The inspector lists every port on
          the machine, including other software's.
        </p>
        <PortInspectorButton />
      </div>
    </div>
  );
}

/** The sites this server actually serves, in the sites' own terms (§23). */
function ServerSites({ server }: { server: ServerEntry }) {
  const sites = useSites();

  if (sites.isPending) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading sites…</span>
        <div aria-hidden className="space-y-2">
          <span className="block h-4 w-64 animate-pulse rounded-sm bg-secondary" />
          <span className="block h-4 w-40 animate-pulse rounded-sm bg-secondary" />
        </div>
      </div>
    );
  }
  if (sites.isError) {
    return (
      <Callout variant="destructive" title="Could not read the sites.">
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
    );
  }

  const served = (sites.data ?? []).filter((site) =>
    server.pool
      ? site.php_version === server.version
      : site.web_server === server.webServer,
  );

  if (served.length === 0) {
    return (
      <EmptyState
        icon={<Globe />}
        title="No site is served by this server."
        description={
          server.pool
            ? `No site is configured to use PHP ${server.version}.`
            : `${server.name} serves no configured site yet.`
        }
        action={
          <Link
            to="/sites"
            className="text-sm text-primary hover:underline"
          >
            Open Sites
          </Link>
        }
      />
    );
  }

  return (
    <ul className="space-y-1.5">
      {served.map((site) => {
        const url = `${site.https ? "https" : "http"}://${site.hostname}`;
        return (
          <li
            key={site.hostname}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border px-3 py-2"
          >
            <span className="data-value text-foreground" data-selectable>
              {site.hostname}
            </span>
            <Badge variant="outline">{url}</Badge>
            <span
              className="data-value min-w-0 flex-1 truncate text-ink-muted"
              title={site.docroot}
              data-selectable
            >
              {site.docroot}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Open ${url} in the browser`}
              onClick={() => void openInBrowser(url)}
            >
              <ExternalLink />
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * §22's log viewer over the live ring buffer of one service.
 *
 * The backend numbers every captured line, so the viewer asks for "everything
 * after N": nothing is duplicated, and a paused feed resumes without a gap.
 * A failed read is shown rather than skipped, because a log that quietly stops
 * updating is worse than one that says why.
 */
function ServerLogs({ server, logPath }: { server: ServerEntry; logPath: string | null }) {
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const after = useRef(0);

  const poolVersion = server.pool ? server.version : null;
  const id = server.id;

  useEffect(() => {
    if (paused) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const next: LogEntry[] = poolVersion
          ? await ipc.phpPoolLogs(poolVersion, after.current)
          : await ipc.serviceLogs(id, after.current);
        if (cancelled) {
          return;
        }
        setPending(false);
        setError(null);
        if (next.length === 0) {
          return;
        }
        const last = next[next.length - 1];
        if (last) {
          after.current = last.seq;
        }
        setLines((current) => [...current, ...next.map(toLogLine)].slice(-LOG_VIEW_LIMIT));
      } catch (err) {
        if (!cancelled) {
          setPending(false);
          setError(messageOf(err));
        }
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, poolVersion, paused]);

  return (
    <div className="space-y-2">
      <LogViewer
        title={`${server.id}.log`}
        meta="supervisor output"
        lines={lines}
        paused={paused}
        onPausedChange={setPaused}
        // Clearing drops the view; the ring keeps counting, so the next poll
        // continues from where this one stopped instead of replaying.
        onClear={() => setLines([])}
        pending={pending}
        error={error}
        emptyMessage="Nothing captured yet. Start the service and its output lands here."
      />
      {logPath ? (
        <p className="text-xs text-ink-muted">
          DevX appends this service&apos;s output to{" "}
          <span className="data-value" data-selectable>
            {logPath}
          </span>
          , which keeps the history this view no longer holds.
        </p>
      ) : null}
    </div>
  );
}

/** How many lines one detail view keeps before it drops the oldest. */
const LOG_VIEW_LIMIT = 500;

function toLogLine(entry: LogEntry): LogLine {
  return {
    id: String(entry.seq),
    text: entry.text,
    stream: entry.stream,
    position: entry.seq,
  };
}

/** The PHP-only configuration tools, which is why only pools get this tab. */
function PhpConfiguration({ version }: { version: string }) {
  return (
    <div className="space-y-4">
      <ConfigBlock
        icon={Gauge}
        title="Resource limits"
        description="memory_limit, upload_max_filesize, max_execution_time and OPcache, written into this pool's php.ini."
      >
        <LimitsPanel version={version} />
      </ConfigBlock>
      <ConfigBlock
        icon={Puzzle}
        title="Extensions"
        description="The extension DLLs this PHP build ships; the pool's ini is re-rendered when one changes."
      >
        <ExtensionsPanel version={version} />
      </ConfigBlock>
      <ConfigBlock
        icon={Bug}
        title="Xdebug"
        description="Step debugging for this version, with the mode and IDE port Xdebug connects back to."
      >
        <XdebugPanel version={version} />
      </ConfigBlock>
    </div>
  );
}

function ConfigBlock({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="text-xs text-ink-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Xdebug controls for one PHP version: a master switch plus mode and IDE
 * port fields. Enabling requires the installed PHP to ship xdebug; the
 * backend validates that and the pool restarts on change.
 */
function XdebugPanel({ version }: { version: string }) {
  const info = useQuery({
    queryKey: ["php-xdebug", version],
    queryFn: () => ipc.phpXdebugGet(version),
  });

  if (info.isPending) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading Xdebug settings…</span>
        <div aria-hidden className="space-y-2">
          <span className="block h-4 w-48 animate-pulse rounded-sm bg-secondary" />
          <span className="block h-4 w-32 animate-pulse rounded-sm bg-secondary" />
        </div>
      </div>
    );
  }
  if (info.isError) {
    return (
      <Callout variant="destructive" title="Could not read the Xdebug settings.">
        <p>{info.error.message}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => void info.refetch()}
        >
          Try again
        </Button>
      </Callout>
    );
  }

  return <XdebugForm version={version} current={info.data} />;
}

/**
 * The settings form itself, split out so its field state is created once the
 * values exist — the hooks below must not appear conditionally with the load.
 */
function XdebugForm({
  version,
  current,
}: {
  version: string;
  current: { enabled: boolean; mode: string; client_port: number };
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState(current.mode || "debug");
  const [port, setPort] = useState(current.client_port ? String(current.client_port) : "9003");

  const set = useMutation({
    mutationFn: ({
      enabled,
      mode: nextMode,
      clientPort,
    }: {
      enabled: boolean;
      mode: string;
      clientPort: number;
    }) => ipc.phpXdebugSet(version, enabled, nextMode, clientPort),
    onSuccess: (updated) => {
      queryClient.setQueryData(["php-xdebug", version], updated);
      // The pool's ini changed; its live status card re-renders on poll.
      // §54: the mode and port fields do not show the write, so it is said.
      toast.success(`Xdebug ${updated.enabled ? "enabled" : "disabled"} for PHP ${version}`, {
        description: "A running pool restarts to apply it.",
      });
    },
    onError: (error) =>
      toast.error(`Could not save the Xdebug settings for PHP ${version}`, {
        details: messageOf(error),
      }),
  });

  const save = (enabled: boolean) => {
    set.mutate({
      enabled,
      mode: enabled ? mode.trim() : "",
      clientPort: enabled ? Number(port) || 0 : 0,
    });
  };

  return (
    <div className="space-y-2 rounded-sm border border-border p-3">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Xdebug debugger</span>
        <Switch
          checked={current.enabled}
          disabled={set.isPending}
          onCheckedChange={(checked) => save(checked)}
          aria-label={`${current.enabled ? "Disable" : "Enable"} Xdebug`}
        />
      </label>
      {current.enabled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`xdebug-mode-${version}`}>Mode</Label>
            <Input
              id={`xdebug-mode-${version}`}
              value={mode}
              placeholder="debug"
              className="w-40 font-mono text-xs"
              onChange={(event) => setMode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`xdebug-port-${version}`}>IDE port</Label>
            <Input
              id={`xdebug-port-${version}`}
              value={port}
              placeholder="9003"
              className="w-24 font-mono text-xs"
              onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={
              set.isPending ||
              (mode.trim() === (current.mode || "debug") &&
                (Number(port) || 0) === current.client_port)
            }
            onClick={() => save(true)}
          >
            {set.isPending ? <Loader2 className="animate-spin" /> : null}
            Apply
          </Button>
        </div>
      ) : null}
      {set.error instanceof Error ? (
        <Callout variant="destructive" title="Could not save the Xdebug settings.">
          <p>{set.error.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Resource limits for one PHP pool: memory, upload size, execution time
 * and OPcache. Saving re-renders the pool's ini; a running pool restarts
 * so the values apply immediately.
 */
function LimitsPanel({ version }: { version: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const limits = useQuery({
    queryKey: ["php-limits", version],
    queryFn: () => ipc.phpLimitsGet(version),
  });

  const set = useMutation({
    mutationFn: (next: LimitConfig) => ipc.phpLimitsSet(version, next),
    onSuccess: (saved) => {
      queryClient.setQueryData(["php-limits", version], saved);
      // §54: the fields already held these values, so the write is named.
      toast.success(`Limits saved for PHP ${version}`, {
        description: "A running pool restarts to apply them.",
      });
    },
    onError: (error) =>
      toast.error(`Could not save the limits for PHP ${version}`, {
        details: messageOf(error),
      }),
  });

  if (limits.isPending) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading limits…</span>
        <div aria-hidden className="space-y-2">
          <span className="block h-4 w-56 animate-pulse rounded-sm bg-secondary" />
          <span className="block h-4 w-36 animate-pulse rounded-sm bg-secondary" />
        </div>
      </div>
    );
  }
  if (limits.isError) {
    return (
      <Callout variant="destructive" title="Could not read the limits.">
        <p>{limits.error.message}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => void limits.refetch()}
        >
          Try again
        </Button>
      </Callout>
    );
  }

  const current = {
    memory_limit: limits.data.memory_limit ?? "256M",
    upload_max_filesize: limits.data.upload_max_filesize ?? "64M",
    max_execution_time: limits.data.max_execution_time ?? 60,
    opcache_enabled: limits.data.opcache_enabled ?? true,
  };

  return (
    <LimitsForm
      version={version}
      current={current}
      saving={set.isPending}
      error={set.error instanceof Error ? set.error.message : null}
      onSave={(next) => set.mutate(next)}
    />
  );
}

function LimitsForm({
  version,
  current,
  saving,
  error,
  onSave,
}: {
  version: string;
  current: {
    memory_limit: string;
    upload_max_filesize: string;
    max_execution_time: number;
    opcache_enabled: boolean;
  };
  saving: boolean;
  error: string | null;
  onSave: (next: LimitConfig) => void;
}) {
  const [memory, setMemory] = useState(current.memory_limit);
  const [upload, setUpload] = useState(current.upload_max_filesize);
  const [execution, setExecution] = useState(String(current.max_execution_time));
  const [opcache, setOpcache] = useState(current.opcache_enabled);

  const dirty =
    memory !== current.memory_limit ||
    upload !== current.upload_max_filesize ||
    Number(execution) !== current.max_execution_time ||
    opcache !== current.opcache_enabled;

  const save = () => {
    onSave({
      memory_limit: memory.trim(),
      upload_max_filesize: upload.trim(),
      max_execution_time: Number(execution) || 60,
      opcache_enabled: opcache,
    });
  };

  return (
    <div className="space-y-3 rounded-sm border border-border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`limits-memory-${version}`}>Memory limit</Label>
          <Input
            id={`limits-memory-${version}`}
            value={memory}
            onChange={(event) => setMemory(event.target.value)}
            placeholder="256M"
            className="w-24 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`limits-upload-${version}`}>Upload max</Label>
          <Input
            id={`limits-upload-${version}`}
            value={upload}
            onChange={(event) => setUpload(event.target.value)}
            placeholder="64M"
            className="w-24 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`limits-exec-${version}`}>Max execution (s)</Label>
          <Input
            id={`limits-exec-${version}`}
            type="number"
            min={1}
            max={3600}
            value={execution}
            onChange={(event) => setExecution(event.target.value)}
            className="w-24 font-mono text-xs"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span>OPcache</span>
          <Switch
            checked={opcache}
            onCheckedChange={setOpcache}
            aria-label={`Toggle OPcache for ${version}`}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || !dirty} onClick={save}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          Save limits
        </Button>
        <span className="text-xs text-muted-foreground">
          A running pool restarts to apply the new values.
        </span>
      </div>
      {error ? (
        <Callout variant="destructive" title="Could not save the limits.">
          <p>{error}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Lists the extensions a PHP version offers — DLLs on disk merged with the
 * shipped php.ini — with a switch per extension. Changing one re-renders
 * the pool's ini and restarts the pool, which the backend does as part of
 * `php_ext_set`. Names without a DLL are shown but cannot be enabled.
 */
function ExtensionsPanel({ version }: { version: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const info = useQuery({
    queryKey: ["php-ext", version],
    queryFn: () => ipc.phpExtList(version),
  });

  const setExtension = useMutation({
    mutationFn: ({ extension, enabled }: { extension: string; enabled: boolean }) =>
      ipc.phpExtSet(version, extension, enabled),
    onSuccess: (updated, { extension, enabled }) => {
      queryClient.setQueryData(["php-ext", version], updated);
      // §54: the switch alone does not say the pool's ini was re-rendered.
      toast.success(`${extension} ${enabled ? "enabled" : "disabled"} for PHP ${version}`, {
        description: "A running pool restarts to load the change.",
      });
    },
    onError: (error, { extension, enabled }) =>
      toast.error(
        `${extension} could not be ${enabled ? "enabled" : "disabled"} for PHP ${version}`,
        { details: messageOf(error) },
      ),
  });

  if (info.isPending) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading extensions…</span>
        <div aria-hidden className="grid gap-1.5 sm:grid-cols-2">
          <span className="block h-8 animate-pulse rounded-sm bg-secondary" />
          <span className="block h-8 animate-pulse rounded-sm bg-secondary" />
        </div>
      </div>
    );
  }
  if (info.isError) {
    return (
      <Callout variant="destructive" title="Could not read the extensions.">
        <p>{info.error.message}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => void info.refetch()}
        >
          Try again
        </Button>
      </Callout>
    );
  }
  if (info.data.entries.length === 0) {
    return (
      <EmptyState
        icon={<Puzzle />}
        title="No extensions in this build."
        description={
          <>
            This PHP build ships neither extension DLLs nor a readable php.ini.
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Short names from the shipped php.ini: uncommented means on. Toggling
        edits the ini itself, so hand edits and the UI never disagree.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {info.data.entries.map((entry) => (
          <label
            key={entry.name}
            className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="data-value truncate" data-selectable>
                {entry.name}
              </span>
              {!entry.has_dll ? (
                <Badge variant="warning">no DLL</Badge>
              ) : !entry.from_ini ? (
                <Badge variant="secondary">dll only</Badge>
              ) : null}
            </span>
            <Switch
              checked={entry.enabled}
              disabled={setExtension.isPending || !entry.has_dll}
              onCheckedChange={(checked) =>
                setExtension.mutate({ extension: entry.name, enabled: checked })
              }
              aria-label={`${entry.enabled ? "Disable" : "Enable"} ${entry.name}${
                entry.has_dll ? "" : " (unavailable: no DLL on disk)"
              }`}
            />
          </label>
        ))}
      </div>
      {setExtension.error instanceof Error ? (
        <Callout variant="destructive" title="Could not change the extension.">
          <p>{setExtension.error.message}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/** Queue Workers: user-configured supervised processes, started in bulk. */
function WorkersSection({ phpVersions }: { phpVersions: string[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  // Removing a worker deletes its definition, which cannot be undone from
  // here, so the name waits for confirmation (§35, §131 Rule 19).
  const [removing, setRemoving] = useState<string | null>(null);

  const workers = useQuery({
    queryKey: ["worker-list"],
    queryFn: ipc.workerList,
  });

  const remove = useMutation({
    mutationFn: ipc.workerRemove,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["worker-list"] });
      setRemoving(null);
    },
    // The row is gone either way, so the toast is what says which of the two
    // happened (§54).
    onSuccess: (_data, name) => toast.success(`Worker ${name} removed`),
    onError: (error, name) =>
      toast.error(`Worker ${name} was not removed`, { details: messageOf(error) }),
  });

  const configured = workers.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">Queue workers</CardTitle>
            <CardDescription>
              Long-running commands supervised like any other service: each
              instance restarts with backoff when it exits.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setAdding((open) => !open)}>
            <Plus />
            Add worker
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <AddWorkerForm
            phpVersions={phpVersions}
            onDone={() => setAdding(false)}
          />
        ) : null}

        {workers.isPending ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">Loading workers…</span>
            <div aria-hidden className="space-y-2">
              <span className="block h-10 animate-pulse rounded-sm bg-secondary" />
              <span className="block h-10 animate-pulse rounded-sm bg-secondary" />
            </div>
          </div>
        ) : workers.isError ? (
          <Callout variant="destructive" title="Could not read the queue workers.">
            <p>{workers.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void workers.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : configured.length === 0 ? (
          <EmptyState
            icon={<RotateCw />}
            title="No workers configured."
            description={
              <>
                Add one below to run e.g. <code>php artisan queue:work</code> under
                DevX&apos;s supervisor.
              </>
            }
          />
        ) : (
          <ul className="space-y-2">
            {configured.map((worker) => (
              <li key={worker.name}>
                <WorkerCard worker={worker} onRemove={() => setRemoving(worker.name)} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            remove.mutate(removing);
          }
        }}
        title={`Remove worker ${removing ?? ""}?`}
        description="DevX stops its running instances and deletes the worker definition from your config. You would have to add it again to bring it back."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
      />
    </Card>
  );
}

/** One configured worker row: live instances plus start/stop/remove actions. */
function WorkerCard({
  worker,
  onRemove,
}: {
  worker: WorkerStatus;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const adopt = (updated: readonly WorkerStatus[]) => {
    queryClient.setQueryData(["worker-list"], (current: WorkerStatus[] | undefined) =>
      current?.map((w) => (w.name === updated[0]?.name ? updated[0] : w)) ?? current,
    );
  };

  const start = useMutation({
    mutationFn: () => ipc.workerStart(worker.name),
    onSuccess: (updated) => {
      adopt(updated);
      toast.success(`Worker ${worker.name} started`);
    },
    onError: (error) =>
      toast.error(`Worker ${worker.name} did not start`, { details: messageOf(error) }),
  });
  const stop = useMutation({
    mutationFn: () => ipc.workerStop(worker.name),
    onSuccess: (updated) => {
      adopt(updated);
      toast.success(`Worker ${worker.name} stopped`);
    },
    onError: (error) =>
      toast.error(`Worker ${worker.name} did not stop`, { details: messageOf(error) }),
  });

  const runningCount = worker.live.filter((entry) => entry.state === "running").length;
  const anyActive = worker.live.some((entry) => entry.state !== "stopped");
  const label = worker.php_version
    ? `php ${worker.php_version}`
    : (worker.program ?? "");
  const detail = `${label} ${worker.args.join(" ")} · ${worker.working_dir}`;

  return (
    <div className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="data-value text-sm text-foreground">{worker.name}</span>
          {runningCount > 0 ? (
            <Badge variant="success">
              {runningCount}/{worker.instances} running
            </Badge>
          ) : (
            <Badge variant="outline">stopped</Badge>
          )}
          {worker.live.some((entry) => entry.state === "failed") ? (
            <Badge variant="destructive">failed</Badge>
          ) : null}
        </p>
        <p
          className="data-value truncate text-muted-foreground"
          title={detail}
          data-selectable
        >
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {anyActive ? (
          <Button variant="outline" size="sm" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Start
          </Button>
        )}
        <Tooltip label={`Remove ${worker.name}`}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove ${worker.name}`}
          >
            <Trash2 />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Collects a worker definition: program or PHP version, args, dir, instances. */
function AddWorkerForm({
  phpVersions,
  onDone,
}: {
  phpVersions: string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [usePhp, setUsePhp] = useState(phpVersions.length > 0);
  const [phpVersion, setPhpVersion] = useState(phpVersions[0] ?? "");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("queue:work --tries=3 --sleep=3");
  const [workingDir, setWorkingDir] = useState("");
  const [instances, setInstances] = useState(1);

  const add = useMutation({
    mutationFn: () =>
      ipc.workerAdd(
        name.trim(),
        usePhp ? null : program.trim(),
        usePhp ? phpVersion : null,
        args.trim().length === 0 ? [] : args.trim().split(/\s+/),
        workingDir.trim(),
        instances,
      ),
    onSettled: (data) => {
      if (data) {
        void queryClient.invalidateQueries({ queryKey: ["worker-list"] });
        // The form closing is the only visible change; the toast says what
        // was saved so the click has a receipt (§54).
        toast.success(`Worker ${name.trim()} saved`, {
          description: "Start it from the Workers tab.",
        });
        onDone();
      }
    },
    onError: (error) =>
      toast.error(`Worker ${name.trim()} was not saved`, { details: messageOf(error) }),
  });

  return (
    <form
      className="space-y-4 rounded-sm border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="worker-name">Name</Label>
          <Input
            id="worker-name"
            value={name}
            placeholder="myapp-queue"
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          <p className="text-xs text-muted-foreground">Lowercase letters, digits, hyphens.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="worker-kind">Interpreter</Label>
          <Select
            id="worker-kind"
            value={usePhp ? "php" : "program"}
            onChange={(event) => setUsePhp(event.target.value === "php")}
          >
            <option value="php" disabled={phpVersions.length === 0}>
              DevX PHP ({phpVersions[0] ?? "none installed"})
            </option>
            <option value="program">Custom program</option>
          </Select>
        </div>

        {usePhp ? (
          <div className="space-y-1.5">
            <Label htmlFor="worker-php">PHP version</Label>
            <Select
              id="worker-php"
              value={phpVersion}
              onChange={(event) => setPhpVersion(event.target.value)}
            >
              {phpVersions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="worker-program">Program</Label>
            <Input
              id="worker-program"
              value={program}
              placeholder="node C:\project\worker.js"
              onChange={(event) => setProgram(event.target.value)}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="worker-args">Arguments</Label>
          <Input
            id="worker-args"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="worker-dir">Working directory</Label>
          <Input
            id="worker-dir"
            value={workingDir}
            placeholder="C:\src\myapp"
            onChange={(event) => setWorkingDir(event.target.value)}
          />
        </div>

        <div className="space-y-1.5 sm:max-w-40">
          <Label htmlFor="worker-instances">Instances</Label>
          <Input
            id="worker-instances"
            type="number"
            min={1}
            max={8}
            value={instances}
            onChange={(event) => setInstances(Number(event.target.value))}
          />
        </div>
      </div>

      {add.error instanceof Error ? (
        <Callout variant="destructive" title="Could not save the worker.">
          <p>{add.error.message}</p>
        </Callout>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={add.isPending || name.trim().length === 0}>
          {add.isPending ? <Loader2 className="animate-spin" /> : null}
          Save worker
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Scheduled tasks: Windows tasks DevX creates from `[[cron]]` config. */
function SchedulerSection({ phpVersions }: { phpVersions: string[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  // Deleting a task drops its config entry and the Windows task, neither of
  // which comes back, so the name waits for confirmation (§35, §131 Rule 19).
  const [deleting, setDeleting] = useState<string | null>(null);

  const cron = useQuery({
    queryKey: ["cron-list"],
    queryFn: ipc.cronList,
  });

  const remove = useMutation({
    mutationFn: ipc.cronDelete,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["cron-list"] });
      setDeleting(null);
    },
    onSuccess: (_data, name) => toast.success(`Task ${name} deleted`),
    onError: (error, name) =>
      toast.error(`Task ${name} was not deleted`, { details: messageOf(error) }),
  });

  const configured = cron.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">Scheduled tasks</CardTitle>
            <CardDescription>
              Windows scheduled tasks DevX creates for you, e.g.{""}
              <code> php artisan schedule:run </code> every minute for a site.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setAdding((open) => !open)}>
            <Plus />
            Add task
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <AddCronForm phpVersions={phpVersions} onDone={() => setAdding(false)} />
        ) : null}

        {cron.isPending ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">Loading scheduled tasks…</span>
            <div aria-hidden className="space-y-2">
              <span className="block h-10 animate-pulse rounded-sm bg-secondary" />
              <span className="block h-10 animate-pulse rounded-sm bg-secondary" />
            </div>
          </div>
        ) : cron.isError ? (
          <Callout variant="destructive" title="Could not read the scheduled tasks.">
            <p>{cron.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void cron.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : configured.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="No scheduled tasks."
            description="Add one below to run a command on an interval; the task lives in Windows Task Scheduler under the DevX prefix."
          />
        ) : (
          <ul className="space-y-2">
            {configured.map((job) => {
              const detail =
                (job.php_version ? `php ${job.php_version}` : (job.program ?? "")) +
                " " +
                job.args.join(" ") +
                " · " +
                job.working_dir;
              return (
                <li
                  key={job.name}
                  className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                      <span className="data-value text-sm text-foreground">{job.name}</span>
                      <Badge variant={job.registered ? "success" : "outline"}>
                        {job.registered
                          ? "every " + job.every_minutes + " min"
                          : "missing in Windows"}
                      </Badge>
                    </p>
                    <p
                      className="data-value truncate text-muted-foreground"
                      title={detail}
                      data-selectable
                    >
                      {detail}
                    </p>
                    {job.registered ? (
                      <p className="text-xs text-muted-foreground">
                        Next run:{" "}
                        <span className="data-value">
                          {job.next_run ?? "unknown (Task Scheduler did not report one)"}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <Tooltip label={`Delete ${job.name}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => setDeleting(job.name)}
                      aria-label={`Delete ${job.name}`}
                    >
                      {remove.isPending && remove.variables === job.name ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            remove.mutate(deleting);
          }
        }}
        title={`Delete task ${deleting ?? ""}?`}
        description="DevX removes the task from your config and deletes the Windows scheduled task it created. You would have to add it again to bring it back."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
      />
    </Card>
  );
}

/** Collects a scheduled task definition and registers it with Windows. */
function AddCronForm({
  phpVersions,
  onDone,
}: {
  phpVersions: string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [usePhp, setUsePhp] = useState(phpVersions.length > 0);
  const [phpVersion, setPhpVersion] = useState(phpVersions[0] ?? "");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("artisan schedule:run");
  const [workingDir, setWorkingDir] = useState("");
  const [everyMinutes, setEveryMinutes] = useState(1);

  const add = useMutation({
    mutationFn: () =>
      ipc.cronSet(
        name.trim(),
        usePhp ? null : program.trim(),
        usePhp ? phpVersion : null,
        args.trim().length === 0 ? [] : args.trim().split(/\s+/),
        workingDir.trim(),
        everyMinutes,
      ),
    onSettled: (data) => {
      if (data) {
        void queryClient.invalidateQueries({ queryKey: ["cron-list"] });
        toast.success(`Task ${name.trim()} registered`, {
          description: `Runs every ${everyMinutes} minute${everyMinutes === 1 ? "" : "s"}.`,
        });
        onDone();
      }
    },
    onError: (error) =>
      toast.error(`Task ${name.trim()} was not registered`, { details: messageOf(error) }),
  });

  return (
    <form
      className="space-y-4 rounded-sm border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cron-name">Name</Label>
          <Input
            id="cron-name"
            value={name}
            placeholder="myapp-schedule"
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          <p className="text-xs text-muted-foreground">
            Created as a per-user Windows task named "DevX {name || "…"}".
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cron-kind">Interpreter</Label>
          <Select
            id="cron-kind"
            value={usePhp ? "php" : "program"}
            onChange={(event) => setUsePhp(event.target.value === "php")}
          >
            <option value="php" disabled={phpVersions.length === 0}>
              DevX PHP ({phpVersions[0] ?? "none installed"})
            </option>
            <option value="program">Custom program</option>
          </Select>
        </div>
        {usePhp ? (
          <div className="space-y-1.5">
            <Label htmlFor="cron-php">PHP version</Label>
            <Select
              id="cron-php"
              value={phpVersion}
              onChange={(event) => setPhpVersion(event.target.value)}
            >
              {phpVersions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="cron-program">Program</Label>
            <Input
              id="cron-program"
              value={program}
              placeholder="C:\tools\task.exe"
              onChange={(event) => setProgram(event.target.value)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="cron-args">Arguments</Label>
          <Input
            id="cron-args"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cron-dir">Working directory</Label>
          <Input
            id="cron-dir"
            value={workingDir}
            placeholder="C:\src\myapp"
            onChange={(event) => setWorkingDir(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:max-w-40">
          <Label htmlFor="cron-minutes">Every (minutes)</Label>
          <Input
            id="cron-minutes"
            type="number"
            min={1}
            max={10080}
            value={everyMinutes}
            onChange={(event) => setEveryMinutes(Number(event.target.value))}
          />
        </div>
      </div>

      {add.error instanceof Error ? (
        <Callout variant="destructive" title="Could not save the scheduled task.">
          <p>{add.error.message}</p>
        </Callout>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={add.isPending || name.trim().length === 0}>
          {add.isPending ? <Loader2 className="animate-spin" /> : null}
          Save task
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A message for a caught value that may not be an `Error`. */
function messageOf(error: unknown): string {
  if (error instanceof IpcError && error.hint) {
    return `${error.message}: ${error.hint}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Writes to the clipboard and says what happened either way. */
async function copyText(
  toast: ReturnType<typeof useToast>,
  text: string,
  title: string,
): Promise<void> {
  if (!navigator.clipboard) {
    toast.error("Could not copy", {
      description: "The clipboard is not available in this window.",
      details: text,
    });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(title, { description: text });
  } catch (error) {
    toast.error("Could not copy", { details: messageOf(error) });
  }
}

/** Formats a byte count for the Overview. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}
