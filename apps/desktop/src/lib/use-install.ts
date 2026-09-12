import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ipc, ipcEvents, type InstallPhase } from "@/lib/ipc";

/** Live progress for one component/version being installed. */
export type ActiveInstall = {
  componentId: string;
  version: string;
  phase: InstallPhase;
};

function key(componentId: string, version: string) {
  return `${componentId}@${version}`;
}

/**
 * Subscribes to install-progress events and exposes install/uninstall actions.
 *
 * Progress arrives as backend events rather than through the mutation, because a
 * single install emits many updates. The mutation resolves when the install
 * finishes (or fails); the event stream drives the progress bar in between.
 */
export function useInstall() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<Record<string, InstallPhase>>({});

  const installed = useQuery({
    queryKey: ["installed-versions"],
    queryFn: ipc.installedVersions,
  });

  useEffect(() => {
    const unlisten = ipcEvents.installProgress.listen((event) => {
      const { component_id, version, phase } = event.payload;
      setActive((current) => ({
        ...current,
        [key(component_id, version)]: phase,
      }));
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const clear = (componentId: string, version: string) =>
    setActive((current) => {
      const next = { ...current };
      delete next[key(componentId, version)];
      return next;
    });

  const install = useMutation({
    mutationFn: ({
      componentId,
      version,
    }: {
      componentId: string;
      version: string;
    }) => ipc.componentInstall(componentId, version),
    onSettled: (_data, _error, variables) => {
      clear(variables.componentId, variables.version);
      void queryClient.invalidateQueries({ queryKey: ["installed-versions"] });
    },
  });

  const uninstall = useMutation({
    mutationFn: ({
      componentId,
      version,
    }: {
      componentId: string;
      version: string;
    }) => ipc.componentUninstall(componentId, version),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["installed-versions"] });
    },
  });

  const isInstalled = (componentId: string, version: string) =>
    installed.data?.some(
      (entry) => entry.component_id === componentId && entry.version === version,
    ) ?? false;

  const phaseOf = (
    componentId: string,
    version: string,
  ): InstallPhase | undefined => active[key(componentId, version)];

  return { installed, install, uninstall, isInstalled, phaseOf };
}

/** Human-readable label for an install phase. */
export function describePhase(phase: InstallPhase): string {
  switch (phase.stage) {
    case "resolving_checksum":
      return "Resolving checksum…";
    case "downloading": {
      if (phase.total && phase.total > 0) {
        const pct = Math.round((phase.downloaded / phase.total) * 100);
        return `Downloading ${pct}%`;
      }
      return "Downloading…";
    }
    case "verifying":
      return "Verifying…";
    case "extracting":
      return "Extracting…";
    case "finalising":
      return "Finalising…";
    case "done":
      return "Done";
  }
}

/** Completion fraction in 0..1 for a downloading phase, else null. */
export function phaseFraction(phase: InstallPhase): number | null {
  if (phase.stage === "downloading" && phase.total && phase.total > 0) {
    return Math.min(phase.downloaded / phase.total, 1);
  }
  return null;
}
