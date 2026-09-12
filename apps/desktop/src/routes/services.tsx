import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
import { Switch } from "@/components/ui/switch";
import {
  ipc,
  type InstalledVersion,
  type LogEntry,
  type PhpPoolStatus,
  type ServiceMetrics,
  type ServiceState,
  type WorkerStatus,
} from "@/lib/ipc";

const STATE_BADGE: Record<
  ServiceState,
  { label: string; variant: "success" | "warning" | "destructive" | "outline" | "secondary" }
> = {
  running: { label: "Running", variant: "success" },
  starting: { label: "Starting", variant: "warning" },
  stopping: { label: "Stopping", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  stopped: { label: "Stopped", variant: "outline" },
};

/**
 * Shared live metrics for every supervised service.
 *
 * One page-level query backs all cards; state-change events also invalidate
 * it, so a badge never lags a crash.
 */
function useMetrics() {
  return useQuery({
    queryKey: ["service-metrics"],
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
}

/** Compact CPU and memory readout for one service. */
function MetricBadges({
  metrics,
  id,
}: {
  metrics: ServiceMetrics[] | undefined;
  id: string;
}) {
  const entry = metrics?.find((m) => m.id === id);
  if (!entry || entry.state !== "running" || entry.memory_bytes === 0) {
    return null;
  }
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {(entry.cpu_percent ?? 0).toFixed(0)}% CPU · {formatBytes(entry.memory_bytes)}
    </span>
  );
}

/** Formats a byte count for a badge. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Services page: start, stop and tail supervised background services. */
export function ServicesPage() {
  const installed = useQuery({
    queryKey: ["installed-versions"],
    queryFn: ipc.installedVersions,
  });
  // Which installed components DevX knows how to supervise comes from the
  // backend, so the two never drift.
  const serviceIds = useQuery({
    queryKey: ["service-component-ids"],
    queryFn: ipc.serviceComponentIds,
    staleTime: Infinity,
  });
  // One FastCGI pool per installed PHP version, planned by the backend.
  const phpPools = useQuery({
    queryKey: ["php-pools"],
    queryFn: ipc.phpPoolList,
  });
  // Live CPU/RAM for every supervised process, shared by all cards below.
  const metrics = useMetrics();

  const supervisable = new Set(serviceIds.data ?? []);
  const startable = (installed.data ?? []).filter((entry) =>
    supervisable.has(entry.component_id),
  );

  const pending = installed.isPending || serviceIds.isPending || phpPools.isPending;
  const empty =
    startable.length === 0 && (phpPools.data ?? []).length === 0;

  return (
    <>
      <PageHeader
        title="Services"
        description="Background services supervised by DevX. Start, stop and watch their output."
      />

      <div className="space-y-4 p-6">
        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading installed components…
          </p>
        ) : empty ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No supervisable service is installed yet. Install Mailpit or PHP
            from the Components page to start one here.
          </div>
        ) : (
          <>
            {(phpPools.data ?? []).map((pool) => (
              <PhpPoolCard key={pool.id} pool={pool} metrics={metrics.data} />
            ))}
            {startable.map((entry) => (
              <ServiceCard key={entry.component_id} installed={entry} metrics={metrics.data} />
            ))}
          </>
        )}

        <WorkersSection phpVersions={(phpPools.data ?? []).map((pool) => pool.version)} />
        <SchedulerSection phpVersions={(phpPools.data ?? []).map((pool) => pool.version)} />
      </div>
    </>
  );
}

/** One PHP FastCGI pool: start, stop, and its FastCGI endpoint. */
function PhpPoolCard({
  pool,
  metrics,
}: {
  pool: PhpPoolStatus;
  metrics: ServiceMetrics[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [showExtensions, setShowExtensions] = useState(false);

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

  const badge = STATE_BADGE[state];
  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              PHP {pool.version}
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <MetricBadges metrics={metrics} id={pool.id} />
            </CardTitle>
            <CardDescription>
              FastCGI pool · {pool.workers} workers · 127.0.0.1:{status.data?.port ?? pool.port}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => start.mutate()}
              >
                {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                Start
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowExtensions((open) => !open)}
          >
            <Puzzle />
            {showExtensions ? "Hide extensions" : "Extensions"}
          </Button>
        </div>
        {showExtensions ? <ExtensionsPanel version={pool.version} /> : null}
        <LogTail id={pool.id} active={running} />
      </CardContent>
    </Card>
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
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate font-mono text-xs" data-selectable>
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
  metrics,
}: {
  installed: InstalledVersion;
  metrics: ServiceMetrics[] | undefined;
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

  const badge = STATE_BADGE[state];
  const busy = start.isPending || stop.isPending;
  const error =
    start.error instanceof Error
      ? start.error
      : stop.error instanceof Error
        ? stop.error
        : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              {id}
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <MetricBadges metrics={metrics} id={id} />
            </CardTitle>
            <CardDescription>version {installed.version}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => start.mutate()}
              >
                {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                Start
              </Button>
            )}
          </div>
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
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Queue workers</CardTitle>
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
            No workers configured. Add one to run e.g.{" "}
            <code>php artisan queue:work</code> under DevX's supervisor.
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
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {worker.name}
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
        <p className="truncate font-mono text-xs text-muted-foreground" data-selectable>
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
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
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
      className="max-h-48 overflow-y-auto rounded-md border border-border bg-background/50 p-2 font-mono text-xs"
      data-selectable
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">Waiting for output…</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.seq}
            className={line.stream === "stderr" ? "text-destructive" : undefined}
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
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Scheduled tasks</CardTitle>
            <CardDescription>
              Windows scheduled tasks DevX creates for you — e.g.{" "}
              <code>php artisan schedule:run</code> every minute for a site.
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
                className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                    {job.name}
                    <Badge variant={job.registered ? "success" : "outline"}>
                      {job.registered ? "every " + job.every_minutes + " min" : "missing in Windows"}
                    </Badge>
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground" data-selectable>
                    {(job.php_version ? `php ${job.php_version}` : (job.program ?? "")) +
                      " " +
                      job.args.join(" ") +
                      " · " +
                      job.working_dir}
                  </p>
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
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
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
