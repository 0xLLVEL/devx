// Deep module: ServiceQueries — one seam for all service/site queries.
// Small interface: useSites(), useServices(), usePhpPools() hide bindings + events + error handling.
// Replaces shallow lib/ipc.ts facade (25× unwrap) — leverage: 1 mock vs 25.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/bindings";
import { IpcError } from "@/lib/ipc";

async function unwrap<T>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: { code: string; message: string; hint: string | null } }>): Promise<T> {
  const v = await p;
  if (v.status === "error") throw new IpcError(v.error as never);
  return v.data;
}

export function useSites() {
  return useQuery({ queryKey: ["sites"], queryFn: () => unwrap(commands.siteList()) });
}

export function useServices() {
  return useQuery({ queryKey: ["services"], queryFn: () => unwrap(commands.serviceComponentIds()) });
}

export function usePhpPools() {
  return useQuery({ queryKey: ["php-pools"], queryFn: () => unwrap(commands.phpPoolList()) });
}

export function useServiceMetrics() {
  return useQuery({ queryKey: ["service-metrics"], queryFn: () => unwrap(commands.serviceMetrics()) });
}

export function useSiteAdd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { hostname: string; docroot: string; phpVersion: string; https: boolean }) =>
      unwrap(commands.siteAdd(p.hostname, p.docroot, p.phpVersion, p.https, null)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sites"] }),
  });
}
