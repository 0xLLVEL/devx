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
import { Card, CardContent } from "@/components/ui/card";
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
  "mail",
  "storage",
  "search",
  "tool",
  "tunnel",
];

/** Components page: what can be installed, and which versions are available. */
export function ComponentsPage() {
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: ipc.catalogList });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    catalog.data?.find((component) => component.id === selectedId) ??
    catalog.data?.[0] ??
    null;

  return (
    <>
      <PageHeader
        title="Components"
        description="Runtimes and services DevX can install, with versions resolved from each upstream."
      />

      {catalog.isPending ? (
        <div className="p-6">
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading catalog…
          </p>
        </div>
      ) : catalog.isError ? (
        <div className="p-6">
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {catalog.error.message}
          </p>
        </div>
      ) : (
        <div className="grid gap-6 p-6 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="Components" className="space-y-4">
            {KIND_ORDER.filter((kind) =>
              catalog.data.some((component) => component.kind === kind),
            ).map((kind) => (
              <div key={kind} className="space-y-1">
                <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {KIND_LABELS[kind]}
                </h2>
                {catalog.data
                  .filter((component) => component.kind === kind)
                  .map((component) => (
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
                      <span>{component.name}</span>
                      {component.caveat ? (
                        <TriangleAlert
                          aria-label="Has a caveat"
                          className="size-3.5 shrink-0 text-warning"
                        />
                      ) : null}
                    </button>
                  ))}
              </div>
            ))}
          </nav>

          {selected ? <ComponentDetail component={selected} /> : null}
        </div>
      )}
    </>
  );
}

function ComponentDetail({ component }: { component: ComponentSummary }) {
  const versions = useQuery({
    queryKey: ["component-versions", component.id],
    queryFn: () => ipc.componentVersions(component.id),
  });
  const install = useInstall();

  return (
    <section className="space-y-4">
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
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{component.caveat}</p>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Available versions</h3>
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
          <div
            role="alert"
            className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <p>{versions.error.message}</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {versions.data.versions.map((version) => (
                <VersionRow
                  key={version.version}
                  componentId={component.id}
                  version={version}
                  install={install}
                />
              ))}
            </ul>

            {versions.data.unverifiable.length > 0 ? (
              <Card>
                <CardContent className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <p>
                    {versions.data.unverifiable.length} release
                    {versions.data.unverifiable.length === 1 ? "" : "s"} hidden
                    because the upstream publishes no checksum for them:{" "}
                    <span className="font-mono">
                      {versions.data.unverifiable.join(", ")}
                    </span>
                  </p>
                </CardContent>
              </Card>
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
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
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
