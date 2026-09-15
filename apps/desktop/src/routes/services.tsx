import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  CalendarClock,
  CircleAlert,
  Loader2,
  Play,
  Plus,
  Puzzle,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-dot";
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
import { usePhpPools, useInstalledVersions, useServiceComponentIds } from "@/lib/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import {
  ipc,
  type InstalledVersion,
  type LogEntry,
  type PhpPoolStatus,
  type ServiceState,
  type WorkerStatus,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * Services page — a tabbed Real-Time Monitor (MASTER.md): Services, Workers
 * and Scheduled tasks share one page because they answer one question
 * ("what is running and how do I act on it"). Each monitor row keeps its
 * inline start/stop; ports, versions and commands render in the data face.
 */
export function ServicesPage() {
  const installed = useInstalledVersions();
  // Which installed components DevX knows how to supervise comes from the
  // backend, so the two never drift.
  const serviceIds = useServiceComponentIds();
  const phpPools = usePhpPools();
  const [tab, setTab] = useState<"services" | "workers" | "scheduler">("services");

  const pending = installed.isPending || phpPools.isPending || serviceIds.isPending;
  const supervisable = new Set(serviceIds.data ?? []);
  const startable = (installed.data ?? []).filter((entry) =>
    supervisable.has(entry.component_id),
  );
  const empty = startable.length === 0 && (phpPools.data ?? []).length === 0;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title="Services"
        description="Supervised background services, PHP pools, workers and scheduled tasks."
      />

      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading installed components…
        </p>
      ) : empty ? (
        <EmptyState
          title="No supervisable service is installed yet."
          description="Install Mailpit or PHP from the Components page to start one here."
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
            <div className="space-y-3">
              {(phpPools.data ?? []).map((pool) => (
                <PhpPoolCard key={pool.id} pool={pool} />
              ))}
              {startable.map((entry) => (
                <ServiceCard key={entry.component_id} installed={entry} />
              ))}
            </div>
          ) : null}

          {tab === "workers" ? (
            <WorkersSection phpVersions={(phpPools.data ?? []).map((pool) => pool.version)} />
          ) : null}

          {tab === "scheduler" ? (
            <SchedulerSection phpVersions={(phpPools.data ?? []).map((pool) => pool.version)} />
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
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label="Sections" className="flex gap-1 border-b border-border">
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

/** One PHP FastCGI pool: start, stop, and its FastCGI endpoint. */
function PhpPoolCard({
  pool,
}: {
  pool: PhpPoolStatus;
}) {
  const queryClient = useQueryClient();
  const [showExtensions, setShowExtensions] = useState(false);
  const [showXdebug, setShowXdebug] = useState(false);

  // The pool may have been started from elsewhere; poll to keep the badge live.
  const status = useQuery({
    queryKey: ["php-pool-status", pool.version],
    queryFn: () => ipc.phpPoolStatus(pool.version),
    initialData: pool,
    refetchInterval: 1500,
  });

  const state: ServiceState = status.data?.state ?? "stopped";
  const running = state === "running" || state === "starting";

  const start = useMutation({
    mutationFn: () => ipc.phpPoolStart(pool.version, pool.workers),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["php-pool-status", pool.version] }),
  });
  const stop = useMutation({
    mutationFn: () => ipc.phpPoolStop(pool.version),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["php-pool-status", pool.version] }),
  });

  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <span className="data-value text-base">PHP {pool.version}</span>
              <StatusBadge state={state} />
            </CardTitle>
            <CardDescription className="data-value">
              fastcgi · {pool.workers} workers · 127.0.0.1:{status.data?.port ?? pool.port}
            </CardDescription>
          </div>
          <StartStopButton
            running={running}
            busy={busy}
            onStart={() => start.mutate()}
            onStop={() => stop.mutate()}
            startPending={start.isPending}
            stopPending={stop.isPending}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowExtensions((open) => !open)}
          >
            <Puzzle />
            {showExtensions ? "Hide extensions" : "Extensions"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowXdebug((open) => !open)}
          >
            <Bug />
            {showXdebug ? "Hide Xdebug" : "Xdebug"}
          </Button>
        </div>
        {showXdebug ? <XdebugPanel version={pool.version} /> : null}
        {showExtensions ? <ExtensionsPanel version={pool.version} /> : null}
        <LogTail id={pool.id} active={running} />
      </CardContent>
    </Card>
  );
}

/** Shared inline start/stop control with its loading state. */
function StartStopButton({
  running,
  busy,
  onStart,
  onStop,
  startPending,
  stopPending,
}: {
  running: boolean;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  startPending: boolean;
  stopPending: boolean;
}) {
  if (running) {
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={onStop}>
        {stopPending ? <Loader2 className="animate-spin" /> : <Square />}
        Stop
      </Button>
    );
  }
  return (
    <Button size="sm" disabled={busy} onClick={onStart}>
      {startPending ? <Loader2 className="animate-spin" /> : <Play />}
      Start
    </Button>
  );
}

/**
 * Xdebug controls for one PHP version: a master switch plus mode and IDE
 * port fields. Enabling requires the installed PHP to ship xdebug; the
 * backend validates that and the pool restarts on change.
 */
function XdebugPanel({ version }: { version: string }) {
  const queryClient = useQueryClient();

  const info = useQuery({
    queryKey: ["php-xdebug", version],
    queryFn: () => ipc.phpXdebugGet(version),
  });

  const set = useMutation({
    mutationFn: ({
      enabled,
      mode,
      clientPort,
    }: {
      enabled: boolean;
      mode: string;
      clientPort: number;
    }) => ipc.phpXdebugSet(version, enabled, mode, clientPort),
    onSuccess: (updated) => {
      queryClient.setQueryData(["php-xdebug", version], updated);
      // The pool's ini changed; its live status card re-renders on poll.
    },
  });

  if (info.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" />
        Loading Xdebug settings…
      </p>
    );
  }
  if (info.isError) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <CircleAlert className="size-4" />
        {info.error.message}
      </p>
    );
  }

  const current = info.data;
  const [mode, setMode] = useState(current.mode || "debug");
  const [port, setPort] = useState(current.client_port ? String(current.client_port) : "9003");

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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {set.error.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Lists the extensions the installed PHP version ships, with a switch per
 * extension. Changing one re-renders the pool's ini and restarts the pool,
 * which the backend does as part of `php_ext_set`.
 */
function ExtensionsPanel({ version }: { version: string }) {
  const queryClient = useQueryClient();

  const info = useQuery({
    queryKey: ["php-ext", version],
    queryFn: () => ipc.phpExtList(version),
  });

  const setExtension = useMutation({
    mutationFn: ({ extension, enabled }: { extension: string; enabled: boolean }) =>
      ipc.phpExtSet(version, extension, enabled),
    onSuccess: (updated) => {
      queryClient.setQueryData(["php-ext", version], updated);
    },
  });

  if (info.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" />
        Loading extensions…
      </p>
    );
  }
  if (info.isError) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <CircleAlert className="size-4" />
        {info.error.message}
      </p>
    );
  }
  if (info.data.installed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This PHP build ships no extensions in its <code>ext/</code> directory.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Enabling or disabling an extension re-renders this pool's php.ini and
        restarts the pool.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {info.data.installed.map((extension) => {
          const enabled = info.data.enabled.includes(extension);
          return (
            <label
              key={extension}
              className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-1.5 text-sm"
            >
              <span className="data-value min-w-0 truncate" data-selectable>
                {extension}
              </span>
              <Switch
                checked={enabled}
                disabled={setExtension.isPending}
                onCheckedChange={(checked) =>
                  setExtension.mutate({ extension, enabled: checked })
                }
                aria-label={`${enabled ? "Disable" : "Enable"} ${extension}`}
              />
            </label>
          );
        })}
      </div>
      {setExtension.error instanceof Error ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {setExtension.error.message}
        </p>
      ) : null}
    </div>
  );
}

function ServiceCard({
  installed,
}: {
  installed: InstalledVersion;
}) {
  const queryClient = useQueryClient();
  const id = installed.component_id;

  const status = useQuery({
    queryKey: ["service-status", id],
    queryFn: () => ipc.serviceStatus(id).catch(() => ({ id, state: "stopped" as const })),
    refetchInterval: 1500,
  });

  const state: ServiceState = status.data?.state ?? "stopped";
  const running = state === "running" || state === "starting";

  const start = useMutation({
    mutationFn: () => ipc.serviceStart(id, installed.version),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["service-status", id] }),
  });
  const stop = useMutation({
    mutationFn: () => ipc.serviceStop(id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["service-status", id] }),
  });

  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <span className="data-value text-base">{id}</span>
              <StatusBadge state={state} />
            </CardTitle>
            <CardDescription className="data-value">v{installed.version}</CardDescription>
          </div>
          <StartStopButton
            running={running}
            busy={busy}
            onStart={() => start.mutate()}
            onStop={() => stop.mutate()}
            startPending={start.isPending}
            stopPending={stop.isPending}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}
        <LogTail id={id} active={running} />
      </CardContent>
    </Card>
  );
}

/** Queue Workers: user-configured supervised processes, started in bulk. */
function WorkersSection({ phpVersions }: { phpVersions: string[] }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const workers = useQuery({
    queryKey: ["worker-list"],
    queryFn: ipc.workerList,
  });

  const remove = useMutation({
    mutationFn: ipc.workerRemove,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["worker-list"] }),
  });

  const configured = workers.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">Queue workers</CardTitle>
            <CardDescription>
              Long-running commands supervised like any other service — each
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
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading workers…
          </p>
        ) : configured.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workers configured. Add one to run e.g.{""}
            <code> php artisan queue:work </code> under DevX's supervisor.
          </p>
        ) : (
          <ul className="space-y-2">
            {configured.map((worker) => (
              <li key={worker.name}>
                <WorkerCard worker={worker} onRemove={() => remove.mutate(worker.name)} />
              </li>
            ))}
          </ul>
        )}
        {remove.error instanceof Error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {remove.error.message}
          </p>
        ) : null}
      </CardContent>
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

  const start = useMutation({
    mutationFn: () => ipc.workerStart(worker.name),
    onSuccess: (updated) =>
      queryClient.setQueryData(["worker-list"], (current: WorkerStatus[] | undefined) =>
        current?.map((w) => (w.name === updated[0]?.name ? updated[0] : w)) ?? current,
      ),
  });
  const stop = useMutation({
    mutationFn: () => ipc.workerStop(worker.name),
    onSuccess: (updated) =>
      queryClient.setQueryData(["worker-list"], (current: WorkerStatus[] | undefined) =>
        current?.map((w) => (w.name === updated[0]?.name ? updated[0] : w)) ?? current,
      ),
  });

  const runningCount = worker.live.filter((entry) => entry.state === "running").length;
  const anyActive = worker.live.some((entry) => entry.state !== "stopped");
  const label = worker.php_version
    ? `php ${worker.php_version}`
    : (worker.program ?? "");

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
        <p className="data-value truncate text-muted-foreground" data-selectable>
          {label} {worker.args.join(" ")} · {worker.working_dir}
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
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${worker.name}`}>
          <Trash2 />
        </Button>
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
        onDone();
      }
    },
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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {add.error.message}
        </p>
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

/** Polls the service log and renders a scrolling tail. */
function LogTail({ id, active }: { id: string; active: boolean }) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const afterRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await ipc.serviceLogs(id, afterRef.current);
        if (cancelled || next.length === 0) {
          return;
        }
        afterRef.current = next[next.length - 1]!.seq;
        setLines((current) => [...current, ...next].slice(-500));
      } catch {
        // A transient failure just skips this tick.
      }
    };

    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, active]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  if (!active && lines.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="max-h-48 overflow-y-auto rounded-sm border border-border bg-background/60 p-2"
      data-selectable
    >
      {lines.length === 0 ? (
        <p className="data-value text-muted-foreground">Waiting for output…</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.seq}
            className={cn(
              "data-value",
              line.stream === "stderr" ? "text-destructive" : "text-foreground",
            )}
          >
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}

/** Scheduled tasks: Windows tasks DevX creates from `[[cron]]` config. */
function SchedulerSection({ phpVersions }: { phpVersions: string[] }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const cron = useQuery({
    queryKey: ["cron-list"],
    queryFn: ipc.cronList,
  });

  const remove = useMutation({
    mutationFn: ipc.cronDelete,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["cron-list"] }),
  });

  const configured = cron.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">Scheduled tasks</CardTitle>
            <CardDescription>
              Windows scheduled tasks DevX creates for you — e.g.{""}
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
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading scheduled tasks…
          </p>
        ) : configured.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scheduled tasks. Add one to run a command on an interval; the
            task lives in Windows Task Scheduler under the DevX prefix.
          </p>
        ) : (
          <ul className="space-y-2">
            {configured.map((job) => (
              <li
                key={job.name}
                className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                    <span className="data-value text-sm text-foreground">{job.name}</span>
                    <Badge variant={job.registered ? "success" : "outline"}>
                      {job.registered ? "every " + job.every_minutes + " min" : "missing in Windows"}
                    </Badge>
                  </p>
                  <p className="data-value truncate text-muted-foreground" data-selectable>
                    {(job.php_version ? `php ${job.php_version}` : (job.program ?? "")) +
                      " " +
                      job.args.join(" ") +
                      " · " +
                      job.working_dir}
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
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(job.name)}
                  aria-label={`Delete ${job.name}`}
                >
                  {remove.isPending && remove.variables === job.name ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {remove.error instanceof Error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {remove.error.message}
          </p>
        ) : null}
      </CardContent>
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
        onDone();
      }
    },
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
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {add.error.message}
        </p>
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
