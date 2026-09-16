import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import {
  useInstalledVersions,
  useServiceMetrics,
  useSites,
} from "@/lib/queries";

/**
 * Data the shell chrome needs, reused through the same query keys the pages
 * use so nothing is fetched twice (§101: the shell renders before the system
 * state arrives, and never blocks on it).
 */

/**
 * Counts for the sidebar (§5).
 *
 * A count appears only when a real query returned one: an undefined entry
 * means "the backend has not said", and the sidebar renders nothing rather
 * than a zero it made up (§131 Rule 17).
 */
export function useNavCounts(): Record<string, number | undefined> {
  const installed = useInstalledVersions();
  const metrics = useServiceMetrics();
  const sites = useSites();
  const servers = useQuery({
    queryKey: ["db-servers"],
    queryFn: ipc.dbListServers,
  });
  const mail = useQuery({ queryKey: ["mail-status"], queryFn: ipc.mailStatus });

  const unread = mail.data?.unread ?? null;

  return {
    "/components": installed.data?.length,
    "/services": metrics.data?.length,
    "/sites": sites.data?.length,
    "/databases": servers.data?.length,
    // A nav badge says "there is something to look at": zero unread is not
    // worth a mark, unlike zero installed components, which is.
    "/mail": unread === null || unread === 0 ? undefined : unread,
  };
}

export type SystemState =
  | "ready"
  | "attention"
  | "error"
  | "starting"
  | "stopping"
  | "unknown";

export type SystemStatus = {
  state: SystemState;
  label: string;
  detail: string;
  /** Failed services behind the status, so the topbar can badge them too. */
  failedCount: number;
};

/**
 * The sidebar's system status (§118), derived from the live service metrics —
 * the same source the dashboard reads, so the two can never disagree. None of
 * these states is invented in React: with no metrics yet, there is no status.
 */
export function useSystemStatus(): SystemStatus | null {
  const metrics = useServiceMetrics();
  const entries = metrics.data;
  if (!entries) {
    return null;
  }
  return deriveSystemStatus(entries.map((entry) => entry.state));
}

/**
 * §118's states, derived from service states. Exported because it is the one
 * piece of shell logic worth pinning down: the sidebar verdict must follow the
 * worst thing that is happening, not the first.
 */
export function deriveSystemStatus(states: readonly string[]): SystemStatus {  const count = (state: string) => states.filter((value) => value === state).length;
  const failed = count("failed");

  if (states.length === 0) {
    return {
      state: "unknown",
      label: "No Services",
      detail: "Nothing is supervised yet.",
      failedCount: 0,
    };
  }

  if (failed > 0) {
    return {
      state: "error",
      label: "System Error",
      detail: `${failed} service${failed === 1 ? "" : "s"} failed.`,
      failedCount: failed,
    };
  }

  const starting = count("starting");
  if (starting > 0) {
    return {
      state: "starting",
      label: "Starting",
      detail: `${starting} service${starting === 1 ? " is" : "s are"} starting.`,
      failedCount: 0,
    };
  }

  const stopping = count("stopping");
  if (stopping > 0) {
    return {
      state: "stopping",
      label: "Stopping",
      detail: `${stopping} service${stopping === 1 ? " is" : "s are"} stopping.`,
      failedCount: 0,
    };
  }

  const running = count("running");
  if (running === states.length) {
    return {
      state: "ready",
      label: "System Ready",
      detail:
        running === 1 ? "The service is running." : "All services are running.",
      failedCount: 0,
    };
  }

  return {
    state: "attention",
    label: "Attention Required",
    detail: `${running} of ${states.length} services running.`,
    failedCount: 0,
  };
}
