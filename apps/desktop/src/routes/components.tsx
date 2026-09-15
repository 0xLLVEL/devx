import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
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
import { Progress } from "@/components/ui/progress";
import {
  ipc,
  type ComponentKind,
  type ComponentSummary,
  type ComponentVersion,
} from "@/lib/ipc";
import {
  describePhase,
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
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading catalog…
        </p>
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="p-5">
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {catalog.error.message}
        </p>
      </div>
    );
  }

  const selected =
    catalog.data?.find((component) => component.id === selectedId) ??
    catalog.data?.[0] ??
    null;
  const installedVersions = (install.installed.data ?? []).length;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title="Component catalog"
        description={`${catalog.data.length} components · ${installedVersions} version${installedVersions === 1 ? "" : "s"} installed on this machine.`}
        right={
          <span className="text-xs text-muted-foreground">
            Every download is checksum-verified before it lands.
          </span>
        }
      />

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
                            "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                            selected?.id === component.id
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-accent/50",
                          )}
                        >
                          <span className="min-w-0 truncate">{component.name}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {kindInstalled > 0 ? (
                              <Badge variant="success">{kindInstalled}</Badge>
                            ) : null}
                            {component.caveat ? (
                              <TriangleAlert
                                aria-label="Has a caveat"
                                className="size-3.5 shrink-0 text-warning"
                              />
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

  return (
    <section
      className="animate-in fade-in slide-in-from-bottom-2 flex flex-col space-y-4 duration-300 lg:h-0 lg:min-h-full"
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
            <Loader2 aria-label="Refreshing" className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}
          {versions.data?.stale ? (
            <Badge variant="warning">
              <WifiOff className="size-3" />
              offline, showing cached
            </Badge>
          ) : null}
        </div>

        {versions.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Resolving versions…
          </p>
        ) : versions.isError ? (
          <Callout variant="destructive">{versions.error.message}</Callout>
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
                <span className="font-mono">
                  {versions.data.unverifiable.join(", ")}
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

  const installError =
    install.install.error instanceof Error &&
    install.install.variables?.componentId === componentId &&
    install.install.variables?.version === version.version
      ? install.install.error
      : null;

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
              onClick={() =>
                install.uninstall.mutate({ componentId, version: version.version })
              }
            >
              <Trash2 />
              Remove
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                install.install.mutate({ componentId, version: version.version })
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : <Download />}
              {busy && phase ? describePhase(phase) : "Install"}
            </Button>
          )}
        </div>
      </div>

      {busy && fraction !== null ? (
        <div className="mt-2">
          <Progress value={fraction} label={`Installing ${componentId} ${version.version}`} />
        </div>
      ) : null}

      {installError ? (
        <p className="mt-1.5 text-xs text-destructive" role="alert">
          {installError.message}
        </p>
      ) : null}
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
