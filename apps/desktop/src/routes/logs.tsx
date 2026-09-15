import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
    <div className="space-y-4 p-5">
      {entries.length > 0 ? (
        <PageHeader
            title={`${entries.length} log file${entries.length === 1 ? "" : "s"} · ${formatBytes(
              entries.reduce((sum, f) => sum + f.size_bytes, 0),
            )}`}
          description="Everything DevX and its supervised services have written, including rotated generations."
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
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
              <EmptyState title="No logs yet." description="Start a service to produce output." />
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
    </div>
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
      className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm border px-2.5 py-2 text-left text-sm transition-colors duration-150 ${
        active
          ? "border-border bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "border-transparent text-muted-foreground hover:bg-sidebar-accent/60"
      }`}
    >
      <span className="data-value min-w-0 truncate">{entry.file_name}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {entry.rotated ? <Badge variant="outline">rotated</Badge> : null}
        <span className="data-value text-muted-foreground">{formatBytes(entry.size_bytes)}</span>
      </span>
    </button>
  );
}

/** Severity buckets the level filter understands. */
type LevelFilter = "all" | "info" | "warn" | "error";

/** Which level bucket one log line falls into, from common log conventions. */
function lineLevel(line: string): Exclude<LevelFilter, "all"> | "other" {
  if (/\b(ERROR|CRITICAL|FATAL|panic)\b/i.test(line)) {
    return "error";
  }
  if (/\b(WARN|WARNING)\b/i.test(line)) {
    return "warn";
  }
  if (/\b(INFO|NOTICE|DEBUG|TRACE)\b/i.test(line)) {
    return "info";
  }
  return "other";
}

/** Reads and tails one log file, with search, level filter and auto-refresh. */
function LogViewer({ fileName }: { fileName: string }) {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");

  const content = useQuery({
    queryKey: ["log-content", fileName, autoRefresh],
    queryFn: () => ipc.logsRead(fileName, TAIL_LINES),
    refetchInterval: autoRefresh ? 2000 : false,
    refetchIntervalInBackground: false,
  });

  // Filtering is derived per render: the tail is small (≤ 500 lines) and
  // re-polling keeps it fresh, so a memo over the current lines is enough.
  const visible = useMemo(() => {
    const lines = content.data?.lines ?? [];
    const needle = search.trim().toLowerCase();
    return lines.filter((line) => {
      if (level !== "all" && lineLevel(line) !== level) {
        return false;
      }
      return needle === "" || line.toLowerCase().includes(needle);
    });
  }, [content.data?.lines, search, level]);
  const filtering = search.trim() !== "" || level !== "all";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="data-value min-w-0 truncate text-sm">{fileName}</CardTitle>
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search lines…"
              className="pl-8"
              aria-label={`Search in ${fileName}`}
            />
          </div>
          <Select
            value={level}
            onChange={(event) => setLevel(event.target.value as LevelFilter)}
            className="w-36"
            aria-label={`Filter ${fileName} by level`}
          >
            <option value="all">All levels</option>
            <option value="info">Info & debug</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </Select>
          {filtering ? (
            <span className="text-xs text-muted-foreground" role="status">
              {visible.length} of {content.data?.lines.length ?? 0} lines
            </span>
          ) : null}
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
              className="max-h-[60vh] overflow-y-auto rounded-sm border border-border bg-background/60 p-2"
              data-selectable
            >
              {content.data.lines.length === 0 ? (
                <p className="data-value text-muted-foreground">This file is empty.</p>
              ) : visible.length === 0 ? (
                <p className="data-value text-muted-foreground">
                  No lines match the current search and level filter.
                </p>
              ) : (
                visible.map((line, index) => (
                  <div key={`${index}-${line.slice(0, 12)}`} className="data-value">
                    {line}
                  </div>
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
