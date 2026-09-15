import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  Loader2,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { ipc, type CheckStatus } from "@/lib/ipc";

const STATUS_META: Record<
  CheckStatus,
  { label: string; badge: "success" | "warning" | "destructive"; icon: typeof CircleCheck }
> = {
  pass: { label: "Pass", badge: "success", icon: CircleCheck },
  warn: { label: "Warning", badge: "warning", icon: TriangleAlert },
  fail: { label: "Failed", badge: "destructive", icon: CircleAlert },
};

/** Diagnostics page: environment checks with actionable remedies. */
export function DiagnosticsPage() {
  const queryClient = useQueryClient();

  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: ipc.doctorRun,
    staleTime: 0,
  });

  const fix = useMutation({
    mutationFn: (checkId: string) => ipc.doctorFix(checkId),
    onSuccess: (report) => queryClient.setQueryData(["doctor"], report),
  });

  const data = doctor.data;
  const counts = {
    pass: data?.checks.filter((check) => check.status === "pass").length ?? 0,
    warn: data?.checks.filter((check) => check.status === "warn").length ?? 0,
    fail: data?.checks.filter((check) => check.status === "fail").length ?? 0,
  };

  return (
    <div className="space-y-4 p-5">
      {doctor.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Running checks…
        </p>
      ) : doctor.isError ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {doctor.error.message}
        </p>
      ) : data ? (
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
                  const Icon = meta.icon;

                  return (
                    <li
                      key={check.id}
                      className="flex items-start gap-3 p-3 transition-colors duration-150"
                    >
                      <Icon
                        aria-hidden
                        className={
                          check.status === "pass"
                            ? "mt-0.5 size-4 shrink-0 text-success"
                            : check.status === "warn"
                              ? "mt-0.5 size-4 shrink-0 text-warning"
                              : "mt-0.5 size-4 shrink-0 text-destructive"
                        }
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <h2 className="text-sm font-medium">{check.title}</h2>
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
                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={fix.isPending}
                              onClick={() => {
                                if (
                                  check.fix === "config" &&
                                  !window.confirm(
                                    "Move the broken config file aside and regenerate defaults? The broken copy is kept as config.toml.broken.",
                                  )
                                ) {
                                  return;
                                }
                                fix.mutate(check.fix as string);
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
                              <span className="text-xs text-destructive" role="alert">
                                {fix.error instanceof Error
                                  ? fix.error.message
                                  : "Repair failed"}
                              </span>
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
      ) : null}
    </div>
  );
}
