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
              className="block h-4 shimmer-skeleton rounded-sm"
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
    <div className="space-y-6 p-8">
      <PageHeader
        title="Component catalog"
        description={
          installedCount === null
            ? `${catalog.data.length} components · installed versions could not be read.`
            : `${catalog.data.length} components · ${installedVersions} version${installedVersions === 1 ? "" : "s"} installed on this machine.`
        }
        right={
          <div className="border border-border bg-surface px-4 py-3 text-right text-[13px]">
            <span className="whitespace-nowrap text-success">
              ✓ Every download is checksum-verified before it lands.
            </span>
          </div>
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
        <div className="grid gap-6 lg:grid-cols-[16.25rem_minmax(0,1fr)]">
          <nav
            aria-label="Components"
            className="border border-border bg-surface p-3"
          >
            {KIND_ORDER.filter((kind) =>
              catalog.data.some((component) => component.kind === kind),
            ).map((kind) => (
              <div key={kind}>
                <h2 className="px-2.5 pt-3 pb-1.5 text-xs font-normal uppercase tracking-[0.08em] text-ink-muted first:pt-1">
                  {KIND_LABELS[kind]}
                </h2>
                {catalog.data
                  .filter((component) => component.kind === kind)
                  .map((component) => {
                    const installedForComponent =
                      install.installed.data?.filter(
                        (entry) => entry.component_id === component.id,
                      ).length ?? 0;
                    return (
                      <button
                        key={component.id}
                        type="button"
                        onClick={() => setSelectedId(component.id)}
                        aria-current={selected?.id === component.id}
                        className={cn(
                          "flex w-full items-center gap-2 border-l-2 px-2.5 py-2 text-left text-sm transition-colors duration-150",
                          selected?.id === component.id
                            ? "border-foreground bg-surface-2 font-semibold text-foreground"
                            : "border-transparent hover:bg-hover",
                        )}
                      >
                        {/* §95: the name is the only label the row has. */}
                        <span className="min-w-0 truncate" title={component.name}>
                          {component.name}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-xs text-ink-muted">
                          {installedForComponent > 0 ? (
                            <span className="font-semibold text-success">
                              {installedForComponent}
                            </span>
                          ) : (
                            "—"
                          )}
                        </span>
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
      className="flex min-h-0 flex-col space-y-4 border border-border bg-surface p-6 lg:h-0 lg:min-h-full"
      aria-label={component.name}
    >
      <div>
        <p className="text-[13px] uppercase tracking-[0.08em] text-ink-muted">
          {KIND_LABELS[component.kind]}
        </p>
        <h2 className="text-h1 tracking-tight">{component.name}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{component.license}</Badge>
          {component.multi_version ? (
            <Badge variant="default">multi-version</Badge>
          ) : null}
          {component.pinned ? (
            <Badge variant="outline">
              <Lock className="size-3" />
              pinned
            </Badge>
          ) : null}
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
        <p className="mt-3 text-sm text-muted-foreground">{component.summary}</p>
      </div>

      {component.caveat ? (
        <Callout variant="warning" title="Heads up">
          {component.caveat}
        </Callout>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {versions.isPending ? (
          /* §37: rows resolving, in the shape of the list they become. */
          <div className="space-y-2" role="status">
            <span className="sr-only">Resolving versions…</span>
            {[0, 1, 2].map((row) => (
              <span
                key={row}
                aria-hidden
                className="block h-8 shimmer-skeleton rounded-sm"
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
            {/* Fill the panel beside the nav; thead sticks to this box's top. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-border text-xs font-normal text-ink-muted">
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    Version
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    Channel
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    Released
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    Size
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-normal">
                    Checksum
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.data.versions.map((version) => (
                  <VersionRow
                    key={version.version}
                    componentId={component.id}
                    version={version}
                    install={install}
                  />
                ))}
              </tbody>
            </table>
            </div>

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
  const downloading = busy && phase?.stage === "downloading";
  const phaseLabel =
    busy && phase && fraction === null && phase.stage !== "downloading"
      ? describePhase(phase)
      : null;

  return (
    <>
      <tr className="border-b border-border last:border-b-0">
        <td className="px-3 py-2.5 font-mono text-[13px] font-semibold" data-selectable>
          {displayVersion(componentId, version.version)}
        </td>
        <td className="px-3 py-2.5">
          {version.channel === "lts" ? (
            <Badge variant="success">LTS</Badge>
          ) : version.channel === "prerelease" ? (
            <Badge variant="warning">pre-release</Badge>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 font-mono text-[13px] text-ink-muted">
          {formatReleased(version.released_at)}
        </td>
        <td className="px-3 py-2.5 font-mono text-[13px]">
          {version.artifact.size_bytes != null
            ? formatBytes(version.artifact.size_bytes)
            : "—"}
        </td>
        <td
          className="px-3 py-2.5 text-xs whitespace-nowrap text-success"
          title={
            version.artifact.checksum.kind === "sha256"
              ? "SHA-256 published by the upstream"
              : "SHA-256 resolved from the upstream checksum file at download time"
          }
        >
          <ShieldCheck aria-hidden className="mr-1 inline size-3.5" />
          verifiable
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="flex items-center justify-end gap-3">
            {installed ? <Badge variant="default">installed</Badge> : null}
            {installed ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={install.uninstall.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                {install.uninstall.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
                Remove
              </Button>
            ) : busy ? (
              <Button
                variant="outline"
                size="sm"
                disabled={install.cancelInstall.isPending}
                onClick={() =>
                  install.cancelInstall.mutate({
                    componentId,
                    version: version.version,
                  })
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
                  install.install.mutate({
                    componentId,
                    version: version.version,
                  })
                }
              >
                <Download />
                Install
              </Button>
            )}
          </div>
          {/* The phase label and progress stay visible while the cancel request
              is in flight; only the button itself swaps to Cancel. */}
          {phaseLabel ? (
            <p className="mt-1 text-xs text-ink-muted">{phaseLabel}</p>
          ) : null}
          {shownError ? (
            <Callout
              variant="destructive"
              title={`Could not install ${version.version}.`}
              className="mt-2 text-left"
            >
              <p>{shownError.message}</p>
            </Callout>
          ) : null}
        </td>
      </tr>

      {downloading && phase ? (
        <tr className="border-b border-border last:border-b-0">
          <td colSpan={6} className="border-t-0 px-3 pt-0 pb-3">
            {/* Indeterminate when the server reported no total length. */}
            <Progress
              value={fraction ?? undefined}
              label={`Downloading ${componentId} ${version.version}`}
            />
            <div className="mt-1 flex items-center justify-between gap-2 font-mono text-xs text-ink-muted">
              <span>
                {downloadInfo}
                {downloadSpeed !== undefined
                  ? ` · ${formatSpeed(downloadSpeed)}`
                  : ""}
              </span>
              {fraction !== null ? <span>{Math.round(fraction * 100)}%</span> : null}
            </div>
          </td>
        </tr>
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
    </>
  );
}

/** Display-only: `bun-v1.3.14` → `v1.3.14`; install still uses the raw id. */
function displayVersion(componentId: string, version: string): string {
  const prefix = `${componentId}-`;
  return version.startsWith(prefix) ? version.slice(prefix.length) : version;
}

/** Mockup style: `2026-05-13` → `May 2026`. Bad input passes through. */
function formatReleased(iso: string | null): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : iso;
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
