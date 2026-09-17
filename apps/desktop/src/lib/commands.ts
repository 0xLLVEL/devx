import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle, PlayCircle, Settings2, SunMoon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { themeLabel, useTheme } from "@/components/theme-provider";
import { useToast } from "@/components/ui/toast";
import { ipc, type Theme } from "@/lib/ipc";
import { NAV_ITEMS } from "@/lib/navigation";
import { useServiceMetrics } from "@/lib/queries";

/**
 * The command palette's contents (§92).
 *
 * Every entry runs something that already exists. The list is deliberately
 * shorter than §92's examples: "Install Node 22" is a real feature but it
 * needs a flow — a version picker, a confirmation — and a palette item that
 * half-does a job is worse than one that is missing (§120 #9).
 */

export type CommandGroup = "Navigation" | "Services" | "Appearance" | "System";

/** §33 orders the groups the way a power user scans them. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  "Navigation",
  "Services",
  "Appearance",
  "System",
];

export type Command = {
  id: string;
  title: string;
  group: CommandGroup;
  icon: LucideIcon;
  /** Shortcut badge (§33). Only shortcuts that really work are shown. */
  hint?: string;
  keywords: string[];
  run: () => void;
};

/** §56's navigation shortcuts, mapped onto the routes that exist. */
const NAV_HINTS: Record<string, string> = {
  "/projects": "Alt 0",
  "/": "Alt 1",
  "/components": "Alt 2",
  "/services": "Alt 3",
  "/sites": "Alt 4",
  "/databases": "Alt 5",
};

/** How §56's Start All Services is written wherever it is shown. */
export const START_ALL_HINT = "Ctrl Shift S";

/**
 * §56's Start All Services, in one place.
 *
 * The palette entry and the `Ctrl+Shift+S` binding both call this, so the key
 * and the menu item cannot drift apart, and both get the same per-service
 * failure report.
 *
 * It runs `services_start_all`, the supervisor's own bulk command. The Services
 * page's own "Start all" additionally starts the PHP pools, which the
 * supervisor does not register as components and which have their own
 * per-pool commands; that difference is why this is not the page's button.
 */
export function useStartAllServices() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const metrics = useServiceMetrics();

  const startAll = useMutation({
    mutationFn: ipc.servicesStartAll,
    onSuccess: (outcomes) => {
      const failed = outcomes.filter((outcome) => outcome.error !== null);
      if (failed.length > 0) {
        toast.error(
          `${failed.length} service${failed.length === 1 ? "" : "s"} did not start`,
          {
            description: failed.map((outcome) => outcome.id).join(", "),
            details: failed
              .map((outcome) => `${outcome.id}: ${outcome.error ?? "unknown error"}`)
              .join("\n"),
          },
        );
        return;
      }
      toast.success("Services started");
    },
    onError: (error: Error) => {
      toast.error("Could not start services", { details: error.message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });

  // A sample that could not be read is not "nothing to start" (§2), so only a
  // successful read can say there is nothing left to do.
  const startableCount = metrics.isError
    ? null
    : (metrics.data ?? []).filter(
        (entry) => entry.state === "stopped" || entry.state === "failed",
      ).length;

  const start = () => {
    if (startableCount === 0) {
      // §54: the key is bound unconditionally, so it says why it did nothing
      // rather than looking broken.
      toast.info("Nothing to start", {
        description: "No supervised service is stopped or failed.",
      });
      return;
    }
    startAll.mutate();
  };

  return { start, startableCount, startAll };
}

export function useAppCommands(): Command[] {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const metrics = useServiceMetrics();
  const theme = useTheme();
  const paths = useQuery({ queryKey: ["paths"], queryFn: ipc.pathsGet });
  const { start, startableCount } = useStartAllServices();

  const refreshServices = () => {
    void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  const stopAll = useMutation({
    mutationFn: ipc.servicesStopAll,
    onSuccess: () => toast.success("Services stopped"),
    onError: (error: Error) => {
      toast.error("Could not stop services", { details: error.message });
    },
    onSettled: refreshServices,
  });

  const revealConfig = useMutation({
    mutationFn: (path: string) => ipc.revealManagedDir(path),
    onError: (error: Error) => {
      toast.error("Could not open the config directory", { details: error.message });
    },
  });

  const configDir = paths.data?.config_dir;
  const entries = metrics.data ?? [];
  const runningCount = entries.filter((entry) => entry.state === "running").length;
  const { theme: currentTheme, setTheme } = theme;

  return useMemo(() => {
    const commands: Command[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.to}`,
      title: item.label,
      group: "Navigation" as const,
      icon: item.icon,
      ...(NAV_HINTS[item.to] ? { hint: NAV_HINTS[item.to] } : {}),
      keywords: [...item.keywords, "go to", "open"],
      run: () => navigate(item.to),
    }));

    if (startableCount !== null && startableCount > 0) {
      commands.push({
        id: "services:start-all",
        title: "Start all services",
        group: "Services",
        icon: PlayCircle,
        hint: START_ALL_HINT,
        keywords: ["up", "launch", "boot"],
        run: start,
      });
    }

    if (runningCount > 0) {
      commands.push({
        id: "services:stop-all",
        title: "Stop all services",
        group: "Services",
        icon: PauseCircle,
        keywords: ["halt", "shutdown", "down"],
        run: () => stopAll.mutate(),
      });
    }

    const themes: Theme[] = ["system", "light", "dark"];
    for (const candidate of themes) {
      if (candidate === currentTheme) {
        continue;
      }
      commands.push({
        id: `theme:${candidate}`,
        title: `Use ${themeLabel(candidate).toLowerCase()} theme`,
        group: "Appearance",
        icon: SunMoon,
        keywords: ["dark", "light", "system", "colour", "color", "appearance"],
        run: () => setTheme(candidate),
      });
    }

    if (configDir) {
      commands.push({
        id: "system:open-config-dir",
        title: "Open the config directory",
        group: "System",
        icon: Settings2,
        keywords: ["reveal", "folder", "explorer", "config.toml", "settings"],
        run: () => revealConfig.mutate(configDir),
      });
    }

    return commands;
  }, [
    navigate,
    start,
    stopAll,
    revealConfig,
    currentTheme,
    setTheme,
    startableCount,
    runningCount,
    configDir,
  ]);
}
