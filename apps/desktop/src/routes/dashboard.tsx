import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ipc, type ServiceMetrics } from "@/lib/ipc";

/** Landing page: environment overview and build identity. */
export function DashboardPage() {
  const appInfo = useQuery({
    queryKey: ["app-info"],
    queryFn: ipc.appInfo,
  });
  const sites = useQuery({
    queryKey: ["sites"],
    queryFn: ipc.siteList,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your local development environment at a glance."
      />

      <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Build</CardTitle>
            <CardDescription>Identity of this DevX installation</CardDescription>
          </CardHeader>
          <CardContent>
            {appInfo.isPending ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading build info…
              </p>
            ) : appInfo.isError ? (
              <p
                className="flex items-center gap-2 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="size-4" />
                {appInfo.error.message}
              </p>
            ) : (
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="font-mono" data-selectable>
                    {appInfo.data.version}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Target</dt>
                  <dd className="font-mono text-xs" data-selectable>
                    {appInfo.data.target}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Profile</dt>
                  <dd>
                    <Badge variant={appInfo.data.debug ? "warning" : "success"}>
                      {appInfo.data.debug ? "debug" : "release"}
                    </Badge>
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>

        <ServiceMetricsCard />

        <Card>
          <CardHeader>
            <CardTitle>Sites</CardTitle>
            <CardDescription>Local .test domains</CardDescription>
          </CardHeader>
          <CardContent>
            {sites.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" />
                Loading sites…
              </p>
            ) : sites.isError ? (
              <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
                <CircleAlert className="size-4" />
                {sites.error.message}
              </p>
            ) : sites.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sites configured yet. Add one from the Sites page.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {sites.data.slice(0, 5).map((site) => (
                  <li key={site.hostname} className="flex items-center justify-between gap-4">
                    <span className="font-mono text-xs" data-selectable>
                      {site.hostname}
                    </span>
                    {site.https ? <Badge variant="success">https</Badge> : null}
                  </li>
                ))}
                {sites.data.length > 5 ? (
                  <li className="text-xs text-muted-foreground">
                    and {sites.data.length - 5} more
                  </li>
                ) : null}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Polls resource use of every supervised service and renders a live list. */
function ServiceMetricsCard() {
  const metrics = useQuery({
    queryKey: ["service-metrics"],
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });

  const entries = metrics.data ?? [];
  const busy = entries.filter((m) => m.state === "running" || m.state === "starting");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
        <CardDescription>
          {busy.length > 0
            ? `${busy.length} of ${entries.length} running`
            : "Runtime and backing services"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {metrics.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Reading service metrics…
          </p>
        ) : metrics.isError ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {metrics.error.message}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing supervised yet. Start a service from the Services page.
          </p>
        ) : (
          <MetricList entries={entries} />
        )}
      </CardContent>
    </Card>
  );
}

/** One row per supervised service: state plus CPU and memory bars. */
function MetricList({ entries }: { entries: ServiceMetrics[] }) {
  const maxMemory = Math.max(
    ...entries.map((entry) => entry.memory_bytes),
    1,
  );

  return (
    <ul className="space-y-2.5 text-sm">
      {entries.map((entry) => (
        <li key={entry.id} className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <span className="min-w-0 truncate font-mono text-xs">{entry.id}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {entry.state === "running"
                ? `${(entry.cpu_percent ?? 0).toFixed(0)}% CPU · ${formatBytes(entry.memory_bytes)}`
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
  );
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

