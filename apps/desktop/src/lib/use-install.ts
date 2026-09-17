import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

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

/** Window over which download speed is averaged, in milliseconds. */
const SPEED_WINDOW_MS = 3_000;

/** One byte-count observation used to compute download speed. */
type SpeedSample = { at: number; downloaded: number };

/**
 * Subscribes to install-progress events and exposes install/uninstall actions.
 *
 * Progress arrives as backend events rather than through the mutation, because a
 * single install emits many updates. The mutation resolves when the install
 * finishes (or fails); the event stream drives the progress bar in between.
 *
 * Download speed is derived client-side from consecutive `downloading` phases,
 * averaged over `SPEED_WINDOW_MS` so a single slow or fast chunk cannot spike
 * the number the user sees.
 */
export function useInstall() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<Record<string, InstallPhase>>({});
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const samplesRef = useRef(new Map<string, SpeedSample[]>());

  const installed = useQuery({
    queryKey: ["installed-versions"],
    queryFn: ipc.installedVersions,
  });

  useEffect(() => {
    const unlisten = ipcEvents.installProgress.listen((event) => {
      const { component_id, version, phase } = event.payload;
      const id = key(component_id, version);
      setActive((current) => ({
        ...current,
        [id]: phase,
      }));

      // Byte counts only exist while downloading; any other phase drops the
      // stale speed so the row never shows a rate for an idle install.
      if (phase.stage !== "downloading") {
        setSpeeds((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
        samplesRef.current.delete(id);
        return;
      }

      const now = Date.now();
      const samples = (samplesRef.current.get(id) ?? []).filter(
        (sample) => now - sample.at <= SPEED_WINDOW_MS,
      );
      const first = samples[0];
      const speed =
        first && now > first.at
          ? Math.max(
              0,
              (phase.downloaded - first.downloaded) /
                ((now - first.at) / 1_000),
            )
          : undefined;
      samples.push({ at: now, downloaded: phase.downloaded });
      samplesRef.current.set(id, samples);

      if (speed !== undefined) {
        setSpeeds((current) => ({ ...current, [id]: speed }));
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const clear = (componentId: string, version: string) => {
    const id = key(componentId, version);
    setActive((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSpeeds((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    samplesRef.current.delete(id);
  };

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

  /**
   * Asks the backend to abort a running install. The install mutation then
   * settles on its own with the cancellation error, which the UI suppresses:
   * a deliberate cancel is not a failure worth an alert.
   */
  const cancelInstall = useMutation({
    mutationFn: ({
      componentId,
      version,
    }: {
      componentId: string;
      version: string;
    }) => ipc.componentInstallCancel(componentId, version),
  });

  const isInstalled = (componentId: string, version: string) =>
    installed.data?.some(
      (entry) => entry.component_id === componentId && entry.version === version,
    ) ?? false;

  const phaseOf = (
    componentId: string,
    version: string,
  ): InstallPhase | undefined => active[key(componentId, version)];

  /** Measured download speed in bytes/s, when a download is in flight. */
  const speedOf = (componentId: string, version: string): number | undefined =>
    speeds[key(componentId, version)];

  return {
    installed,
    install,
    uninstall,
    cancelInstall,
    isInstalled,
    phaseOf,
    speedOf,
  };
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

/** Formats a byte count using binary units. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Formats a transfer rate in bytes/s using binary units. */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * "12.0 MiB / 30.0 MiB" for a downloading phase with a known total, the byte
 * count alone when the server reported no length, and null for other phases.
 */
export function describeDownload(phase: InstallPhase): string | null {
  if (phase.stage !== "downloading") return null;
  const soFar = formatBytes(phase.downloaded);
  return phase.total && phase.total > 0
    ? `${soFar} / ${formatBytes(phase.total)}`
    : soFar;
}

/** Completion fraction in 0..1 for a downloading phase, else null. */
export function phaseFraction(phase: InstallPhase): number | null {
  if (phase.stage === "downloading" && phase.total && phase.total > 0) {
    return Math.min(phase.downloaded / phase.total, 1);
  }
  return null;
}
