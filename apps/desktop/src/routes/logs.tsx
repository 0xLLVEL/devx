import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ipc, type LogFileInfo } from "@/lib/ipc";

const TAIL_LINES = 500;

/** Logs page: every log file DevX writes, readable without a file explorer. */
export function LogsPage() {
  const files = useQuery({
    queryKey: ["logs-list"],
    queryFn: ipc.logsList,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const entries = files.data ?? [];
  const active = selected ?? entries[0]?.file_name ?? null;

  return (
    <>
      <PageHeader
        title="Logs"
        description="Rotated output of every supervised service, pool and worker."
      />

      <div className="grid gap-4 p-6 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Log files</CardTitle>
          </CardHeader>
          <CardContent>
            {files.isPending ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading logs…
              </p>
            ) : files.isError ? (
              <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
                <CircleAlert className="size-4" />
                {files.error.message}
              </p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No logs yet. Start a service to produce output.
              </p>
            ) : (
              <ul className="space-y-1">
                {entries.map((entry) => (
                  <li key={entry.file_name}>
                    <LogFileLink
                      entry={entry}
                      active={entry.file_name === active}
                      onSelect={() => setSelected(entry.file_name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {active ? (
          <LogViewer key={active} fileName={active} />
        ) : (
          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground">
                Select a log file to read it here.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

/** One selectable log file row with size and rotated badge. */
function LogFileLink({
  entry,
  active,
  onSelect,
}: {
  entry: LogFileInfo;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
        active
          ? "border-border bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "border-transparent text-muted-foreground hover:bg-sidebar-accent/60"
      }`}
    >
      <span className="min-w-0 truncate font-mono text-xs">{entry.file_name}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {entry.rotated ? <Badge variant="outline">rotated</Badge> : null}
        <span className="text-xs text-muted-foreground">{formatBytes(entry.size_bytes)}</span>
      </span>
    </button>
  );
}

/** Reads and tails one log file, with an optional 2-second auto-refresh. */
function LogViewer({ fileName }: { fileName: string }) {
  const [autoRefresh, setAutoRefresh] = useState(true);

  const content = useQuery({
    queryKey: ["log-content", fileName, autoRefresh],
    queryFn: () => ipc.logsRead(fileName, TAIL_LINES),
    refetchInterval: autoRefresh ? 2000 : false,
    refetchIntervalInBackground: false,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="min-w-0 truncate font-mono text-sm">{fileName}</CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Auto-refresh
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Toggle auto-refresh"
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => content.refetch()}
              disabled={content.isFetching}
            >
              {content.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {content.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Reading {fileName}…
          </p>
        ) : content.isError ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {content.error.message}
          </p>
        ) : (
          <>
            {content.data.truncated ? (
              <p className="mb-2 text-xs text-muted-foreground">
                Showing the last {TAIL_LINES} lines of the file.
              </p>
            ) : null}
            <div
              className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-background/50 p-2 font-mono text-xs"
              data-selectable
            >
              {content.data.lines.length === 0 ? (
                <p className="text-muted-foreground">This file is empty.</p>
              ) : (
                content.data.lines.map((line, index) => (
                  <div key={`${index}-${line.slice(0, 12)}`}>{line}</div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Formats a byte count for the file list. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}
