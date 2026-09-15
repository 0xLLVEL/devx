import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import type {
  InstalledVersion,
  PhpPoolStatus,
  ServiceMetrics,
} from "@/lib/ipc";

/**
 * Data access for service- and site-facing pages, behind one deep hook
 * module: query keys, polling intervals and invalidation rules have a
 * single home here instead of leaking into every component.
 */

/** Canonical query keys, so invalidation can never drift from readers. */
export const queryKeys = {
  serviceMetrics: ["service-metrics"] as const,
  installedVersions: ["installed-versions"] as const,
  serviceComponentIds: ["service-component-ids"] as const,
  phpPools: ["php-pools"] as const,
  workers: ["worker-list"] as const,
  cron: ["cron-list"] as const,
  sites: ["sites"] as const,
  ca: ["ca"] as const,
  dns: ["dns"] as const,
};

/** Live CPU/RAM for every supervised service, polled on a short interval. */
export function useServiceMetrics() {
  return useQuery({
    queryKey: queryKeys.serviceMetrics,
    queryFn: ipc.serviceMetrics,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
}

/** Components installed on this machine. */
export function useInstalledVersions() {
  return useQuery({
    queryKey: queryKeys.installedVersions,
    queryFn: ipc.installedVersions,
  });
}

/** Component ids the backend knows how to supervise (stable across runs). */
export function useServiceComponentIds() {
  return useQuery({
    queryKey: queryKeys.serviceComponentIds,
    queryFn: ipc.serviceComponentIds,
    staleTime: Infinity,
  });
}

/** One FastCGI pool per installed PHP version, planned by the backend. */
export function usePhpPools() {
  return useQuery({ queryKey: queryKeys.phpPools, queryFn: ipc.phpPoolList });
}

/** Configured queue workers with their live instance states. */
export function useWorkers() {
  return useQuery({ queryKey: queryKeys.workers, queryFn: ipc.workerList });
}

/** Configured scheduled tasks with their Windows registration. */
export function useCronJobs() {
  return useQuery({ queryKey: queryKeys.cron, queryFn: ipc.cronList });
}

/** The configured sites, with resolved endpoints and env vars. */
export function useSites() {
  return useQuery({ queryKey: queryKeys.sites, queryFn: ipc.siteList });
}

/** Local CA trust status. */
export function useCaStatus() {
  return useQuery({ queryKey: queryKeys.ca, queryFn: ipc.caStatus });
}

/** Bundled resolver status. */
export function useDnsStatus() {
  return useQuery({ queryKey: queryKeys.dns, queryFn: ipc.dnsStatus });
}

/** A mutation that refreshes the site list when it settles. */
export function useSiteMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.sites }),
  });
}

/** Aggregates over the live metrics, computed in one place. */
export function summarizeMetrics(entries: ServiceMetrics[]) {
  const running = entries.filter((m) => m.state === "running");
  const failed = entries.filter((m) => m.state === "failed");
  const withCpu = running.map((m) => m.cpu_percent ?? 0);
  return {
    total: entries.length,
    running,
    runningCount: running.length,
    failed,
    cpu:
      withCpu.length === 0
        ? 0
        : withCpu.reduce((sum, v) => sum + v, 0) / withCpu.length,
    memory: running.reduce((sum, m) => sum + m.memory_bytes, 0),
  };
}

export type { InstalledVersion, PhpPoolStatus, ServiceMetrics };
