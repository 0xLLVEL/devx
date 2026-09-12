import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { IpcError, ipc, type AppInfo, type Config } from "@/lib/ipc";

/** Settings page: data locations plus everything in `config.toml`. */
export function SettingsPage() {
  const queryClient = useQueryClient();

  const configQuery = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });
  const pathsQuery = useQuery({ queryKey: ["paths"], queryFn: ipc.pathsGet });
  const appInfoQuery = useQuery({
    queryKey: ["app-info"],
    queryFn: ipc.appInfo,
    staleTime: Infinity,
  });

  // Local working copy: the form stays editable while a save is in flight, and
  // a rejected save keeps the user's input instead of snapping back.
  const [draft, setDraft] = useState<Config | null>(null);
  useEffect(() => {
    if (configQuery.data) {
      setDraft(configQuery.data);
    }
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: ipc.configSet,
    onSuccess: (saved) => {
      queryClient.setQueryData(["config"], saved);
      setDraft(saved);
    },
  });

  const reset = useMutation({
    mutationFn: ipc.configReset,
    onSuccess: (saved) => {
      queryClient.setQueryData(["config"], saved);
      setDraft(saved);
    },
  });

  const reveal = useMutation({ mutationFn: ipc.revealManagedDir });

  if (configQuery.isPending || !draft) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="p-6">
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading configuration…
          </p>
        </div>
      </>
    );
  }

  if (configQuery.isError) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="p-6">
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {configQuery.error.message}
          </p>
        </div>
      </>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(configQuery.data);
  const saveError = save.error instanceof IpcError ? save.error : null;

  const patch = (update: (config: Config) => Config) =>
    setDraft((current) => (current ? update(structuredClone(current)) : current));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Stored in config.toml and validated before every save."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
            >
              Restore defaults
            </Button>
            <Button
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              Save changes
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-6">
        {saveError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div>
              <p>{saveError.message}</p>
              {saveError.hint ? (
                <p className="mt-1 text-destructive/80">{saveError.hint}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {save.isSuccess && !dirty ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success"
          >
            <CircleCheck className="size-4" />
            Configuration saved.
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Local domains</CardTitle>
            <CardDescription>
              How your sites are addressed and resolved
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="domain-suffix">Domain suffix</Label>
              <Input
                id="domain-suffix"
                value={draft.network.domain_suffix}
                onChange={(event) =>
                  patch((config) => {
                    config.network.domain_suffix = event.target.value;
                    return config;
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Sites become <code>name.{draft.network.domain_suffix}</code>.
                RFC 6761 reserves <code>test</code> for this, so it never
                resolves publicly.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dns-mode">Resolution strategy</Label>
              <Select
                id="dns-mode"
                value={draft.network.dns_mode}
                onChange={(event) =>
                  patch((config) => {
                    config.network.dns_mode = event.target
                      .value as Config["network"]["dns_mode"];
                    return config;
                  })
                }
              >
                <option value="auto">Automatic (resolver, fall back to hosts)</option>
                <option value="resolver">Bundled DNS resolver + NRPT</option>
                <option value="hosts_file">Hosts file entries only</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                Only the resolver supports wildcard subdomains.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="http-port">HTTP port</Label>
              <Input
                id="http-port"
                type="number"
                min={1}
                max={65535}
                value={draft.network.http_port}
                onChange={(event) =>
                  patch((config) => {
                    config.network.http_port = Number(event.target.value);
                    return config;
                  })
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="https-port">HTTPS port</Label>
              <Input
                id="https-port"
                type="number"
                min={1}
                max={65535}
                value={draft.network.https_port}
                onChange={(event) =>
                  patch((config) => {
                    config.network.https_port = Number(event.target.value);
                    return config;
                  })
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dns-port">DNS port</Label>
              <Input
                id="dns-port"
                type="number"
                min={1}
                max={65535}
                value={draft.network.dns_port}
                onChange={(event) =>
                  patch((config) => {
                    config.network.dns_port = Number(event.target.value);
                    return config;
                  })
                }
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Application</CardTitle>
            <CardDescription>Appearance and startup behaviour</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="theme">Theme</Label>
                <Select
                  id="theme"
                  value={draft.general.theme}
                  onChange={(event) =>
                    patch((config) => {
                      config.general.theme = event.target
                        .value as Config["general"]["theme"];
                      return config;
                    })
                  }
                >
                  <option value="system">Follow Windows</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </Select>
              </div>
            </div>

            <ToggleRow
              id="start-with-windows"
              label="Start DevX when I sign in"
              description="Applied by the installer-registered task; takes effect on next sign-in."
              checked={draft.general.start_with_windows}
              onChange={(checked) =>
                patch((config) => {
                  config.general.start_with_windows = checked;
                  return config;
                })
              }
            />

            <ToggleRow
              id="close-to-tray"
              label="Closing the window keeps DevX running"
              description="Services stay up and DevX remains in the notification area."
              checked={draft.general.close_to_tray}
              onChange={(checked) =>
                patch((config) => {
                  config.general.close_to_tray = checked;
                  return config;
                })
              }
            />

            <ToggleRow
              id="restore-services"
              label="Restore running services on startup"
              description="Starts whatever was running when DevX last exited."
              checked={draft.general.restore_services_on_start}
              onChange={(checked) =>
                patch((config) => {
                  config.general.restore_services_on_start = checked;
                  return config;
                })
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provisioning</CardTitle>
            <CardDescription>
              Where component versions and hashes come from
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="catalog-url">Catalog URL</Label>
              <Input
                id="catalog-url"
                value={draft.provisioning.catalog_url}
                onChange={(event) =>
                  patch((config) => {
                    config.provisioning.catalog_url = event.target.value;
                    return config;
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Must be HTTPS: artifact hashes are trusted from here.
              </p>
            </div>

            <div className="space-y-1.5 sm:max-w-48">
              <Label htmlFor="max-downloads">Concurrent downloads</Label>
              <Input
                id="max-downloads"
                type="number"
                min={1}
                max={8}
                value={draft.provisioning.max_concurrent_downloads}
                onChange={(event) =>
                  patch((config) => {
                    config.provisioning.max_concurrent_downloads = Number(
                      event.target.value,
                    );
                    return config;
                  })
                }
              />
            </div>

            <ToggleRow
              id="keep-archives"
              label="Keep downloaded archives"
              description="Uses more disk but makes reinstalling a version instant."
              checked={draft.provisioning.keep_archives}
              onChange={(checked) =>
                patch((config) => {
                  config.provisioning.keep_archives = checked;
                  return config;
                })
              }
            />

            <ToggleRow
              id="auto-refresh-catalog"
              label="Refresh available versions on startup"
              checked={draft.provisioning.auto_refresh_catalog}
              onChange={(checked) =>
                patch((config) => {
                  config.provisioning.auto_refresh_catalog = checked;
                  return config;
                })
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Locations</CardTitle>
            <CardDescription>
              Override with <code>DEVX_HOME</code>, <code>DEVX_CONFIG_DIR</code>{" "}
              or <code>DEVX_DATA_DIR</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pathsQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Resolving paths…</p>
            ) : pathsQuery.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {pathsQuery.error.message}
              </p>
            ) : (
              <>
                <PathRow
                  label="Configuration"
                  path={pathsQuery.data.config_dir}
                  onReveal={() => reveal.mutate(pathsQuery.data.config_dir)}
                />
                <PathRow
                  label="Data, runtimes and logs"
                  path={pathsQuery.data.data_dir}
                  onReveal={() => reveal.mutate(pathsQuery.data.data_dir)}
                />
              </>
            )}
          </CardContent>
        </Card>

        <UpdatesCard appInfo={appInfoQuery.data ?? null} />
      </div>
    </>
  );
}

/** Release status of the running build, checked on demand and on page view. */
function UpdatesCard({ appInfo }: { appInfo: AppInfo | null }) {
  const updates = useQuery({
    queryKey: ["update-check"],
    queryFn: ipc.updateCheck,
    staleTime: 60 * 60 * 1000,
    enabled: appInfo !== null,
  });

  const current = updates.data?.current ?? appInfo?.version ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          DevX checks the published release, never installs anything by itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {updates.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Checking for updates…
          </p>
        ) : updates.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {updates.error.message}
          </p>
        ) : updates.data.update_available ? (
          <div className="flex items-start justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                DevX {updates.data.latest} is available
              </p>
              <p className="text-xs text-muted-foreground" data-selectable>
                You are running {current}. Download the new installer from the
                releases page.
              </p>
            </div>
            {updates.data.url ? (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent"
                href={updates.data.url}
                target="_blank"
                rel="noreferrer"
              >
                <Download />
                Get the update
              </a>
            ) : null}
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4 rounded-md border border-success/40 bg-success/10 p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">DevX is up to date</p>
              <p className="text-xs text-muted-foreground" data-selectable>
                Running {current}
                {updates.data.latest ? `; latest release ${updates.data.latest}` : ""}.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updates.refetch()}
              disabled={updates.isFetching}
            >
              {updates.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Check again
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description ? (
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        {...(descriptionId ? { "aria-describedby": descriptionId } : {})}
      />
    </div>
  );
}

function PathRow({
  label,
  path,
  onReveal,
}: {
  label: string;
  path: string;
  onReveal: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm">{label}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" data-selectable>
          {path}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onReveal}>
        <FolderOpen />
        Open
      </Button>
    </div>
  );
}
