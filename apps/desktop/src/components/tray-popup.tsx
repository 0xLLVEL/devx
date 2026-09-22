import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExternalLink, Power } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSites } from "@/lib/queries";
import { ipc, type Config, type SiteStatus } from "@/lib/ipc";
import { openInBrowser } from "@/lib/open-url";
import { serverLabel, siteUrl } from "@/components/sites/site-helpers";

/** Hides the popup window. Every action hides first: like a native menu,
// the popup is gone before its effect lands. Failures are ignored — the
// backend hides on blur anyway. */
async function hidePopup(): Promise<void> {
  try {
    await getCurrentWindow().hide();
  } catch {
    // Blur-hide covers it.
  }
}

/**
 * The tray popup: what a right-click on the tray icon opens.
 *
 * Rendered only in the `tray-popup` window (route `/tray`), never in the
 * main window. Compact by design: status line, site quick-open list, then
 * Show / Quit. Styled like the app itself (surface card, one accent
 * moment on the primary button) because a native menu cannot be styled.
 */
export function TrayPopup() {
  const queryClient = useQueryClient();
  const sites = useSites();
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void hidePopup();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openSite = (site: SiteStatus) => {
    void hidePopup();
    void openInBrowser(siteUrl(site));
  };

  const showMain = () => {
    void hidePopup();
    void ipc.trayShowMain();
  };

  const quit = () => {
    void hidePopup();
    void ipc.trayQuit();
  };

  const closeToTray = config.data?.general.close_to_tray ?? true;
  const setCloseToTray = useMutation({
    mutationFn: (next: boolean) => {
      const current = queryClient.getQueryData<Config>(["config"]);
      if (!current) {
        throw new Error("Configuration has not loaded yet.");
      }
      return ipc.configSet({
        ...current,
        general: { ...current.general, close_to_tray: next },
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["config"], saved);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const entries = sites.data ?? [];

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">DevX</span>
        <span className="font-mono text-xs text-muted-foreground">
          {entries.length} site{entries.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="menu" aria-label="DevX quick actions">
        {sites.isPending ? (
          <div className="space-y-1.5 p-1" role="status">
            <span className="sr-only">Loading sites…</span>
            {[0, 1].map((row) => (
              <span key={row} aria-hidden className="block h-11 animate-pulse rounded-md bg-secondary" />
            ))}
          </div>
        ) : sites.isError ? (
          <p className="px-2 py-3 text-xs text-destructive">
            Could not read the site list.
          </p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No sites yet.
          </p>
        ) : (
          entries.map((site) => (
            <button
              key={site.hostname}
              type="button"
              role="menuitem"
              aria-label={`Open ${site.hostname} in browser`}
              onClick={() => openSite(site)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {site.hostname}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {serverLabel(site.web_server)}
                  {site.https ? " · https" : ""}
                </span>
              </span>
              <ExternalLink aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))
        )}
      </div>

      <div className="space-y-2 border-t border-border/60 p-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <Label htmlFor="tray-close-to-tray" className="text-xs text-muted-foreground">
            Close to tray
          </Label>
          <Switch
            id="tray-close-to-tray"
            checked={closeToTray}
            onCheckedChange={(next) => setCloseToTray.mutate(next)}
            disabled={setCloseToTray.isPending || !config.data}
          />
        </div>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" className="flex-1" onClick={showMain} autoFocus>
            Show DevX
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={quit}
            aria-label="Quit DevX"
          >
            <Power aria-hidden className="size-3.5" />
            Quit
          </Button>
        </div>
      </div>
    </div>
  );
}
