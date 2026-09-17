import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  CircleSlash,
  Download,
  Loader2,
  Lock,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Callout,
} from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ipc,
  IpcError,
  type ComponentKind,
  type ComponentSummary,
  type ComponentVersion,
} from "@/lib/ipc";
import {
  describeDownload,
  describePhase,
  formatSpeed,
  phaseFraction,
  useInstall,
} from "@/lib/use-install";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<ComponentKind, string> = {
  runtime: "Runtimes",
  web_server: "Web servers",
  database: "Databases",
  cache: "Cache",
  message_queue: "Queues",
  mail: "Mail",
  storage: "Storage",
  search: "Search",
  tool: "Tools",
  tunnel: "Sharing",
};

const KIND_ORDER: ComponentKind[] = [
  "runtime",
  "web_server",
  "database",
  "cache",
  "message_queue",
  "mail",
  "storage",
  "search",
  "tool",
  "tunnel",
];

/** Components page: what can be installed, and which versions are available. */
export function ComponentsPage() {
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: ipc.catalogList });
  const install = useInstall();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (catalog.isPending) {
    return (
      <div className="p-5">
        {/* §37: a skeleton in the shape of the catalog instead of a spinner. */}
        <div className="space-y-2" role="status">
          <span className="sr-only">Loading catalog…</span>
          {[0, 1, 2].map((row) => (
            <span
              key={row}
              aria-hidden
              className="block h-4 animate-pulse rounded-sm bg-secondary"
            />
          ))}
        </div>
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="p-5">
        <Callout variant="destructive" title="Could not read the component catalog.">
          <p>{catalog.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void catalog.refetch()}
          >
            Try again
          </Button>
        </Callout>
      </div>
    );
  }

  const selected =
    catalog.data?.find((component) => component.id === selectedId) ??
    catalog.data?.[0] ??
    null;
  // §121: an unreadable list must not be reported as "nothing installed".
  const installedCount = install.installed.isError
    ? null
    : (install.installed.data ?? []).length;
  const installedVersions = installedCount ?? 0;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title="Component catalog"
        description={
          installedCount === null
            ? `${catalog.data.length} components · installed versions could not be read.`
            : `${catalog.data.length} components · ${installedVersions} version${installedVersions === 1 ? "" : "s"} installed on this machine.`
        }
        right={
          <span className="text-xs text-muted-foreground">
            Every download is checksum-verified before it lands.
          </span>
        }
      />

      {install.installed.isError ? (
        <Callout variant="destructive" title="Could not read the installed versions.">
          <p>{install.installed.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void install.installed.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : null}

      {catalog.data.length === 0 ? (
        /* §38: an embedded catalog can come up empty, and nothing on this page
           would otherwise say so; the nav just stays blank. */
        <EmptyState
          icon={<Boxes />}
          title="No components in the catalog."
          description="The catalog this build carries lists no components, so there is nothing to install or remove."
          action={
            <Button size="sm" variant="outline" onClick={() => void catalog.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="Components" className="space-y-4">
            {KIND_ORDER.filter((kind) =>
              catalog.data.some((component) => component.kind === kind),
            ).map((kind) => (
              <div key={kind} className="space-y-1">
                <h2 className="px-1 text-xs font-semibold text-muted-foreground">
                  {KIND_LABELS[kind]}
                </h2>
                {catalog.data
                  .filter((component) => component.kind === kind)
                  .map((component) => {
                    const kindInstalled = install.installed.data?.filter(
                      (entry) => entry.component_id === component.id,
                    ).length ?? 0;
                    return (
                      <button
                        key={component.id}
                        type="button"
                        onClick={() => setSelectedId(component.id)}
                        aria-current={selected?.id === component.id}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-150",
                          selected?.id === component.id
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/50",
                        )}
                      >
                        {/* §95: the name is the only label the row has. */}
                        <span className="min-w-0 truncate" title={component.name}>
                          {component.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {kindInstalled > 0 ? (
                            <Badge variant="success">{kindInstalled}</Badge>
                          ) : null}
                          {component.caveat ? (
                            /* §94: the caveat is only spelled out in the detail
                               pane, so the icon carries it here. */
                            <Tooltip label={component.caveat} side="top">
                              <TriangleAlert
                                aria-label="Has a caveat"
                                className="size-3.5 shrink-0 text-warning"
                              />
                            </Tooltip>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
              </div>
            ))}
          </nav>

          {selected ? <ComponentDetail component={selected} install={install} /> : null}
        </div>
      )}
    </div>
  );
}

function ComponentDetail({
  component,
  install,
}: {
  component: ComponentSummary;
  install: ReturnType<typeof useInstall>;
}) {
  const versions = useQuery({
    queryKey: ["component-versions", component.id],
    queryFn: () => ipc.componentVersions(component.id),
  });

  const installable = versions.data?.versions.length ?? 0;
  const hidden = versions.data?.unverifiable.length ?? 0;
  const hiddenVersions = versions.data?.unverifiable.join(", ") ?? "";

  return (
    <section
      className="animate-in fade-in slide-in-from-bottom-2 flex flex-col space-y-4 duration-200 lg:h-0 lg:min-h-full"
      aria-label={component.name}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{component.name}</h2>
          <Badge variant="outline">{component.license}</Badge>
          {component.multi_version ? (
            <Badge variant="secondary">multi-version</Badge>
          ) : null}
          {component.pinned ? (
            <Badge variant="outline">
              <Lock className="size-3" />
              pinned
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{component.summary}</p>
      </div>

      {component.caveat ? (
        <Callout variant="warning" title="Heads up">
          {component.caveat}
        </Callout>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Available versions</h3>
          {versions.data ? (
            <Badge variant="outline">
              {installable} installable
              {hidden > 0 ? ` · ${hidden} hidden` : ""}
            </Badge>
          ) : null}
          {versions.isFetching ? (
            /* §55: the spinner is decoration; the state lives in the status. */
            <>
              <Loader2 aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
              <span role="status" className="sr-only">
                Refreshing versions
              </span>
            </>
          ) : null}
          {versions.data?.stale ? (
            <Badge variant="warning">
              <WifiOff className="size-3" />
              offline, showing cached
            </Badge>
          ) : null}
        </div>

        {versions.isPending ? (
          /* §37: rows resolving, in the shape of the list they become. */
          <div className="space-y-2" role="status">
            <span className="sr-only">Resolving versions…</span>
            {[0, 1, 2].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-8 animate-pulse rounded-sm bg-secondary"
              />
            ))}
          </div>
        ) : versions.isError ? (
          <Callout
            variant="destructive"
            title={`Could not resolve versions for ${component.name}.`}
          >
            <p>{versions.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void versions.refetch()}
            >
              Try again
            </Button>
          </Callout>
        ) : versions.data.versions.length === 0 ? (
          /* §38: an empty list next to a "0 installable" badge explains itself. */
          <EmptyState
            icon={<Download />}
            title="No installable versions."
            description={
              hidden > 0
                ? "Every release the upstream lists is hidden because it publishes no checksum for it; the hidden list is below."
                : "No release of this component is available to install right now."
            }
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void versions.refetch()}
              >
                Try again
              </Button>
            }
          />
        ) : (
          <>
            <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border lg:max-h-none lg:min-h-0 lg:flex-1">
              {versions.data.versions.map((version) => (
                <VersionRow
                  key={version.version}
                  componentId={component.id}
                  version={version}
                  install={install}
                />
              ))}
            </ul>

            {hidden > 0 ? (
              <Callout variant="warning">
                {hidden} release{hidden === 1 ? "" : "s"} hidden because the
                upstream publishes no checksum for them:{" "}
                {/* §95: the list can run long, so it truncates with the full
                    text on hover rather than stretching the callout. */}
                <span className="block truncate font-mono" title={hiddenVersions}>
                  {hiddenVersions}
                </span>
              </Callout>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function VersionRow({
  componentId,
  version,
  install,
}: {
  componentId: string;
  version: ComponentVersion;
  install: ReturnType<typeof useInstall>;
}) {
  const installed = install.isInstalled(componentId, version.version);
  const phase = install.phaseOf(componentId, version.version);
  const busy = phase !== undefined && phase.stage !== "done";
  const fraction = phase ? phaseFraction(phase) : null;
  const downloadInfo = phase ? describeDownload(phase) : null;
  const downloadSpeed =
    phase?.stage === "downloading"
      ? install.speedOf(componentId, version.version)
      : undefined;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toast = useToast();

  const installError =
    install.install.error instanceof Error &&
    install.install.variables?.componentId === componentId &&
    install.install.variables?.version === version.version
      ? install.install.error
      : null;

  // A deliberate cancel is not a failure: the backend reports it through a
  // dedicated code, and the row just returns to its idle Install state.
  const cancelled =
    installError instanceof IpcError && installError.code === "process" &&
    install.install.variables?.componentId === componentId &&
    install.install.variables?.version === version.version
      ? installError
      : null;
  const shownError = cancelled ? null : installError;

  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono" data-selectable>
            {version.version}
          </span>
          {version.channel === "lts" ? (
            <Badge variant="success">LTS</Badge>
          ) : version.channel === "prerelease" ? (
            <Badge variant="warning">pre-release</Badge>
          ) : null}
          {installed ? <Badge variant="secondary">installed</Badge> : null}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {version.released_at ? <span>{version.released_at}</span> : null}
          {version.artifact.size_bytes ? (
            <span>{formatBytes(version.artifact.size_bytes)}</span>
          ) : null}
          <span
            className="flex items-center gap-1 text-success"
            title={
              version.artifact.checksum.kind === "sha256"
                ? "SHA-256 published by the upstream"
                : "SHA-256 resolved from the upstream checksum file at download time"
            }
          >
            <ShieldCheck className="size-3.5" />
            verifiable
          </span>

          {installed ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={install.uninstall.isPending}
              onClick={() => setConfirmRemove(true)}
            >
              {install.uninstall.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Remove
            </Button>
          ) : busy ? (
            <Button
              variant="outline"
              size="sm"
              disabled={install.cancelInstall.isPending}
              onClick={() =>
                install.cancelInstall.mutate({ componentId, version: version.version })
              }
            >
              <CircleSlash />
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                install.install.mutate({ componentId, version: version.version })
              }
            >
              <Download />
              Install
            </Button>
          )}
        </div>
      </div>

      {/* The phase label and progress stay visible while the cancel request
          is in flight; only the button itself swaps to Cancel. */}
      {busy && phase && fraction === null && phase.stage !== "downloading" ? (
        <p className="mt-1 text-xs text-muted-foreground">{describePhase(phase)}</p>
      ) : null}

      {busy && phase?.stage === "downloading" ? (
        <div className="mt-2 space-y-1">
          {/* Indeterminate when the server reported no total length. */}
          <Progress
            value={fraction ?? undefined}
            label={`Downloading ${componentId} ${version.version}`}
          />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {/* Byte counts when the server reported a length, the running
                count alone when it did not. */}
            <span>
              {downloadInfo}
              {downloadSpeed !== undefined
                ? ` · ${formatSpeed(downloadSpeed)}`
                : ""}
            </span>
            {fraction !== null ? <span>{Math.round(fraction * 100)}%</span> : null}
          </div>
        </div>
      ) : null}

      {shownError ? (
        <Callout
          variant="destructive"
          title={`Could not install ${version.version}.`}
          className="mt-2"
        >
          <p>{shownError.message}</p>
        </Callout>
      ) : null}

      {/* §35: removing deletes the files on disk, so the version is named before
          it goes. The confirmation stays up while the removal runs, and closes
          either way so the toast is not left behind the modal. */}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() =>
          install.uninstall.mutate(
            { componentId, version: version.version },
            {
              onSuccess: () => {
                setConfirmRemove(false);
                toast.success(`Removed ${componentId} ${version.version}`);
              },
              onError: (error: Error) => {
                setConfirmRemove(false);
                toast.error(`Could not remove ${componentId} ${version.version}`, {
                  details: error.message,
                });
              },
            },
          )
        }
        title={`Remove ${componentId} ${version.version}?`}
        description="The installed files for this version are deleted from disk. Other versions of this component stay where they are."
        confirmLabel="Remove version"
        destructive
        pending={install.uninstall.isPending}
      />
    </li>
  );
}

/** Formats a byte count using binary units. */
function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}
