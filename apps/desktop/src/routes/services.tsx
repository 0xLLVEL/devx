import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, Play, Square } from "lucide-react";
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
import {
  ipc,
  type InstalledVersion,
  type LogEntry,
  type PhpPoolStatus,
  type ServiceState,
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
              <PhpPoolCard key={pool.id} pool={pool} />
            ))}
            {startable.map((entry) => (
              <ServiceCard key={entry.component_id} installed={entry} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** One PHP FastCGI pool: start, stop, and its FastCGI endpoint. */
function PhpPoolCard({ pool }: { pool: PhpPoolStatus }) {
  const queryClient = useQueryClient();

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
        <LogTail id={pool.id} active={running} />
      </CardContent>
    </Card>
  );
}

function ServiceCard({ installed }: { installed: InstalledVersion }) {
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
