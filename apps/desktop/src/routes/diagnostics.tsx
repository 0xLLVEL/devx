import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FileText, FolderOpen, Loader2, RefreshCw, Stethoscope, Wrench } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import {
  ipc,
  type AppInfo,
  type AppPaths,
  type CheckStatus,
  type DoctorReport,
} from "@/lib/ipc";

const STATUS_META: Record<
  CheckStatus,
  { label: string; badge: "success" | "warning" | "destructive" }
> = {
  pass: { label: "Pass", badge: "success" },
  warn: { label: "Warning", badge: "warning" },
  fail: { label: "Failed", badge: "destructive" },
};

/** Diagnostics page: environment checks with actionable remedies. */
export function DiagnosticsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  /** The check awaiting confirmation; only the config rewrite needs one. */
  const [pendingFix, setPendingFix] = useState<{ id: string; title: string } | null>(
    null,
  );

  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: ipc.doctorRun,
    staleTime: 0,
  });

  const fix = useMutation({
    mutationFn: (checkId: string) => ipc.doctorFix(checkId),
    onSuccess: (report, checkId) => {
      queryClient.setQueryData(["doctor"], report);
      const title =
        report.checks.find((check) => check.id === checkId)?.title ?? checkId;
      toast.success(`Repaired: ${title}`);
    },
    // The inline note below lives on the check and goes away with the next
    // report; the toast keeps the failure visible for the pending mutation
    // whatever happens to the list (§54).
    onError: (error: Error) => {
      toast.error("Could not repair this check", { details: error.message });
    },
  });

  const data = doctor.data;
  const counts = {
    pass: data?.checks.filter((check) => check.status === "pass").length ?? 0,
    warn: data?.checks.filter((check) => check.status === "warn").length ?? 0,
    fail: data?.checks.filter((check) => check.status === "fail").length ?? 0,
  };

  return (
    <div className="space-y-6 p-8">
      <SystemCard report={data ?? null} />
      {doctor.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Running checks…
        </p>
      ) : doctor.isError ? (
        <Callout variant="destructive" title="Could not run the checks.">
          <p>{doctor.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void doctor.refetch()}
          >
            Try again
          </Button>
        </Callout>
      ) : data && data.checks.length > 0 ? (
        <>
          <PageHeader
            title={
              counts.fail > 0
                ? "Some checks are failing."
                : counts.warn > 0
                  ? "Everything works, with caveats."
                  : "All checks passed."
            }
            description={`${counts.pass} passed · ${counts.warn} warnings · ${counts.fail} failing`}
            right={
              <Button
                variant="outline"
                size="sm"
                onClick={() => doctor.refetch()}
                disabled={doctor.isFetching}
              >
                {doctor.isFetching ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Re-run checks
              </Button>
            }
          />

          <div className="flex items-center gap-2 text-sm">
            <Stethoscope className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">Overall</span>
            <Badge variant={STATUS_META[data.status].badge}>
              {STATUS_META[data.status].label}
            </Badge>
          </div>

          <Card>
            <CardContent className="p-2">
              <ul className="divide-y divide-border">
                {data.checks.map((check) => {
                  const meta = STATUS_META[check.status];

                  return (
                    <li key={check.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span
                        aria-hidden
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${
                          check.status === "pass"
                            ? "bg-success"
                            : check.status === "warn"
                              ? "bg-warning"
                              : "bg-destructive"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="text-sm">{check.title}</h2>
                          <Badge variant={meta.badge}>{meta.label}</Badge>
                        </div>
                        <p
                          className="data-value break-words text-muted-foreground"
                          data-selectable
                        >
                          {check.detail}
                        </p>
                        {check.remedy ? (
                          <Callout
                            variant={check.status === "fail" ? "destructive" : "warning"}
                          >
                            {check.remedy}
                          </Callout>
                        ) : null}
                        {check.fix ? (
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Button
                              variant="outline"
                              size="sm"
                              // One repair at a time, but only the one that is
                              // running: the others stay available (§48).
                              disabled={fix.isPending && fix.variables === check.fix}
                              onClick={() => {
                                if (!check.fix) {
                                  return;
                                }
                                if (check.fix === "config") {
                                  // Rewriting config.toml discards the user's
                                  // edits, so it asks first (§35).
                                  setPendingFix({ id: check.fix, title: check.title });
                                  return;
                                }
                                fix.mutate(check.fix);
                              }}
                            >
                              {fix.isPending && fix.variables === check.fix ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Wrench />
                              )}
                              Fix automatically
                            </Button>
                            {fix.isError && fix.variables === check.fix ? (
                              <Callout variant="destructive" title="Could not repair this check.">
                                <p>
                                  {fix.error instanceof Error
                                    ? fix.error.message
                                    : "Repair failed"}
                                </p>
                              </Callout>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </>
      ) : (
        // §38/§121 + Rule 17: no report at all is neither a pass nor a score of
        // zero, and the page says so instead of leaving the card alone.
        <EmptyState
          icon={<Stethoscope />}
          title="No check was reported."
          description="DevX asked the backend for the environment checks and got none back. Running them again is the way to get a report."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doctor.refetch()}
              disabled={doctor.isFetching}
            >
              {doctor.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Re-run checks
            </Button>
          }
        />
      )}

      {/* §35: what happens to the existing file is stated outright. */}
      <ConfirmDialog
        open={pendingFix !== null}
        onClose={() => setPendingFix(null)}
        onConfirm={() => {
          if (pendingFix) {
            fix.mutate(pendingFix.id);
          }
          setPendingFix(null);
        }}
        title="Regenerate config.toml?"
        description={`${pendingFix?.title ?? "The configuration file"} cannot be read, so DevX writes a fresh default. Your current file is kept beside it as config.toml.broken — nothing is deleted, and settings you had (sites, ports, services) go back to their defaults.`}
        confirmLabel="Regenerate"
        destructive
        pending={fix.isPending}
      />
    </div>
  );
}

/**
 * §109's system information.
 *
 * Every value here comes from the backend — `app_info`, `paths_get` and the
 * doctor report already on screen. §109 also lists OS, architecture, shell,
 * PATH and the log directory; this build exposes none of those, so they are
 * named as unavailable instead of being guessed at from the webview, and the
 * log directory is left to the Logs page, which reads it through Rust.
 *
 * Environment values never appear here — not on the card, not in the copied
 * text. The copy exists to be pasted into an issue, and a PATH is nobody
 * else's business.
 */
function SystemCard({ report }: { report: DoctorReport | null }) {
  const toast = useToast();
  const navigate = useNavigate();

  const appInfo = useQuery({ queryKey: ["app-info"], queryFn: ipc.appInfo });
  const paths = useQuery({ queryKey: ["paths"], queryFn: ipc.pathsGet });

  const reveal = useMutation({
    mutationFn: (dir: string) => ipc.revealManagedDir(dir),
    onError: (error: Error) =>
      toast.error("Could not open the config directory", {
        details: error.message,
      }),
  });

  const copy = async () => {
    const text = diagnosticsText(appInfo.data ?? null, paths.data ?? null, report);
    if (!navigator.clipboard) {
      toast.error("Could not copy the diagnostics", {
        description: "The clipboard is not available in this window.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      // §54: name what went out, including what was left out of it.
      toast.success("Diagnostics copied", {
        description:
          "Version, build target, directories and check results — no environment values.",
      });
    } catch (error) {
      toast.error("Could not copy the diagnostics", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const configDir = paths.data?.config_dir ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {appInfo.isPending || paths.isPending ? (
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" />
            Reading system information…
          </p>
        ) : (
          <>
            {/* §109 reads two sources, so one failing does not hide the other:
                each carries its own error and its own way to try again. */}
            {appInfo.isError ? (
              <Callout variant="destructive" title="Could not read the build information.">
                <p>{appInfo.error.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void appInfo.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            ) : null}
            {paths.isError ? (
              <Callout variant="destructive" title="Could not read the DevX directories.">
                <p>{paths.error.message}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void paths.refetch()}
                >
                  Try again
                </Button>
              </Callout>
            ) : null}
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {appInfo.data ? (
                <>
                  <InfoRow
                    label="DevX version"
                    value={`${appInfo.data.name} ${appInfo.data.version}`}
                  />
                  <InfoRow
                    label="Build"
                    value={`${appInfo.data.debug ? "debug" : "release"} · ${appInfo.data.target}`}
                  />
                </>
              ) : null}
              {paths.data ? (
                <>
                  <InfoRow label="Config directory" value={paths.data.config_dir} />
                  <InfoRow label="Data directory" value={paths.data.data_dir} />
                </>
              ) : null}
              <InfoRow label="Logs" value="Read on the Logs page" />
              <InfoRow label="OS, shell, PATH" value="Not reported by this build" />
            </dl>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Environment variables are never shown or copied from here, whatever the
          build reports (§109).
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            <Copy />
            Copy diagnostics
          </Button>
          <Button variant="outline" size="sm" onClick={() => void navigate("/logs")}>
            <FileText />
            Open logs
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={configDir === null || reveal.isPending}
            onClick={() => {
              if (configDir) {
                reveal.mutate(configDir);
              }
            }}
          >
            {reveal.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            Open config folder
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** One label/value pair on the system card (§96: paths are mono and selectable). */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="data-value truncate text-ink-secondary" title={value} data-selectable>
        {value}
      </dd>
    </div>
  );
}

/**
 * §109's "Copy Diagnostics" payload.
 *
 * Plain text, newest-first irrelevant, no markup: it goes into a bug report.
 * Only backend-reported facts and the check results are in here — there is no
 * environment lookup anywhere in this function, by design.
 */
function diagnosticsText(
  appInfo: AppInfo | null,
  paths: AppPaths | null,
  report: DoctorReport | null,
): string {
  const lines: string[] = [];
  if (appInfo) {
    lines.push(`${appInfo.name} ${appInfo.version}`);
    lines.push(`Build: ${appInfo.debug ? "debug" : "release"} (${appInfo.target})`);
  } else {
    lines.push("DevX version: not reported");
  }
  lines.push(`Config directory: ${paths?.config_dir ?? "not reported"}`);
  lines.push(`Data directory: ${paths?.data_dir ?? "not reported"}`);
  if (report) {
    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const check of report.checks) {
      counts[check.status] += 1;
    }
    lines.push(
      `Checks: ${report.status} — ${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failing`,
    );
    for (const check of report.checks) {
      lines.push(`[${check.status}] ${check.title}: ${check.detail}`);
    }
  } else {
    lines.push("Checks: not run");
  }
  return lines.join("\n");
}
