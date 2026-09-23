import { CircleAlert, Loader2 } from "lucide-react";

import { PortInspectorButton } from "@/components/port-inspector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { DirUsage } from "@/lib/ipc";

/**
 * §40 system resource panel.
 *
 * It shows what the backend actually measures and nothing else. There is no
 * system-wide CPU or RAM figure and no disk capacity anywhere in the IPC
 * surface, so the panel never draws a gauge against a total it does not have:
 * every percentage here has a denominator that exists, and every byte count is
 * an absolute one.
 */

export function ResourcePanel({
  cpuPercent,
  runningCount,
  memoryBytes,
  processCount,
  metricsPending,
  metricsFailed,
  disk,
  diskPending,
  diskFailed,
  portsClaimed,
  portsActive,
  portsPending,
}: {
  /** Mean CPU of the running services, each normalised to one core. */
  cpuPercent: number;
  runningCount: number;
  /** Resident memory summed over the running services. */
  memoryBytes: number;
  processCount: number;
  /**
   * The metrics sample behind CPU and memory. Required rather than optional:
   * a caller that forgets these would otherwise pass 0 and the panel would
   * report a failed read as an idle machine (§131 Rule 17).
   */
  metricsPending: boolean;
  metricsFailed: boolean;
  disk: readonly DirUsage[];
  diskPending: boolean;
  diskFailed: boolean;
  portsClaimed: number | null;
  portsActive: number | null;
  /** The port map has not answered yet, which is not the same as unavailable. */
  portsPending: boolean;
}) {
  const diskTotal = disk.reduce((sum, entry) => sum + entry.size_bytes, 0);
  // One flag for "there is no figure to show": the numbers below are only
  // meaningful when the sample they came from exists.
  const metricsUnread = metricsPending || metricsFailed;

  return (
    <Card>
      <CardHeader className="pb-1.5">
        <CardTitle className="flex items-center gap-2">
          Resources
          {/* Said out loud: these are the services DevX supervises, not the
              machine. The backend has no machine-wide sampler. */}
          <span className="ml-auto text-[13px] font-normal text-ink-muted">
            supervised services
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Services CPU</span>
            <span className="data-value text-foreground">
              {metricsUnread ? "—" : `${cpuPercent.toFixed(0)}%`}
            </span>
          </div>
          {/* One core is 100% of a service's own normalised CPU, so this bar
              has a real basis: the scale the backend reports on. It is only
              drawn once that sample exists — a bar at zero would claim a
              measurement that was never taken. */}
          {metricsFailed ? null : metricsPending ? (
            <Progress label="Services CPU" className="mt-1.5" />
          ) : (
            <Progress
              value={cpuPercent / 100}
              label="Services CPU"
              className="mt-1.5"
            />
          )}
          <p className="mt-1 flex items-center gap-1.5 text-caption text-ink-muted">
            {metricsFailed ? (
              <>
                <CircleAlert className="size-3" aria-hidden />
                Could not read the service metrics.
              </>
            ) : metricsPending ? (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Reading the service metrics…
              </>
            ) : runningCount === 0 ? (
              "No service is running."
            ) : (
              `Mean across ${runningCount} running service${runningCount === 1 ? "" : "s"}, one core = 100%.`
            )}
          </p>
        </div>

        <div className="border-t border-border pt-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Services memory</span>
            <span className="data-value text-foreground">
              {metricsUnread ? "—" : formatBytes(memoryBytes)}
            </span>
          </div>
          {/* Both figures come from one sample, so the state of that sample is
              explained once, on the CPU row above. Repeating the sentence here
              would say the same thing twice inside one small card. */}
          {metricsUnread ? null : (
            <p className="mt-1 text-caption text-ink-muted">
              {processCount === 0
                ? "No process is running."
                : `Resident across ${processCount} process${processCount === 1 ? "" : "es"}.`}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Managed storage</span>
            <span className="data-value text-foreground">{formatBytes(diskTotal)}</span>
          </div>
          {diskPending ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-caption text-ink-muted">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Measuring…
            </p>
          ) : diskFailed ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-caption text-ink-muted">
              <CircleAlert className="size-3" aria-hidden />
              Could not read disk usage.
            </p>
          ) : disk.length === 0 ? (
            <p className="mt-1.5 text-caption text-ink-muted">
              Nothing stored in the managed directories yet.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {disk.map((entry) => (
                <li key={entry.label} className="flex items-baseline gap-2 text-caption">
                  <span className="min-w-0 truncate text-ink-muted">{entry.label}</span>
                  <span className="data-value ml-auto shrink-0 text-ink-secondary">
                    {formatBytes(entry.size_bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border pt-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Ports claimed</span>
            <span className="data-value text-foreground">
              {portsClaimed === null ? "—" : portsClaimed}
            </span>
          </div>
          <p className="mt-1 text-caption text-ink-muted">
            {portsClaimed === null
              ? portsPending
                ? "Reading the port map…"
                : "Port map unavailable."
              : `${portsActive ?? 0} of ${portsClaimed} bound by a running service.`}
          </p>
          {/* §110: the row that counts DevX's ports is where the machine's
              listener table is reached from, so the two are read together and
              neither is mistaken for the other. */}
          <div className="mt-2">
            <PortInspectorButton />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Formats a byte count for the resource panel. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}
