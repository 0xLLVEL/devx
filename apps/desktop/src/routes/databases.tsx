import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  Play,
  Save,
  Square,
  Table2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { FilterBar, type ActiveFilter } from "@/components/filter-bar";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverflowMenu, useContextMenu, type MenuItem } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { pickCsvSavePath, pickSqlFile } from "@/lib/pick-file";
import { cn } from "@/lib/utils";
import {
  ipc,
  type ConnectionParams,
  type DbResult,
  type DbServer,
  type DbValue,
  type InstalledVersion,
  type LogEntry,
  type ServiceMetrics,
  type ServiceState,
} from "@/lib/ipc";

type EngineKind = DbServer["engine"];
type TabId = "overview" | "databases" | "query" | "backups" | "logs";

/** Credentials typed for one server, applied to every request against it. */
type Credentials = { username: string; password: string };

/**
 * What the page can honestly say about one engine's process (§121).
 *
 * `null` is "no local binary" — the engine is not installed. A read that is
 * still in flight or that failed is a different fact, and neither may be shown
 * as the other.
 */
type EngineState = ServiceState | "pending" | "unknown" | null;

const NO_CREDENTIALS: Credentials = { username: "", password: "" };

/**
 * Database Manager (§25) and Database Detail (§26).
 *
 * The cards carry what the backend actually reports: engine, installed
 * version, host, port, database count, and two distinct facts about state.
 * The first is the supervised process (§119 `running`/`stopped`/`failed`), the
 * second whether the port accepts a TCP connection. §119 forbids overloading
 * one state with both
 * meanings, so they are never merged into a single dot.
 *
 * The detail behind the cards is tabbed, and only for surfaces with data
 * behind them: §26 also sketches Users and Connections, which no command
 * exposes, so no tab pretends otherwise.
 */
export function DatabasesPage() {
  const servers = useQuery({ queryKey: ["db-servers"], queryFn: ipc.dbListServers });
  const installed = useQuery({
    queryKey: ["installed-versions"],
    queryFn: ipc.installedVersions,
  });
  const metrics = useQuery({
    queryKey: ["service-metrics"],
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
  });

  // Total backups across the three services; the per-tab query reuses the same
  // cache key, so this is one fetch per engine.
  const mariadbBackups = useQuery({
    queryKey: ["backups", "mariadb"],
    queryFn: () => ipc.backupList("mariadb"),
  });
  const postgresBackups = useQuery({
    queryKey: ["backups", "postgresql"],
    queryFn: () => ipc.backupList("postgresql"),
  });
  const redisBackups = useQuery({
    queryKey: ["backups", "redis"],
    queryFn: () => ipc.backupList("redis"),
  });
  const backupLists = [mariadbBackups, postgresBackups, redisBackups];
  const backupCount = backupLists.reduce((total, list) => total + (list.data?.length ?? 0), 0);
  // A list that failed or has not answered is not "no backups": summing the
  // ones that did answer would print a false zero in the header (§121).
  const backupCountKnown = backupLists.every((list) => list.data !== undefined);

  const [selected, setSelected] = useState("");
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  // The chosen database is remembered with the engine it belongs to, so
  // filtering that engine away can never point the next query at a schema
  // that does not exist there.
  const [database, setDatabase] = useState<{ serviceId: string; name: string } | null>(
    null,
  );
  const [credentials, setCredentials] = useState<Credentials>(NO_CREDENTIALS);
  const [engineFilter, setEngineFilter] = useState<"all" | EngineKind>("all");
  const [stateFilter, setStateFilter] = useState<"all" | "running" | "stopped">("all");

  const allServers = servers.data ?? [];
  const stateOf = (server: DbServer): EngineState => {
    if (installed.isPending || metrics.isPending) {
      return "pending";
    }
    if (installed.isError || metrics.isError) {
      return "unknown";
    }
    if (installedVersionOf(installed.data, server.service_id) === undefined) {
      return null;
    }
    return metrics.data?.find((entry) => entry.id === server.service_id)?.state ?? "unknown";
  };

  const visibleServers = allServers.filter((server) => {
    if (engineFilter !== "all" && server.engine !== engineFilter) {
      return false;
    }
    if (stateFilter === "all") {
      return true;
    }
    const state = stateOf(server);
    const running = state === "running" || state === "starting";
    return stateFilter === "running" ? running : !running;
  });

  const chosen: DbServer | undefined =
    visibleServers.find((server) => server.service_id === selected) ?? visibleServers[0];

  // Credentials belong to one engine; the others are asked with the engines'
  // own defaults so a password typed for MariaDB never travels to Postgres.
  const credentialsFor = (serviceId: string): Credentials =>
    chosen?.service_id === serviceId ? credentials : NO_CREDENTIALS;

  // One listing per engine, shared by the card's count and the Databases tab
  // through the query key. Nothing is asked of an engine that is not
  // answering.
  const databaseLists = useQueries({
    queries: allServers.map((server) => {
      const params = connectionParams(server, credentialsFor(server.service_id), null);
      return {
        queryKey: databaseListKey(server.service_id, params.username),
        queryFn: () => ipc.dbListDatabases(params),
        enabled: server.reachable,
        retry: false,
      };
    }),
  });
  const countOf = (serviceId: string): number | undefined => {
    const index = allServers.findIndex((server) => server.service_id === serviceId);
    const list = index < 0 ? undefined : databaseLists[index];
    return list?.data === undefined ? undefined : list.data.rows.length;
  };
  /**
   * `isLoading` is false for an engine that was never asked (it is not
   * accepting connections), so that engine keeps reading "unknown" rather
   * than looking like a read in flight (§121).
   */
  const countPending = (serviceId: string): boolean => {
    const index = allServers.findIndex((server) => server.service_id === serviceId);
    return index >= 0 && (databaseLists[index]?.isLoading ?? false);
  };

  if (servers.isPending) {
    return (
      <div className="space-y-4 p-5" role="status">
        <span className="sr-only">Detecting database servers…</span>
        <div aria-hidden className="space-y-2 border-b border-border pb-4">
          <span className="block h-6 w-72 animate-pulse rounded-sm bg-secondary" />
          <span className="block h-4 w-96 animate-pulse rounded-sm bg-secondary" />
        </div>
        <div aria-hidden className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <span key={card} className="block h-36 animate-pulse rounded-lg bg-secondary" />
          ))}
        </div>
      </div>
    );
  }

  if (servers.isError) {
    return (
      <div className="space-y-4 p-5">
        <Callout variant="destructive" title="Could not read the database servers.">
          <p>{servers.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void servers.refetch()}
          >
            Try again
          </Button>
        </Callout>
      </div>
    );
  }

  if (allServers.length === 0) {
    return (
      <div className="space-y-4 p-5">
        <EmptyState
          icon={<Database />}
          title="No database servers registered yet."
          description="Install MariaDB, PostgreSQL or Redis from the Components page."
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
    );
  }

  const reachable = allServers.filter((server) => server.reachable).length;

  const activeFilters: ActiveFilter[] = [];
  if (engineFilter !== "all") {
    activeFilters.push({
      id: "engine",
      label: "Engine",
      value: engineLabel(engineFilter),
      onClear: () => setEngineFilter("all"),
    });
  }
  if (stateFilter !== "all") {
    activeFilters.push({
      id: "state",
      label: "State",
      value: stateFilter === "running" ? "Running" : "Not running",
      onClear: () => setStateFilter("all"),
    });
  }

  const clearFilters = () => {
    setEngineFilter("all");
    setStateFilter("all");
  };

  const selectServer = (serviceId: string, nextTab: TabId) => {
    if (serviceId !== chosen?.service_id) {
      // Credentials and the chosen schema belong to one engine; carrying them
      // across would send the wrong password to the next one and query a
      // database that is not there.
      setCredentials(NO_CREDENTIALS);
      setDatabase(null);
    }
    setSelected(serviceId);
    setTab(nextTab);
  };

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          reachable === 0
            ? "No database engines are running."
            : `${reachable} of ${allServers.length} engines reachable.`
        }
        description={`${
          backupCountKnown
            ? `${backupCount} backup${backupCount === 1 ? "" : "s"} across all services`
            : "Backup counts unavailable"
        } · the query browser never writes.`}
      >
        {allServers.length > 1 ? (
          <FilterBar active={activeFilters} onClear={clearFilters}>
            <Select
              aria-label="Engine"
              className="h-8 w-40 text-xs"
              value={engineFilter}
              onChange={(event) => setEngineFilter(event.target.value as "all" | EngineKind)}
            >
              <option value="all">All engines</option>
              {(["maria_db", "postgre_sql", "redis"] as const).map((engine) => (
                <option key={engine} value={engine}>
                  {engineLabel(engine)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="State"
              className="h-8 w-40 text-xs"
              value={stateFilter}
              onChange={(event) =>
                setStateFilter(event.target.value as "all" | "running" | "stopped")
              }
            >
              <option value="all">Any state</option>
              <option value="running">Running</option>
              <option value="stopped">Not running</option>
            </Select>
          </FilterBar>
        ) : null}
      </PageHeader>

      {visibleServers.length === 0 ? (
        /* The reset control is the filter row's own: a second "Clear
           filters" here would be the same button twice on one screen. */
        <EmptyState
          icon={<Database />}
          title="No engine matches these filters."
          description={`${allServers.length} engines are registered and none of them match the current filters.`}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleServers.map((server) => (
            <DatabaseCard
              key={server.service_id}
              server={server}
              version={installedVersionOf(installed.data, server.service_id)?.version}
              state={stateOf(server)}
              databaseCount={countOf(server.service_id)}
              databaseCountPending={countPending(server.service_id)}
              selected={server.service_id === chosen?.service_id}
              active={activeClientId === server.service_id}
              // Picking another card changes which engine the detail is
              // about; it does not throw away the surface the user is on.
              onSelect={() => {
                selectServer(server.service_id, tab);
              }}
              onOpenClient={() => {
                setActiveClientId(server.service_id);
                selectServer(
                  server.service_id,
                  server.engine === "redis" ? "databases" : "query",
                );
              }}
              onOpenTab={(nextTab) => {
                setActiveClientId(server.service_id);
                selectServer(server.service_id, nextTab);
              }}
            />
          ))}
        </div>
      )}

      {chosen ? (
        <DatabaseDetail
          key={chosen.service_id}
          server={chosen}
          state={stateOf(chosen)}
          credentials={credentials}
          onCredentials={setCredentials}
          version={installedVersionOf(installed.data, chosen.service_id)?.version}
          databaseCount={countOf(chosen.service_id)}
          database={
            database !== null && database.serviceId === chosen.service_id
              ? database.name
              : ""
          }
          onDatabase={(name) => setDatabase({ serviceId: chosen.service_id, name })}
          tab={tab}
          onTab={setTab}
        />
      ) : null}
    </div>
  );
}

/** Query key for one engine's database listing, scoped to the credentials used. */
function databaseListKey(serviceId: string, username: string | null) {
  return ["db-databases", serviceId, username] as const;
}

/** The connection a request against one engine uses. */
function connectionParams(
  server: DbServer,
  credentials: Credentials,
  database: string | null,
): ConnectionParams {
  return {
    engine: server.engine,
    host: server.host,
    port: server.port,
    username: credentials.username.trim() || null,
    password: credentials.password || null,
    database,
  };
}

/** The installed version of the component backing one engine, when present. */
function installedVersionOf(
  entries: InstalledVersion[] | undefined,
  serviceId: string,
): InstalledVersion | undefined {
  return (entries ?? [])
    .filter((entry) => entry.component_id === serviceId)
    .sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    )[0];
}

/**
 * One connectable engine as a §25 card. §91: the action a database card is
 * mostly for, opening the client, stays on the card; starting, stopping and
 * jumping to the detail's other surfaces sit one click away behind §62's
 * overflow.
 */
function DatabaseCard({
  server,
  version,
  state,
  databaseCount,
  databaseCountPending,
  selected,
  active = false,
  onSelect,
  onOpenClient,
  onOpenTab,
}: {
  server: DbServer;
  version: string | undefined;
  state: EngineState;
  databaseCount: number | undefined;
  databaseCountPending: boolean;
  selected: boolean;
  active?: boolean;
  onSelect: () => void;
  onOpenClient: () => void;
  onOpenTab: (tab: TabId) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const serviceId = server.service_id;
  const label = engineLabel(server.engine);
  const running = state === "running" || state === "starting";

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["db-servers"] });
  };

  const start = useMutation({
    mutationFn: () => ipc.serviceStart(serviceId, version!),
    onSuccess: () => toast.success(`${label} started`),
    onError: (error: Error) =>
      toast.error(`Could not start ${label}`, { details: error.message }),
    onSettled: refresh,
  });
  const stop = useMutation({
    mutationFn: () => ipc.serviceStop(serviceId),
    onSuccess: () => toast.success(`${label} stopped`),
    onError: (error: Error) =>
      toast.error(`Could not stop ${label}`, { details: error.message }),
    onSettled: refresh,
  });

  const busy = start.isPending || stop.isPending;
  const actions: MenuItem[] = [
    {
      id: "start",
      label: `Start ${label}`,
      icon: Play,
      // No installed version means there is no binary to start.
      disabled: version === undefined || running || busy,
      onSelect: () => start.mutate(),
    },
    {
      id: "stop",
      label: `Stop ${label}`,
      icon: Square,
      disabled: !running || busy,
      onSelect: () => stop.mutate(),
    },
    {
      id: "databases",
      label: "Browse data",
      icon: Table2,
      onSelect: () => onOpenTab("databases"),
    },
    { id: "backups", label: "Backups", icon: Save, onSelect: () => onOpenTab("backups") },
    { id: "logs", label: "Logs", icon: HardDrive, onSelect: () => onOpenTab("logs") },
  ];

  const failure = start.error instanceof Error ? start.error : stop.error;
  const menu = useContextMenu({
    label: `Actions for ${label}`,
    items: actions,
  });

  return (
    <Card
      role="group"
      aria-label={`${label} engine`}
      onContextMenu={menu.onContextMenu}
      // §123: the engine name below is a click target, so hovering the card it
      // sits in has to acknowledge that. The unselected case uses the same
      // hover recipe as the outline Button; the selected case already owns the
      // accent border and must not have it overwritten on hover.
      className={cn(
        "flex flex-col transition-colors duration-150",
        active
          ? "border-primary bg-primary-soft shadow-sm ring-1 ring-primary/20"
          : "hover:border-line-strong hover:bg-hover",
      )}
    >
      <CardHeader className="pb-1.5">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`Select ${label} on ${server.host}:${server.port}`}
            className="min-w-0 cursor-pointer text-left"
          >
            {/* Spans, not a heading: a button takes phrasing content only. */}
            <span className="text-h3 flex items-baseline gap-2 tracking-tight">
              <span className="data-value text-base">{label}</span>
              {version ? (
                <span className="data-value font-normal text-ink-muted">v{version}</span>
              ) : null}
            </span>
            <span className="data-value mt-1 block text-ink-muted">
              {server.host}:{server.port}
            </span>
          </button>
          <OverflowMenu label={`Actions for ${label}`} items={actions} />
        </div>
        {/* A portal: it renders to the body, so the card's markup is unchanged. */}
        {menu.panel}
      </CardHeader>

      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {state === null ? (
            <Badge variant="outline">not installed</Badge>
          ) : state === "unknown" ? (
            <Badge variant="outline">state unknown</Badge>
          ) : state === "pending" ? (
            <span role="status" className="inline-block">
              <span className="sr-only">Checking state…</span>
              <span
                aria-hidden
                className="block h-5 w-16 animate-pulse rounded-sm bg-secondary"
              />
            </span>
          ) : (
            <StatusBadge state={state} />
          )}
          {databaseCountPending ? (
            <span role="status" className="inline-block">
              <span className="sr-only">Counting databases…</span>
              <span
                aria-hidden
                className="block h-4 w-24 animate-pulse rounded-sm bg-secondary"
              />
            </span>
          ) : (
            <span className="data-value text-ink-secondary">
              {databaseCount === undefined
                ? "database count unknown"
                : `${databaseCount} database${databaseCount === 1 ? "" : "s"}`}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* §119: reachability is its own fact, never folded into the process
              state above it. */}
          <span className="text-xs text-ink-muted">
            {server.reachable
              ? `accepting connections on :${server.port}`
              : `nothing listening on :${server.port}`}
          </span>
          <Button
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            onClick={onOpenClient}
          >
            Open client
          </Button>
        </div>

        {failure instanceof Error ? (
          <Callout
            variant="destructive"
            title={start.error ? `Could not start ${label}.` : `Could not stop ${label}.`}
          >
            <p>{failure.message}</p>
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * §26 detail. Query is absent for Redis: the backend browses Redis per key and
 * refuses SQL against it, so offering a statement console there would be a
 * control that can only ever error.
 */
function DatabaseDetail({
  server,
  state,
  version,
  credentials,
  onCredentials,
  databaseCount,
  database,
  onDatabase,
  tab,
  onTab,
}: {
  server: DbServer;
  state: EngineState;
  version: string | undefined;
  credentials: Credentials;
  onCredentials: (credentials: Credentials) => void;
  databaseCount: number | undefined;
  database: string;
  onDatabase: (database: string) => void;
  tab: TabId;
  onTab: (tab: TabId) => void;
}) {
  const label = engineLabel(server.engine);

  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    {
      id: "databases",
      label: `Databases${databaseCount === undefined ? "" : ` (${databaseCount})`}`,
    },
    ...(server.engine === "redis" ? [] : [{ id: "query" as const, label: "Query" }]),
    { id: "backups", label: "Backups" },
    { id: "logs", label: "Logs" },
  ];
  const active = tabs.some((entry) => entry.id === tab) ? tab : "overview";

  return (
    <section aria-label="Database detail" className="rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          {label}
          <span className="data-value font-normal text-ink-muted">
            {server.host}:{server.port}
          </span>
        </h2>
        {state === null ? (
          <Badge variant="outline">not installed</Badge>
        ) : state === "unknown" ? (
          <Badge variant="outline">state unknown</Badge>
        ) : state === "pending" ? (
          <span role="status" className="inline-block">
            <span className="sr-only">Checking state…</span>
            <span
              aria-hidden
              className="block h-5 w-16 animate-pulse rounded-sm bg-secondary"
            />
          </span>
        ) : (
          <StatusBadge state={state} />
        )}
      </header>

      {/* §64: 36–40px tabs, accent text with a bottom indicator. */}
      <div
        role="tablist"
        aria-label="Database sections"
        className="flex gap-1 border-b border-border px-2"
      >
        {tabs.map((entry) => (
          <button
            key={entry.id}
            id={`db-tab-${entry.id}`}
            role="tab"
            type="button"
            aria-selected={active === entry.id}
            aria-controls={`db-tabpanel-${entry.id}`}
            onClick={() => onTab(entry.id)}
            className={`relative h-9 cursor-pointer px-3 text-sm transition-colors duration-150 ${
              active === entry.id
                ? "font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`db-tabpanel-${active}`}
        aria-labelledby={`db-tab-${active}`}
        className="p-4"
      >
        {active === "overview" ? (
          <OverviewPanel
            server={server}
            state={state}
            version={version}
            credentials={credentials}
            onCredentials={onCredentials}
            databaseCount={databaseCount}
          />
        ) : null}
        {active === "databases" ? (
          <DatabaseExplorer
            server={server}
            credentials={credentials}
            database={database}
            onDatabase={onDatabase}
            onOpenQuery={server.engine === "redis" ? undefined : () => onTab("query")}
          />
        ) : null}
        {active === "query" ? (
          <QueryPanel
            server={server}
            credentials={credentials}
            database={database}
            onDatabase={onDatabase}
          />
        ) : null}
        {active === "backups" ? <BackupsPanel server={server} /> : null}
        {active === "logs" ? <LogsPanel server={server} state={state} /> : null}
      </div>
    </section>
  );
}

/**
 * What the backend knows about one connection: the endpoint, the version, the
 * two state facts, and the credentials the browse uses. §26/§78: the password
 * is masked until asked for, and an empty password means the engine's own
 * default (DevX services answer as `root`/`postgres` with none).
 */
function OverviewPanel({
  server,
  state,
  version,
  credentials,
  onCredentials,
  databaseCount,
}: {
  server: DbServer;
  state: EngineState;
  version: string | undefined;
  credentials: Credentials;
  onCredentials: (credentials: Credentials) => void;
  databaseCount: number | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const metrics = useQuery({
    queryKey: ["service-metrics"],
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
  });
  const metric: ServiceMetrics | undefined = metrics.data?.find(
    (entry) => entry.id === server.service_id,
  );
  // §121: a read still in flight and a read that failed are not the same fact
  // as a metric the backend simply does not report.
  const metricUnread = metrics.isPending
    ? "reading…"
    : metrics.isError
      ? "could not be read"
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground">Connection</h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Fact label="Engine" value={engineLabel(server.engine)} />
          <Fact
            label="Version"
            value={version ? `v${version}` : "not installed"}
            mono={version !== undefined}
          />
          <Fact label="Host" value={server.host} mono />
          <Fact label="Port" value={String(server.port)} mono />
          <Fact
            label="Databases"
            value={databaseCount === undefined ? "unknown" : String(databaseCount)}
            mono={databaseCount !== undefined}
          />
          <Fact
            label="Listening"
            value={server.reachable ? "accepting connections" : "nothing on this port"}
          />
        </dl>

        <h3 className="pt-2 text-xs font-semibold text-muted-foreground">Process</h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Fact
            label="State"
            value={
              state === null
                ? "no local binary"
                : state === "pending"
                  ? "reading…"
                  : state === "unknown"
                    ? "could not be read"
                    : state
            }
          />
          <Fact
            label="Memory"
            value={
              metricUnread ??
              (metric === undefined
                ? "unknown"
                : metric.memory_bytes === 0
                  ? "not running"
                  : formatBytes(metric.memory_bytes))
            }
            mono={metricUnread === null && metric !== undefined && metric.memory_bytes > 0}
          />
          <Fact
            label="Processes"
            value={metricUnread ?? (metric === undefined ? "unknown" : String(metric.processes))}
            mono={metricUnread === null && metric !== undefined}
          />
        </dl>
        <p className="text-xs text-ink-muted">
          Memory and process counts cover the service DevX supervises. There is
          no connection count: the backend does not sample one.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground">Credentials</h3>
        <p className="text-xs text-ink-muted">
          Used for every statement and listing on this page. Left empty, the
          engines DevX installs answer as <span className="font-mono">root</span>{" "}
          (MariaDB) or <span className="font-mono">postgres</span> with no
          password.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="db-username">User</Label>
          <Input
            id="db-username"
            className="font-mono text-xs"
            value={credentials.username}
            placeholder={server.engine === "postgre_sql" ? "postgres" : "root"}
            onChange={(event) =>
              onCredentials({ ...credentials, username: event.target.value })
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="db-password">Password</Label>
          <div className="flex items-center gap-2">
            <Input
              id="db-password"
              className="font-mono text-xs"
              type={revealed ? "text" : "password"}
              value={credentials.password}
              placeholder="no password"
              onChange={(event) =>
                onCredentials({ ...credentials, password: event.target.value })
              }
              autoComplete="off"
              spellCheck={false}
            />
            {/* §26: `[••••••••••] [Show]`. Masked is the default, and never a
                setting the user has to go and find. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={revealed}
              aria-label={`${revealed ? "Hide" : "Show"} password`}
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? <EyeOff /> : <Eye />}
              {revealed ? "Hide" : "Show"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-ink-muted">
          Held in memory for this window only; nothing is written to
          <span className="font-mono"> config.toml</span>.
        </p>
      </section>
    </div>
  );
}

/** Label/value pair for a definition list. */
function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn("truncate", mono && "data-value")} data-selectable title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * §60: the database list as a table. Sticky header, hover rows, the selected
 * row on the accent-soft surface, the action that matters in the right
 * column. The table list follows whatever that selection is.
 */
function DatabaseExplorer({
  server,
  credentials,
  database,
  onDatabase,
  onOpenQuery,
}: {
  server: DbServer;
  credentials: Credentials;
  database: string;
  onDatabase: (database: string) => void;
  onOpenQuery?: () => void;
}) {
  const listingParams = connectionParams(server, credentials, null);
  const databases = useQuery({
    queryKey: databaseListKey(server.service_id, listingParams.username),
    queryFn: () => ipc.dbListDatabases(listingParams),
    enabled: server.reachable,
    retry: false,
  });

  const tables = useQuery({
    queryKey: ["db-tables", server.service_id, database],
    queryFn: () => ipc.dbListTables({ ...listingParams, database }),
    enabled: database !== "",
    retry: false,
  });

  const names = (databases.data?.rows ?? []).map((row) => cellText(row[0]));

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="db-database">Database</Label>
        <p className="sr-only" id="db-database-hint">
          Selects which database the table list reads from.
        </p>
        <Select
          id="db-database"
          className="w-72"
          aria-describedby="db-database-hint"
          value={database}
          onChange={(event) => onDatabase(event.target.value)}
        >
          <option value="">—</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </div>

      {databases.isPending ? (
        <div className="space-y-2" role="status">
          <span className="sr-only">Listing databases…</span>
          {[0, 1, 2].map((row) => (
            <span
              key={row}
              aria-hidden
              className="block h-4 animate-pulse rounded-sm bg-secondary"
            />
          ))}
        </div>
      ) : databases.isError ? (
        <Callout variant="destructive" title="Could not read the database list.">
          <p>{databases.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void databases.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : names.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title={
            server.reachable
              ? "This server reported no databases."
              : "This engine is not reachable."
          }
          description={
            server.reachable ? undefined : "Nothing can be listed until it accepts connections."
          }
        />
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded-sm border border-border">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {server.engine === "redis" ? "Key space" : "Database"}
                </th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => (
                <tr
                  key={name}
                  className={cn(
                    "border-t border-border transition-colors duration-150",
                    name === database ? "bg-primary-soft" : "hover:bg-hover",
                  )}
                >
                  <td className="px-3 py-1.5 font-mono text-xs" data-selectable>
                    {name}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onDatabase(name);
                        onOpenQuery?.();
                      }}
                    >
                      {onOpenQuery ? "Query" : "Use"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Table2 className="size-3.5" aria-hidden />
          Tables{database ? ` in ${database}` : ""}
        </p>
        {database === "" ? (
          <EmptyState
            icon={<Table2 />}
            title="Pick a database to list its tables."
            description="Choose one from the list above and its tables appear here."
          />
        ) : tables.isPending ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">Loading tables…</span>
            {[0, 1].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-4 animate-pulse rounded-sm bg-secondary"
              />
            ))}
          </div>
        ) : tables.isError ? (
          <Callout variant="destructive" title="Could not read the table list.">
            <p>{tables.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void tables.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : (tables.data?.rows ?? []).length === 0 ? (
          <EmptyState
            icon={<Table2 />}
            title="No tables found."
            description="This database exists but holds no tables yet."
          />
        ) : (
          <ul className="space-y-0.5">
            {(tables.data?.rows ?? []).map((row) => {
              const name = cellText(row[0]);
              return (
                <li
                  key={name}
                  className="truncate font-mono text-xs"
                  data-selectable
                  title={name}
                >
                  {name}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The query console: one statement, its grid, and the import / export actions
 * that operate on the selected engine. The backend refuses anything that is
 * not a read, so there is no write path to offer here.
 */
function QueryPanel({
  server,
  credentials,
  database,
  onDatabase,
}: {
  server: DbServer;
  credentials: Credentials;
  database: string;
  onDatabase: (database: string) => void;
}) {
  const [statement, setStatement] = useState("");
  const [importPath, setImportPath] = useState<string | null>(null);
  const toast = useToast();

  const baseParams = connectionParams(server, credentials, null);
  const params = connectionParams(server, credentials, database === "" ? null : database);

  const databases = useQuery({
    queryKey: databaseListKey(server.service_id, baseParams.username),
    queryFn: () => ipc.dbListDatabases(baseParams),
    enabled: server.reachable,
    retry: false,
  });

  const run = useMutation({ mutationFn: () => ipc.dbQuery(params, statement) });
  // The dump is chosen first and applied on confirmation: importing overwrites
  // whatever tables the file names, and the file picker alone does not say so.
  const importSql = useMutation({
    mutationFn: (path: string) => ipc.dbImportSql(server.service_id, path),
    onSuccess: (_result, path) => toast.success("SQL dump imported", { description: path }),
  });
  const exportCsv = useMutation({
    mutationFn: async () => {
      const path = await pickCsvSavePath("query-result.csv");
      // Cancelled dialog: nothing was written, so there is nothing to report.
      if (!path) {
        return null;
      }
      const rows = await ipc.dbExportCsv(params, statement, path);
      return { path, rows };
    },
    onSuccess: (written) => {
      if (written) {
        toast.success("CSV exported", {
          description: `${written.rows} row${written.rows === 1 ? "" : "s"} written to ${written.path}`,
        });
      }
    },
  });

  const chooseImport = async () => {
    const path = await pickSqlFile();
    if (path) {
      setImportPath(path);
    }
  };

  const busy = run.isPending;
  const error =
    run.error instanceof Error
      ? run.error
      : importSql.error instanceof Error
        ? importSql.error
        : exportCsv.error instanceof Error
          ? exportCsv.error
          : null;
  const errorTitle = run.error
    ? "The statement failed."
    : importSql.error
      ? "Could not import the SQL dump."
      : "Could not export the CSV.";

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="db-target">Database</Label>
          <Select
            id="db-target"
            className="w-48"
            value={database}
            onChange={(event) => onDatabase(event.target.value)}
          >
            <option value="">—</option>
            {(databases.data?.rows ?? []).map((row) => {
              const name = cellText(row[0]);
              return (
                <option key={name} value={name}>
                  {name}
                </option>
              );
            })}
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="db-statement">Statement</Label>
          <Input
            id="db-statement"
            placeholder="SELECT version()"
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || statement.trim() === ""}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={server.engine === "redis" || !server.reachable || importSql.isPending}
            onClick={() => void chooseImport()}
          >
            {importSql.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            Import .sql
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || statement.trim() === "" || exportCsv.isPending}
            onClick={() => exportCsv.mutate()}
          >
            {exportCsv.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Export CSV
          </Button>
        </div>
      </form>

      <p className="text-xs text-ink-muted">
        Read-only: the backend rejects anything that is not SELECT, SHOW,
        EXPLAIN, DESCRIBE, USE or ANALYZE.
      </p>

      {error ? (
        <Callout variant="destructive" title={errorTitle}>
          <p>{error.message}</p>
        </Callout>
      ) : null}

      <ResultGrid result={run.data} pending={run.isPending} />

      {/* §35: the dump replaces the tables it names, so say which engine and
          schema it lands in before running it. */}
      <ConfirmDialog
        open={importPath !== null}
        onClose={() => setImportPath(null)}
        onConfirm={() => {
          if (importPath) {
            importSql.mutate(importPath);
          }
          setImportPath(null);
        }}
        title={`Import this dump into ${engineLabel(server.engine)}?`}
        description={`${importPath ?? "The file"} is applied to ${server.service_id}${
          database === "" ? "" : `, database ${database}`
        }. Every table the dump names is replaced by its contents, and data written since the dump was taken cannot be recovered.`}
        confirmLabel="Import"
        destructive
      />
    </div>
  );
}

/**
 * Backups for one database server: SQL dumps for MariaDB/PostgreSQL, RDB
 * snapshots for Redis. The ten newest are kept; older ones are pruned.
 * Rendered as a dense table, not one bordered card per file.
 */
function BackupsPanel({ server }: { server: DbServer }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const serviceId = server.service_id;
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ["backups", serviceId],
    queryFn: () => ipc.backupList(serviceId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["backups", serviceId] });

  const create = useMutation({
    mutationFn: () => ipc.backupCreate(serviceId),
    onSuccess: (entry) => toast.success("Backup created", { description: entry.file_name }),
    onError: (error: Error) =>
      toast.error("Could not create the backup", { details: error.message }),
    onSettled: invalidate,
  });
  // Restore and delete report through their own toast — the panel shows no
  // second copy of the same failure — and hold their dialog open while the
  // request runs, so `pending` disables both buttons (§35).
  const restore = useMutation({
    mutationFn: (fileName: string) => ipc.backupRestore(serviceId, fileName),
    onSuccess: (_result, fileName) =>
      toast.success(`${serviceId} restored`, {
        description: `${fileName} is now the live data.`,
      }),
    onError: (error: Error) =>
      toast.error("Could not restore the backup", { details: error.message }),
    onSettled: () => {
      void invalidate();
      setRestoreTarget(null);
    },
  });
  const remove = useMutation({
    mutationFn: (fileName: string) => ipc.backupDelete(serviceId, fileName),
    onSuccess: (_result, fileName) =>
      toast.success("Backup deleted", { description: fileName }),
    onError: (error: Error) =>
      toast.error("Could not delete the backup", { details: error.message }),
    onSettled: () => {
      void invalidate();
      setDeleteTarget(null);
    },
  });

  const entries = backups.data ?? [];
  const empty = !backups.isPending && !backups.isError && entries.length === 0;
  const backupNow = (
    <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
      {create.isPending ? <Loader2 className="animate-spin" /> : <Save />}
      Back up now
    </Button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-xs text-muted-foreground">
          {server.engine === "redis"
            ? "Snapshots the keyspace with SAVE; restoring needs Redis stopped."
            : "Dumps all databases through the engine's own tool into plain SQL."}{" "}
          The ten newest are kept.
        </p>
        {/* §38: while the list is empty the same button moves into the empty
            state, so the action that fills it is stated once. */}
        {empty ? null : backupNow}
      </div>

      {backups.isPending ? (
        <div className="space-y-2" role="status">
          <span className="sr-only">Loading backups…</span>
          {[0, 1].map((row) => (
            <span
              key={row}
              aria-hidden
              className="block h-4 animate-pulse rounded-sm bg-secondary"
            />
          ))}
        </div>
      ) : backups.isError ? (
        <Callout variant="destructive" title="Could not read the backup list.">
          <p>{backups.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void backups.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Save />}
          title="No backups yet."
          description="Take one before schema experiments or upgrades."
          action={backupNow}
        />
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded-sm border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">File</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Taken</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.file_name}
                  className="border-t border-border transition-colors duration-150 hover:bg-hover"
                >
                  <td
                    className="max-w-72 truncate px-3 py-1.5 font-mono text-xs"
                    data-selectable
                    title={entry.file_name}
                  >
                    {entry.file_name}
                  </td>
                  <td className="hidden px-3 py-1.5 text-xs text-muted-foreground sm:table-cell">
                    {formatTimestamp(entry.created_unix)} · {formatSize(entry.size_bytes)}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={restore.isPending}
                        onClick={() => setRestoreTarget(entry.file_name)}
                      >
                        {restore.isPending && restore.variables === entry.file_name ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Undo2 />
                        )}
                        Restore
                      </Button>
                      <Tooltip label={`Delete ${entry.file_name}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={remove.isPending}
                          onClick={() => setDeleteTarget(entry.file_name)}
                          aria-label={`Delete ${entry.file_name}`}
                        >
                          {remove.isPending && remove.variables === entry.file_name ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Trash2 />
                          )}
                        </Button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* §35: the confirmation says what is lost, not "are you sure?". */}
      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (restoreTarget) {
            restore.mutate(restoreTarget);
          }
        }}
        title={`Restore ${serviceId} from this backup?`}
        description={`Every table in the running ${serviceId} is replaced by the contents of ${restoreTarget ?? "the backup"}. Data written since that backup was taken cannot be recovered.`}
        confirmLabel="Restore"
        destructive
        pending={restore.isPending}
      >
        {server.engine === "redis" ? (
          <p className="text-muted-foreground">
            Redis snapshots also need the service stopped before the file is accepted.
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget);
          }
        }}
        title="Delete this backup file?"
        description={`${deleteTarget ?? "The backup"} is removed from disk. It cannot be restored afterwards, and the ten-newest limit does not keep a copy.`}
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
      />
    </div>
  );
}

/**
 * The last lines the supervisor captured for this service. It reads while the
 * tab is mounted and only while Live is on: a closed tab is not a background
 * reader (§107).
 */
function LogsPanel({ server, state }: { server: DbServer; state: EngineState }) {
  const [live, setLive] = useState(true);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const next = await ipc.serviceLogs(server.service_id, cursor.current);
        if (cancelled) {
          return;
        }
        if (next.length > 0) {
          cursor.current = next[next.length - 1]!.seq;
          setEntries((current) => [...current, ...next].slice(-500));
        }
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      } finally {
        if (!cancelled) {
          setPending(false);
        }
      }
    };

    void read();
    if (!live) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => void read(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [server.service_id, live]);

  // §121: a state that could not be read is not the same fact as an engine
  // with no local binary.
  const summary =
    state === null
      ? "This engine has no local binary, so DevX supervises nothing for it."
      : state === "pending"
        ? "Reading this engine's state…"
        : state === "unknown"
          ? "DevX could not read this engine's version and state."
          : `${entries.length} most recent line${entries.length === 1 ? "" : "s"} from DevX's capture of the service output.`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{summary}</p>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Live
          <Switch
            checked={live}
            onCheckedChange={setLive}
            aria-label={`Toggle live log polling for ${server.service_id}`}
          />
        </label>
      </div>

      {pending ? (
        <div className="space-y-2" role="status">
          <span className="sr-only">Reading the service log…</span>
          {[0, 1, 2].map((row) => (
            <span
              key={row}
              aria-hidden
              className="block h-4 animate-pulse rounded-sm bg-secondary"
            />
          ))}
        </div>
      ) : error !== null ? (
        /* No retry control: this reader is an interval, and it re-reads on its
           own while Live is on. */
        <Callout variant="destructive" title="Could not read the service log.">
          <p>{error.message}</p>
        </Callout>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<HardDrive />}
          title="Nothing logged yet."
          description="Start the engine and its output shows up here."
        />
      ) : (
        <div className="max-h-80 overflow-auto rounded-sm border border-border bg-surface-2 p-2">
          <pre className="data-value whitespace-pre-wrap text-ink-secondary" data-selectable>
            {entries.map((entry) => entry.text).join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

/** A result grid: columns on top, rows as text, header pinned while it scrolls. */
function ResultGrid({ result, pending }: { result?: DbResult; pending: boolean }) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" />
        Running…
      </p>
    );
  }
  if (!result) {
    return null;
  }
  if (result.columns.length === 0) {
    return (
      <EmptyState
        icon={<Table2 />}
        title="Statement executed; it returned no rows."
        description="The statement ran without error — it just produced no result set."
      />
    );
  }
  return (
    <div className="max-h-[32rem] overflow-auto rounded-sm border border-border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            {result.columns.map((column) => (
              <th
                key={column.name}
                className="border-b border-border px-3 py-2 text-left text-xs font-medium"
                data-selectable
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr
              key={index}
              className="border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-hover"
            >
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-1.5 font-mono text-xs" data-selectable>
                  {renderCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders one grid cell: NULL distinctly, everything else as text. */
function renderCell(cell: DbValue): string {
  // The unit variant serializes as the bare string "null"; the tagged
  // variants carry optional `?: never` siblings, so narrowing is by value.
  if (typeof cell === "string") {
    return "NULL";
  }
  if (cell.int !== undefined) {
    return String(cell.int);
  }
  if (cell.float !== undefined) {
    return String(cell.float);
  }
  if (cell.text !== undefined) {
    return cell.text;
  }
  return cell.other;
}

/** The text of a single-cell row (database/table listings). */
function cellText(cell: DbValue | undefined): string {
  return cell === undefined ? "" : renderCell(cell);
}

/** Formats Unix seconds as a local date-time string. */
function formatTimestamp(unixSeconds: number): string {
  if (unixSeconds === 0) {
    return "unknown time";
  }
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Formats a byte count for the backup list. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

/** Formats a byte count for the overview facts. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Human label for an engine discriminator. */
function engineLabel(engine: EngineKind): string {
  switch (engine) {
    case "maria_db":
      return "MariaDB";
    case "postgre_sql":
      return "PostgreSQL";
    case "redis":
      return "Redis";
  }
}
