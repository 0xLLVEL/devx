import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleAlert,
  Cpu,
  Gauge,
  Globe,
  Loader2,
  MemoryStick,
  Package,
  Server,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HeroBand as HeroBandShell } from "@/components/hero-band";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { StatTile } from "@/components/ui/stat-tile";
import { ipc, ipcEvents, type ServiceMetrics } from "@/lib/ipc";

/** Landing page: a live, at-a-glance view of the whole environment. */
export function DashboardPage() {
  const appInfo = useQuery({
    queryKey: ["app-info"],
    queryFn: ipc.appInfo,
  });
  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: ipc.siteList,
  });
  const metrics = useQuery({
    queryKey: ["service-metrics"],
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
  const ca = useQuery({ queryKey: ["ca"], queryFn: ipc.caStatus });
  const dns = useQuery({ queryKey: ["dns"], queryFn: ipc.dnsStatus });

  const entries = metrics.data ?? [];
  const running = entries.filter((m) => m.state === "running");
  const cpu = average(running.map((m) => m.cpu_percent ?? 0));
  const memory = running.reduce((sum, m) => sum + m.memory_bytes, 0);
  const cpuHistory = useRollingHistory(cpu, 40);
  const activity = useActivityFeed();

  const healthScore = computeHealthScore({
    totalServices: entries.length,
    runningServices: running.length,
    dnsRunning: dns.data?.running,
    caTrusted: dns.isPending || ca.isPending ? undefined : (ca.data?.trusted ?? false),
  });

  return (
    <>

      <div className="space-y-4 p-6">
        <HeroBand
          appInfo={appInfo.data}
          appInfoError={appInfo.error instanceof Error ? appInfo.error.message : null}
          totalServices={entries.length}
          runningServices={running.length}
          siteCount={sites.data?.length ?? 0}
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            icon={<Server className="size-4" />}
            label="Services"
            value={`${running.length}/${entries.length}`}
            sub={running.length === entries.length && entries.length > 0 ? "all running" : "running"}
            tone={running.length === entries.length && entries.length > 0 ? "success" : "neutral"}
          />
          <StatTile
            icon={<Cpu className="size-4" />}
            label="CPU"
            value={`${cpu.toFixed(0)}%`}
            sub="average across services"
            tone="neutral"
          >
            <Sparkline values={cpuHistory} />
          </StatTile>
          <StatTile
            icon={<MemoryStick className="size-4" />}
            label="Memory"
            value={formatBytes(memory)}
            sub="resident, all services"
            tone="neutral"
          />
          <StatTile
            icon={<Globe className="size-4" />}
            label="Sites"
            value={String(sites.data?.length ?? 0)}
            sub="local .test domains"
            tone="neutral"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <HealthCard score={healthScore} />
          <ServicesBoard entries={entries} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <SitesSnapshot sites={sites.data ?? []} />
            <ActivityCard entries={activity} />
          </div>
        </div>
      </div>
    </>
  );
}

/** The big greeting band: status headline, build identity, quick chips. */
function HeroBand({
  appInfo,
  appInfoError,
  totalServices,
  runningServices,
  siteCount,
}: {
  appInfo?: { version: string; target: string; debug: boolean };
  appInfoError: string | null;
  totalServices: number;
  runningServices: number;
  siteCount: number;
}) {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 5
      ? "Burning the midnight oil"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  const allGood = totalServices > 0 && runningServices === totalServices;

  return (
    <HeroBandShell
      title={
        totalServices === 0
          ? "Your environment is waiting."
          : allGood
            ? "Everything is running smoothly."
            : `${runningServices} of ${totalServices} services up.`
      }
      description={
        <>
          {greeting} —{" "}
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
          {" · "}
          {siteCount} site{siteCount === 1 ? "" : "s"} served locally
        </>
      }
      right={
        <>
          {appInfo ? (
            <div className="flex items-center gap-2">
              <Badge variant={appInfo.debug ? "warning" : "success"}>
                {appInfo.debug ? "debug" : "release"}
              </Badge>
              <span className="font-mono text-sm" data-selectable>
                v{appInfo.version}
              </span>
            </div>
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          {appInfo ? (
            <span className="font-mono text-xs text-muted-foreground" data-selectable>
              {appInfo.target}
            </span>
          ) : null}
          {appInfoError ? (
            <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <CircleAlert className="size-4" />
              {appInfoError}
            </p>
          ) : null}
        </>
      }
    />
  );
}

/** Environment health: a scored ring assembled from live signals. */
function HealthCard({ score }: { score: number | null }) {
  const tone =
    score === null
      ? "text-muted-foreground"
      : score >= 80
        ? "text-success"
        : score >= 50
          ? "text-warning"
          : "text-destructive";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4 text-muted-foreground" aria-hidden />
          Environment health
        </CardTitle>
        <CardDescription>Running services, DNS and CA trust</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        {score === null ? (
          <p className="text-sm text-muted-foreground">
            Nothing to score yet — start a service to bring the gauge to life.
          </p>
        ) : (
          <>
            <HealthRing score={score} tone={tone} />
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>≥ 80 looks healthy</li>
              <li>50–79 needs attention</li>
              <li>below 50: something is down</li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A donut ring showing the health percentage. */
function HealthRing({ score, tone }: { score: number; tone: string }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;

  return (
    <svg viewBox="0 0 90 90" className="size-24" role="img" aria-label={`Health ${score}%`}>
      <circle
        cx="45"
        cy="45"
        r={radius}
        fill="none"
        strokeWidth="8"
        className="stroke-muted"
      />
      <circle
        cx="45"
        cy="45"
        r={radius}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        className={`${tone} -rotate-90 origin-center transition-[stroke-dashoffset] duration-700`}
        strokeDasharray={`${filled} ${circumference}`}
      />
      <text
        x="45"
        y="50"
        textAnchor="middle"
        className="fill-current text-lg font-semibold"
      >
        {score}
      </text>
    </svg>
  );
}

/** The service board: a traffic-light row per supervised service. */
function ServicesBoard({ entries }: { entries: ServiceMetrics[] }) {
  const maxMemory = Math.max(...entries.map((entry) => entry.memory_bytes), 1);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" aria-hidden />
          Service board
        </CardTitle>
        <CardDescription>Live CPU and memory per service</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing supervised yet. Start a service and watch this board light
            up.
          </p>
        ) : (
          <ul className="space-y-2.5 text-sm">
            {entries.map((entry) => (
              <li key={entry.id} className="space-y-1">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${
                        entry.state === "running"
                          ? "bg-success"
                          : entry.state === "failed"
                            ? "bg-destructive"
                            : entry.state === "starting" || entry.state === "stopping"
                              ? "bg-warning animate-pulse"
                              : "bg-muted-foreground/40"
                      }`}
                    />
                    <span className="min-w-0 truncate font-mono text-xs">{entry.id}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {entry.state === "running"
                      ? `${(entry.cpu_percent ?? 0).toFixed(0)}% · ${formatBytes(entry.memory_bytes)}`
                      : entry.state}
                  </span>
                </div>
                <div className="flex gap-1" aria-hidden>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{ width: `${entry.cpu_percent ?? 0}%` }}
                    />
                  </div>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/60 transition-[width] duration-500"
                      style={{ width: `${(entry.memory_bytes / maxMemory) * 100}%` }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** A compact snapshot of configured sites. */
function SitesSnapshot({ sites }: { sites: { hostname: string; https: boolean }[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4 text-muted-foreground" aria-hidden />
          Sites
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sites yet — scaffold one from the Sites page.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {sites.slice(0, 6).map((site) => (
              <li key={site.hostname} className="flex items-center justify-between gap-4">
                <span className="min-w-0 truncate font-mono text-xs" data-selectable>
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
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="size-4 text-muted-foreground" aria-hidden />
          Activity
        </CardTitle>
        <CardDescription>Since this window opened</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Quiet so far. Service state changes show up here as they happen.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {entries.map((entry, index) => (
              <li key={`${entry.at}-${entry.id}-${index}`} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${
                    entry.state === "running"
                      ? "bg-success"
                      : entry.state === "failed"
                        ? "bg-destructive"
                        : "bg-warning"
                  }`}
                />
                <span className="min-w-0 truncate font-mono text-xs">{entry.id}</span>
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

/** Rolling history of the aggregate CPU reading, newest last. */
function useRollingHistory(value: number, capacity: number): number[] {
  const [history, setHistory] = useState<number[]>([]);
  useEffect(() => {
    setHistory((current) => [...current, value].slice(-capacity));
    // `capacity` is constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return history;
}

/** Recent service state transitions, newest first. */
function useActivityFeed(): { id: string; state: string; at: string }[] {
  const [entries, setEntries] = useState<{ id: string; state: string; at: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;

    // Outside a Tauri runtime (tests) `listen` rejects; the feed then simply
    // stays empty, and the pages' own polling remains the data fallback.
    ipcEvents.serviceEventUpdate
      .listen((event) => {
        const { id, state } = event.payload.event;
        setEntries((current) =>
          [{ id, state: String(state), at: new Date().toLocaleTimeString() }, ...current].slice(
            0,
            6,
          ),
        );
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

  return entries;
}

/** Health score from live signals: service ratio, DNS, CA trust. */
function computeHealthScore({
  totalServices,
  runningServices,
  dnsRunning,
  caTrusted,
}: {
  totalServices: number;
  runningServices: number;
  dnsRunning: boolean | undefined;
  caTrusted: boolean | undefined;
}): number | null {
  const signals: number[] = [];
  if (totalServices > 0) {
    signals.push((runningServices / totalServices) * 100);
  }
  if (dnsRunning !== undefined) {
    signals.push(dnsRunning ? 100 : 0);
  }
  if (caTrusted === true) {
    signals.push(100);
  } else if (caTrusted === false) {
    signals.push(0);
  }

  if (signals.length === 0) {
    return null;
  }
  return Math.round(signals.reduce((sum, s) => sum + s, 0) / signals.length);
}

/** CPU average across samples that exist (null CPU reads as 0). */
function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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
