import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  Bookmark,
  CircleCheck,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { IpcError, ipc, type AppInfo, type Config } from "@/lib/ipc";

/**
 * Saved configuration profiles: named snapshots of the whole config that
 * can be applied again later. Applying runs the same validation path as
 * import, so a stale or hand-edited profile cannot break the live config.
 */
function ProfilesCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [confirmApply, setConfirmApply] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ["profiles"], queryFn: ipc.profileList });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["config"] });
    setConfirmApply(null);
    setConfirmDelete(null);
  };

  const save = useMutation({
    mutationFn: () => ipc.profileSave(name.trim()),
    onSuccess: () => {
      setName("");
      invalidate();
    },
  });
  const apply = useMutation({
    mutationFn: (profile: string) => ipc.profileApply(profile),
    onSuccess: invalidate,
    // The card carries the rejection, so the modal must be out of its way.
    onError: () => setConfirmApply(null),
  });
  const remove = useMutation({
    mutationFn: (profile: string) => ipc.profileDelete(profile),
    onSuccess: invalidate,
    // A modal sits above the toast layer, so the confirmation closes before the
    // rejection is read in the card below (§39).
    onError: () => setConfirmDelete(null),
  });

  const entries = profiles.data ?? [];
  const error =
    save.error instanceof Error
      ? save.error
      : apply.error instanceof Error
        ? apply.error
        : remove.error instanceof Error
          ? remove.error
          : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profiles</CardTitle>
        <CardDescription>
          Snapshot the current sites, workers and settings under a name, and
          restore that snapshot later. Applying replaces the whole active
          configuration.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {profiles.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading saved profiles…
          </p>
        ) : profiles.isError ? (
          /* §121: a read that failed is not "you never saved one". */
          <Callout variant="destructive" title="Could not read the saved profiles.">
            <p>{profiles.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void profiles.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : entries.length > 0 ? (
          <ul className="space-y-1.5">
            {entries.map((profile) => (
              <li key={profile.name} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <Bookmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-mono text-sm" title={profile.name} data-selectable>
                    {profile.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={apply.isPending}
                    onClick={() => setConfirmApply(profile.name)}
                  >
                    Apply
                  </Button>
                  <Tooltip label={`Delete profile ${profile.name}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => setConfirmDelete(profile.name)}
                      aria-label={`Delete profile ${profile.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          /* §38: the form below is the action, so the empty state explains
             rather than repeating it as a button. */
          <EmptyState
            icon={<Bookmark />}
            title="No saved profiles yet."
            description="Set everything up the way you like it, then save it under a name below."
          />
        )}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">New profile name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-setup"
              autoComplete="off"
              className="w-56"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={save.isPending || !name.trim()}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : <Bookmark />}
            Save current configuration
          </Button>
        </form>

        {error ? (
          <Callout variant="destructive" title="Could not update the saved profiles.">
            <p>{error.message}</p>
            {error instanceof IpcError && error.hint ? (
              <p className="mt-1 text-destructive/80">{error.hint}</p>
            ) : null}
          </Callout>
        ) : null}

        {/* §35: applying a profile repaints the whole running configuration, and
            deleting one is not recoverable, so both name their target first. */}
        <ConfirmDialog
          open={confirmApply !== null}
          onClose={() => setConfirmApply(null)}
          onConfirm={() => {
            if (confirmApply) {
              apply.mutate(confirmApply);
            }
          }}
          title={
            confirmApply
              ? `Replace the configuration with "${confirmApply}"?`
              : "Apply this profile?"
          }
          description="Every site, worker and setting in the running configuration is replaced by the snapshot stored in this profile. The current configuration is not kept unless you saved it as a profile of its own."
          confirmLabel="Replace current config"
          destructive
          pending={apply.isPending}
        />
        <ConfirmDialog
          open={confirmDelete !== null}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete) {
              remove.mutate(confirmDelete);
            }
          }}
          title={
            confirmDelete
              ? `Delete the profile "${confirmDelete}"?`
              : "Delete this profile?"
          }
          description="The saved snapshot is deleted from the profiles folder. The running configuration is not changed, and no other profile is touched."
          confirmLabel="Delete profile"
          destructive
          pending={remove.isPending}
        />
      </CardContent>
    </Card>
  );
}

/** Settings page: data locations plus everything in `config.toml`. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);

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
      setConfirmReset(false);
      // §123: this replaces the whole configuration, so it needs a receipt.
      toast.success("Configuration restored to its defaults.");
    },
    onError: (error: Error) => {
      // A modal sits above the toast layer, so it closes before the reason is
      // read (§54).
      setConfirmReset(false);
      toast.error("Could not restore the defaults", { details: error.message });
    },
  });

  const reveal = useMutation({
    mutationFn: ipc.revealManagedDir,
    onError: (error: Error) => {
      toast.error("Could not open the folder", { details: error.message });
    },
  });

  if (configQuery.isPending || !draft) {
    return (
      <div className="p-8">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading configuration…
        </p>
      </div>
    );
  }

  if (configQuery.isError) {
    return (
      <div className="p-8">
        <Callout variant="destructive" title="Could not read the saved configuration.">
          <p>{configQuery.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void configQuery.refetch()}
          >
            Try again
          </Button>
        </Callout>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(configQuery.data);
  // §131 Rule 18: a rejected save is reported whatever it was rejected with;
  // only the IPC-specific hint is conditional.
  const saveError = save.error;
  const saveHint = save.error instanceof IpcError ? save.error.hint : null;

  const patch = (update: (config: Config) => Config) =>
    setDraft((current) => (current ? update(structuredClone(current)) : current));

  return (
    <div className="space-y-5 p-5">
      <PageHeader
          title="Settings"
          description="Stored in config.toml and validated before every save."
          right={
            <>
              {dirty ? (
                <Badge variant="warning">Unsaved changes</Badge>
              ) : save.isSuccess ? (
                <Badge variant="success">Saved</Badge>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setConfirmReset(true)}
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
              </div>
            </>
          }
        />

        {saveError ? (
          <Callout variant="destructive" title="Could not save the configuration.">
            <p>{saveError.message}</p>
            {saveHint ? <p className="mt-1 text-destructive/80">{saveHint}</p> : null}
          </Callout>
        ) : null}

        {save.isSuccess && !dirty ? (
          <div
            role="status"
            className="flex items-center gap-2 border border-success/40 bg-success/10 p-3 text-sm text-success"
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
            <CardTitle>Service Ports</CardTitle>
            <CardDescription>
              Configure default listening ports for supervised services
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { id: "nginx", label: "Nginx HTTP port", fallback: draft.network.http_port },
              { id: "apache", label: "Apache port", fallback: 80 },
              { id: "apache-https", label: "Apache HTTPS port", fallback: 443 },
              { id: "mariadb", label: "MariaDB / MySQL port", fallback: 3306 },
              { id: "postgresql", label: "PostgreSQL port", fallback: 5432 },
              { id: "redis", label: "Redis port", fallback: 6379 },
              { id: "mailpit", label: "Mailpit SMTP port", fallback: 1025 },
              { id: "meilisearch", label: "Meilisearch port", fallback: 7700 },
              { id: "mongodb", label: "MongoDB port", fallback: 27017 },
              { id: "nats-server", label: "NATS port", fallback: 4222 },
              { id: "etcd", label: "etcd client port", fallback: 2379 },
              { id: "caddy", label: "Caddy port", fallback: 80 },
              { id: "traefik", label: "Traefik port", fallback: 80 },
            ].map((svc) => {
              const currentVal = draft.service_ports?.[svc.id] ?? "";
              return (
                <div key={svc.id} className="space-y-1.5">
                  <Label htmlFor={`port-${svc.id}`}>{svc.label}</Label>
                  <Input
                    id={`port-${svc.id}`}
                    type="number"
                    min={1}
                    max={65535}
                    placeholder={`Default: ${svc.fallback}`}
                    value={currentVal}
                    onChange={(event) => {
                      const text = event.target.value.trim();
                      patch((config) => {
                        config.service_ports = config.service_ports ?? {};
                        if (text === "") {
                          delete config.service_ports[svc.id];
                        } else {
                          const num = Number(text);
                          if (!isNaN(num) && num > 0 && num <= 65535) {
                            config.service_ports[svc.id] = num;
                          }
                        }
                        return config;
                      });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty to use default ({svc.fallback}).
                  </p>
                </div>
              );
            })}
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

            <ToggleRow
              id="notify-on-failure"
              label="Notify me when a service fails"
              description="Shows a Windows notification when a service crashes or cannot start."
              checked={draft.general.notify_on_failure}
              onChange={(checked) =>
                patch((config) => {
                  config.general.notify_on_failure = checked;
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
              /* §121: the read is announced and visibly in flight, matching
                 how the other cards on this page report their own loads. */
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                Resolving paths…
              </p>
            ) : pathsQuery.isError ? (
              <Callout variant="destructive" title="Could not resolve the DevX directories.">
                <p>{pathsQuery.error.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void pathsQuery.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            ) : (
              <>
                <PathRow
                  label="Configuration"
                  path={pathsQuery.data.config_dir}
                  busy={reveal.isPending}
                  onReveal={() => reveal.mutate(pathsQuery.data.config_dir)}
                />
                <PathRow
                  label="Data, runtimes and logs"
                  path={pathsQuery.data.data_dir}
                  busy={reveal.isPending}
                  onReveal={() => reveal.mutate(pathsQuery.data.data_dir)}
                />
              </>
            )}
          </CardContent>
        </Card>

        <ProfilesCard />
        <TransferCard />

        <UpdatesCard info={appInfoQuery} />

        {/* §35: restoring the defaults overwrites every setting at once, and the
            saved profiles live outside the config file, so they survive it. */}
        <ConfirmDialog
          open={confirmReset}
          onClose={() => setConfirmReset(false)}
          onConfirm={() => reset.mutate()}
          title="Restore the default configuration?"
          description="Every setting in config.toml is replaced with its DevX default: the domain suffix, ports, resolution strategy, theme, startup behaviour and provisioning options. Unsaved edits are discarded, and the current configuration cannot be recovered afterwards. Saved profiles are not affected."
          confirmLabel="Restore defaults"
          destructive
          pending={reset.isPending}
        />
    </div>
  );
}

/**
 * Export and import of the whole configuration.
 *
 * Export downloads the validated TOML as a file; import takes one back —
 * through the same parse-migrate-validate path a config file on disk uses,
 * so a partial export still imports and anything invalid is refused.
 */
function TransferCard() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);

  const download = (body: string) => {
    const blob = new Blob([body], { type: "application/toml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "devx-config.toml";
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportConfig = useMutation({
    mutationFn: ipc.configExport,
    onSuccess: download,
  });
  const importConfig = useMutation({
    mutationFn: ipc.configImport,
    onSuccess: (saved) => {
      queryClient.setQueryData(["config"], saved);
      setPendingImport(null);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import / export</CardTitle>
        <CardDescription>
          Move your sites, workers and settings between machines. Exported TOML
          imports into any DevX of the same or a newer release.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportConfig.mutate()}
            disabled={exportConfig.isPending}
          >
            {exportConfig.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Export configuration
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={importConfig.isPending}
          >
            <Upload />
            Choose a file to import…
          </Button>
          {pendingImport ? (
            <Button
              size="sm"
              onClick={() => pendingImport && importConfig.mutate(pendingImport)}
              disabled={importConfig.isPending}
            >
              {importConfig.isPending ? <Loader2 className="animate-spin" /> : null}
              Import selected file
            </Button>
          ) : null}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".toml,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) {
              return;
            }
            void file.text().then(setPendingImport);
          }}
        />

        {exportConfig.isSuccess && exportConfig.data ? (
          <p className="text-xs text-muted-foreground" role="status">
            Export ready — {exportConfig.data.length} bytes of TOML downloaded.
          </p>
        ) : null}
        {pendingImport ? (
          <p className="text-xs text-muted-foreground" role="status">
            File selected; importing replaces the current configuration after
            validation.
          </p>
        ) : null}
        {importConfig.isSuccess ? (
          <div
            role="status"
            className="flex items-center gap-2 border border-success/40 bg-success/10 p-3 text-sm text-success"
          >
            <CircleCheck className="size-4" />
            Configuration imported.
          </div>
        ) : null}
        {exportConfig.error instanceof Error ? (
          <Callout variant="destructive" title="Could not export the configuration.">
            <p>{exportConfig.error.message}</p>
          </Callout>
        ) : null}
        {importConfig.error instanceof Error ? (
          <Callout variant="destructive" title="Could not import this file.">
            <p>{importConfig.error.message}</p>
            {importConfig.error instanceof IpcError && importConfig.error.hint ? (
              <p className="mt-1 text-destructive/80">{importConfig.error.hint}</p>
            ) : null}
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Release status of the running build, checked on demand and on page view. */
function UpdatesCard({ info }: { info: UseQueryResult<AppInfo> }) {
  const updates = useQuery({
    queryKey: ["update-check"],
    queryFn: ipc.updateCheck,
    staleTime: 60 * 60 * 1000,
    // The comparison needs the running version, so this waits for app-info.
    enabled: info.data != null,
  });
  const install = useMutation({
    mutationFn: ipc.updateDownloadInstall,
  });

  const current = updates.data?.current ?? info.data?.version ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          DevX checks the published release and can install it for you: the
          installer is verified against the release checksum, then Windows
          asks for permission itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {info.isError ? (
          /* §121: without the running version there is nothing to compare, and
             the update check stays disabled, so this must not sit on
             "Checking for updates…" forever. */
          <Callout variant="destructive" title="Could not read this build's version.">
            <p>{info.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void info.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : updates.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Checking for updates…
          </p>
        ) : updates.isError ? (
          <Callout variant="destructive" title="Could not check for updates.">
            <p>{updates.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void updates.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : install.data ? (
          <div className="flex items-start justify-between gap-4 border border-success/40 bg-success/10 p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                DevX {install.data.version} installer launched
              </p>
              <p className="text-xs text-muted-foreground" data-selectable>
                Verified and started from {install.data.installer_path}. DevX
                is exiting so its files can be replaced — follow the installer.
              </p>
            </div>
          </div>
        ) : updates.data.update_available ? (
          <div className="flex items-start justify-between gap-4 border border-warning/40 bg-warning/10 p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                DevX {updates.data.latest} is available
              </p>
              <p className="text-xs text-muted-foreground" data-selectable>
                You are running {current}. The installer is verified against
                the release checksum before it runs.
              </p>
              {install.error instanceof Error ? (
                <p className="text-xs text-destructive" role="alert">
                  {install.error.message}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <Button
                size="sm"
                onClick={() => install.mutate()}
                disabled={install.isPending}
              >
                {install.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                {install.isPending ? "Downloading…" : "Download and install"}
              </Button>
              {updates.data.url ? (
                <a
                  className="inline-flex h-8 items-center justify-center gap-2 border border-line-strong px-3 text-xs font-medium text-ink-muted hover:bg-hover hover:text-foreground"
                  href={updates.data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Or get it manually
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4 border border-success/40 bg-success/10 p-3">
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

        {/* §108: runtime updates are a different thing from an application
            update, and they live where runtimes live. Saying so here is the
            whole point — this card must never look like it upgrades PHP. */}
        <p className="text-xs text-muted-foreground">
          This is the DevX build only. Runtime versions — PHP, Node, databases —
          are installed and removed on the{" "}
          <Link to="/components" className="text-ink-muted hover:text-foreground">
            Components
          </Link>{" "}
          page.
        </p>
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
  busy,
  onReveal,
}: {
  label: string;
  path: string;
  /** §37: the button is held while the folder is being opened. */
  busy: boolean;
  onReveal: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-border p-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm">{label}</p>
        {/* §95: the row truncates a long path, so the full one stays reachable. */}
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={path}
          data-selectable
        >
          {path}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onReveal} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
        Open
      </Button>
    </div>
  );
}
