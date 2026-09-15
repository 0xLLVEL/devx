import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Database,
  Download,
  HardDrive,
  Loader2,
  Play,
  Save,
  Table2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/ui/select";
import { pickCsvSavePath, pickSqlFile } from "@/lib/pick-file";
import { ipc, type DbResult, type DbServer, type DbValue } from "@/lib/ipc";

/** Databases page: one engine selected on the left, its workspace on the right. */
export function DatabasesPage() {
  const servers = useQuery({ queryKey: ["db-servers"], queryFn: ipc.dbListServers });

  // Total backups across the three services; the per-engine query in the
  // workspace reuses the same cache key, so this is one fetch per engine.
  const mariadbBackups = useQuery({
    queryKey: ["backups", "mariadb"],
    queryFn: () => ipc.backupList("mariadb"),
  });
  const postgresBackups = useQuery({
    queryKey: ["backups", "postgresql"],
    queryFn: () => ipc.backupList("postgresql"),
  });
  const redisBackups = useQuery({
    queryKey: ["backups", "redis"],
    queryFn: () => ipc.backupList("redis"),
  });
  const backupCount =
    (mariadbBackups.data?.length ?? 0) +
    (postgresBackups.data?.length ?? 0) +
    (redisBackups.data?.length ?? 0);

  const [selected, setSelected] = useState("");
  const [database, setDatabase] = useState("");

  const chosen: DbServer | undefined = (servers.data ?? []).find(
    (server) => server.service_id === selected,
  ) ?? (servers.data ?? [])[0];

  const params = chosen
    ? {
        engine: chosen.engine,
        host: chosen.host,
        port: chosen.port,
        username: null,
        password: null,
        database: database === "" ? null : database,
      }
    : null;

  // Table listing follows the selected database; a fresh engine resets it.
  const tables = useQuery({
    queryKey: ["db-tables", chosen?.service_id, database],
    queryFn: () => ipc.dbListTables(params!),
    enabled: params !== null && database !== "",
  });
  const databases = useQuery({
    queryKey: ["db-databases", chosen?.service_id],
    queryFn: () => ipc.dbListDatabases(params!),
    enabled: params !== null,
  });

  if (servers.isPending) {
    return (
      <div className="space-y-4 p-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Detecting database servers…
        </p>
      </div>
    );
  }

  if ((servers.data ?? []).length === 0) {
    return (
      <div className="space-y-4 p-5">
        <EmptyState
          icon={<Database />}
          title="No database servers registered yet."
          description="Install MariaDB, PostgreSQL or Redis from the Components page."
        />
      </div>
    );
  }

  const reachable = (servers.data ?? []).filter((server) => server.reachable).length;

  return (
    <div className="space-y-4 p-5">
      <PageHeader
        title={
          reachable === 0
            ? "No database engines are running."
            : `${reachable} of ${servers.data!.length} engines reachable.`
        }
        description={`${backupCount} backup${backupCount === 1 ? "" : "s"} across all services · the query browser never writes.`}
      />

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* Sidebar: engine choice, database, tables — the navigation surface. */}
        <aside className="space-y-4">
          <div className="rounded-md border border-border bg-card p-3">
            <h2 className="mb-1.5 text-sm font-medium">Engine</h2>
            <ul className="space-y-1">
              {(servers.data ?? []).map((server) => (
                <li key={server.service_id}>
                  <EngineLink
                    server={server}
                    active={server.service_id === chosen?.service_id}
                    onSelect={() => {
                      setSelected(server.service_id);
                      setDatabase("");
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-md border border-border bg-card p-3">
            <Label htmlFor="db-database" className="mb-1.5 block">
              Database
            </Label>
            <span className="sr-only" id="db-database-hint">
              Selects which database the table list reads from.
            </span>
            <Select
              id="db-database"
              className="w-full"
              value={database}
              onChange={(event) => setDatabase(event.target.value)}
            >
              <option value="">—</option>
              {(databases.data?.rows ?? []).map((row) => (
                <option key={cellText(row[0])} value={cellText(row[0])}>
                  {cellText(row[0])}
                </option>
              ))}
            </Select>

            <div className="mt-3 border-t border-border pt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Table2 className="size-3.5" aria-hidden />
                Tables{database ? ` in ${database}` : ""}
              </p>
              <TableNames
                result={tables.data}
                pending={tables.isPending}
                idle={database === ""}
                emptyHint="No tables found."
                idleHint="Pick a database to list its tables."
              />
            </div>
          </div>
        </aside>

        {/* Workspace: query console, then backups for the selected engine. */}
        <div className="min-w-0 space-y-4">
          {chosen ? <QueryPanel server={chosen} params={params} /> : null}
          {chosen ? <BackupsCard server={chosen} /> : null}
        </div>
      </div>
    </div>
  );
}

/** One selectable engine row: dot + label + port, deciding column first. */
function EngineLink({
  server,
  active,
  onSelect,
}: {
  server: DbServer;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm border px-2.5 py-2 text-left text-sm transition-colors duration-150 ${
        active
          ? "border-border bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "border-transparent text-muted-foreground hover:bg-sidebar-accent/60"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${server.reachable ? "bg-success" : "bg-muted-foreground/50"}`}
        />
        <span className="truncate">{engineLabel(server.engine)}</span>
      </span>
      <span className="data-value shrink-0 text-xs text-muted-foreground">
        :{server.port}
      </span>
    </button>
  );
}

/**
 * The query console: one read-only statement, its grid, and the import /
 * export actions that operate on the selected engine.
 */
function QueryPanel({
  server,
  params,
}: {
  server: DbServer;
  params: Parameters<typeof ipc.dbQuery>[0] | null;
}) {
  const [statement, setStatement] = useState("");

  const run = useMutation({ mutationFn: () => ipc.dbQuery(params!, statement) });
  const importSql = useMutation({
    mutationFn: async () => {
      const path = await pickSqlFile();
      // Cancelled dialog: nothing to do.
      if (!path) {
        return;
      }
      await ipc.dbImportSql(server.service_id, path);
    },
  });
  const exportCsv = useMutation({
    mutationFn: async () => {
      const path = await pickCsvSavePath("query-result.csv");
      if (!path) {
        return 0;
      }
      return ipc.dbExportCsv(params!, statement, path);
    },
  });

  const busy = run.isPending;
  const error =
    run.error instanceof Error
      ? run.error
      : importSql.error instanceof Error
        ? importSql.error
        : exportCsv.error instanceof Error
          ? exportCsv.error
          : null;

  return (
    <section className="rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden />
            Query — {engineLabel(server.engine)}
            <Badge variant={server.reachable ? "secondary" : "outline"}>
              {server.reachable ? "reachable" : "not running"}
            </Badge>
          </h2>
          <p className="text-xs text-muted-foreground">
            127.0.0.1:{server.port} · read-only statement, rendered as a grid.
          </p>
        </div>
      </header>

      <div className="space-y-3 p-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run.mutate();
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="db-statement">Statement</Label>
            <Input
              id="db-statement"
              placeholder="SELECT version()"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || statement.trim() === ""}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              Run
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                server.engine === "redis" || !server.reachable || importSql.isPending
              }
              onClick={() => importSql.mutate()}
            >
              {importSql.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              Import .sql
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || statement.trim() === "" || exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
            >
              {exportCsv.isPending ? <Loader2 className="animate-spin" /> : <Download />}
              Export CSV
            </Button>
          </div>
        </form>

        {error ? (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {error.message}
          </p>
        ) : null}

        <ResultGrid result={run.data} pending={run.isPending} />
      </div>
    </section>
  );
}

/**
 * Backups for one database server: SQL dumps for MariaDB/PostgreSQL, RDB
 * snapshots for Redis. The ten newest are kept; older ones are pruned.
 * Rendered as a dense table, not one bordered card per file.
 */
function BackupsCard({ server }: { server: DbServer }) {
  const queryClient = useQueryClient();
  const serviceId = server.service_id;

  const backups = useQuery({
    queryKey: ["backups", serviceId],
    queryFn: () => ipc.backupList(serviceId),
  });

  const create = useMutation({
    mutationFn: () => ipc.backupCreate(serviceId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups", serviceId] }),
  });
  const restore = useMutation({
    mutationFn: (fileName: string) => ipc.backupRestore(serviceId, fileName),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups", serviceId] }),
  });
  const remove = useMutation({
    mutationFn: (fileName: string) => ipc.backupDelete(serviceId, fileName),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups", serviceId] }),
  });

  const entries = backups.data ?? [];
  const actionError =
    create.error instanceof Error
      ? create.error
      : restore.error instanceof Error
        ? restore.error
        : remove.error instanceof Error
          ? remove.error
          : null;

  return (
    <section className="rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Save className="size-4 text-muted-foreground" aria-hidden />
            Backups — {engineLabel(server.engine)}
          </h2>
          <p className="text-xs text-muted-foreground">
            {server.engine === "redis"
              ? "Snapshots the keyspace with SAVE; restoring needs Redis stopped."
              : "Dumps all databases through the engine's own tool into plain SQL."}{" "}
            The ten newest are kept.
          </p>
        </div>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          Back up now
        </Button>
      </header>

      <div className="p-4">
        {backups.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Loading backups…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No backups yet. Take one before schema experiments or upgrades.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li
                key={entry.file_name}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs" data-selectable>
                    {entry.file_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(entry.created_unix)} · {formatSize(entry.size_bytes)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() => {
                      if (window.confirm(`Restore ${entry.file_name} over the running ${serviceId}?`)) {
                        restore.mutate(entry.file_name);
                      }
                    }}
                  >
                    {restore.isPending && restore.variables === entry.file_name ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Undo2 />
                    )}
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(entry.file_name)}
                    aria-label={`Delete ${entry.file_name}`}
                  >
                    {remove.isPending && remove.variables === entry.file_name ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {actionError ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4" />
            {actionError.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Formats Unix seconds as a local date-time string. */
function formatTimestamp(unixSeconds: number): string {
  if (unixSeconds === 0) {
    return "unknown time";
  }
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Formats a byte count for the backup list. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

/** The table-name listing in the sidebar. */
function TableNames({
  result,
  pending,
  idle,
  emptyHint,
  idleHint,
}: {
  result?: DbResult;
  pending: boolean;
  idle: boolean;
  emptyHint: string;
  idleHint: string;
}) {
  // A disabled query (no database picked yet) stays `pending` forever, so
  // the idle hint must be checked before the spinner.
  if (idle) {
    return <p className="text-xs text-muted-foreground">{idleHint}</p>;
  }
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" />
        Loading tables…
      </p>
    );
  }
  const names = (result?.rows ?? []).map((row) => cellText(row[0]));
  if (names.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyHint}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {names.map((name) => (
        <li key={name} className="truncate font-mono text-xs" data-selectable>
          {name}
        </li>
      ))}
    </ul>
  );
}

/** A result grid: columns on top, rows as text. */
function ResultGrid({
  result,
  pending,
}: {
  result?: DbResult;
  pending: boolean;
}) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" />
        Running…
      </p>
    );
  }
  if (!result) {
    return null;
  }
  if (result.columns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Statement executed; it returned no rows.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {result.columns.map((column) => (
              <th
                key={column.name}
                className="px-3 py-2 text-left text-xs font-medium"
                data-selectable
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index} className="border-b border-border last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-1.5 font-mono text-xs" data-selectable>
                  {renderCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders one grid cell: NULL distinctly, everything else as text. */
function renderCell(cell: DbValue): string {
  // The unit variant serializes as the bare string "null"; the tagged
  // variants carry optional `?: never` siblings, so narrowing is by value.
  if (typeof cell === "string") {
    return "NULL";
  }
  if (cell.int !== undefined) {
    return String(cell.int);
  }
  if (cell.float !== undefined) {
    return String(cell.float);
  }
  if (cell.text !== undefined) {
    return cell.text;
  }
  return cell.other;
}

/** The text of a single-cell row (database/table listings). */
function cellText(cell: DbValue | undefined): string {
  return cell === undefined ? "" : renderCell(cell);
}

/** Human label for an engine discriminator. */
function engineLabel(engine: DbServer["engine"]): string {
  switch (engine) {
    case "maria_db":
      return "MariaDB";
    case "postgre_sql":
      return "PostgreSQL";
    case "redis":
      return "Redis";
  }
}
