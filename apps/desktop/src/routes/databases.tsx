import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  Database,
  HardDrive,
  Loader2,
  Play,
  Table2,
} from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { ipc, type DbResult, type DbServer, type DbValue } from "@/lib/ipc";

/** Databases page: browse schemas and run read-only queries. */
export function DatabasesPage() {
  const servers = useQuery({ queryKey: ["db-servers"], queryFn: ipc.dbListServers });

  const [selected, setSelected] = useState("");
  const [database, setDatabase] = useState("");
  const [statement, setStatement] = useState("");

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

  // Table listing follows the selected database; a fresh server resets it.
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

  const run = useMutation({ mutationFn: () => ipc.dbQuery(params!, statement) });

  const busy = run.isPending;
  const error =
    run.error instanceof Error
      ? run.error
      : databases.error instanceof Error
        ? databases.error
        : tables.error instanceof Error
          ? tables.error
          : null;

  return (
    <>
      <PageHeader
        title="Databases"
        description="Browse the schemas of the database servers DevX supervises and run read-only queries."
      />

      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        {servers.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            Detecting database servers…
          </p>
        ) : (servers.data ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No database servers registered yet. Install MariaDB, PostgreSQL or
            Redis from the Components page.
          </div>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HardDrive className="size-4 text-muted-foreground" aria-hidden />
                  Server
                </CardTitle>
                <CardDescription>
                  DevX targets the running service's actual port; reachability
                  is checked live.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="db-server">Engine</Label>
                  <Select
                    id="db-server"
                    className="w-56"
                    value={chosen?.service_id ?? ""}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setDatabase("");
                    }}
                  >
                    {(servers.data ?? []).map((server) => (
                      <option key={server.service_id} value={server.service_id}>
                        {engineLabel(server.engine)} — 127.0.0.1:{server.port}
                        {server.reachable ? "" : " (unreachable)"}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="db-database">Database</Label>
                  <Select
                    id="db-database"
                    className="w-56"
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
                </div>
                {chosen ? (
                  <Badge variant={chosen.reachable ? "secondary" : "outline"}>
                    {chosen.reachable ? "reachable" : "not running"}
                  </Badge>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Table2 className="size-4 text-muted-foreground" aria-hidden />
                  Tables
                </CardTitle>
                <CardDescription>
                  {database === ""
                    ? "Pick a database to list its tables."
                    : `Tables in ${database}.`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TableNames result={tables.data} pending={tables.isPending} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="size-4 text-muted-foreground" aria-hidden />
                  Query
                </CardTitle>
                <CardDescription>
                  One read-only statement against the selected server, rendered
                  as a grid.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run.mutate();
                  }}
                >
                  <div className="min-w-64 flex-1 space-y-1.5">
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
                  <Button type="submit" size="sm" disabled={busy || statement.trim() === ""}>
                    {busy ? <Loader2 className="animate-spin" /> : <Play />}
                    Run
                  </Button>
                </form>

                {error ? (
                  <p className="mt-3 flex items-center gap-2 text-sm text-destructive" role="alert">
                    <CircleAlert className="size-4" />
                    {error.message}
                  </p>
                ) : null}

                <div className="mt-4">
                  <ResultGrid result={run.data} pending={run.isPending} />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

/** The table-name listing inside its card. */
function TableNames({
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
        Loading tables…
      </p>
    );
  }
  const names = (result?.rows ?? []).map((row) => cellText(row[0]));
  if (names.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No tables found.</p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {names.map((name) => (
        <li key={name}>
          <Badge variant="outline" className="font-mono" data-selectable>
            {name}
          </Badge>
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
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {result.columns.map((column) => (
              <th
                key={column.name}
                className="px-3 py-2 text-left font-medium"
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
                <td key={cellIndex} className="px-3 py-1.5 font-mono" data-selectable>
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
