import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  Loader2,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";

import { HeroBand } from "@/components/hero-band";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { StatTile } from "@/components/ui/stat-tile";
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
  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: ipc.doctorRun,
    staleTime: 0,
  });

  const data = doctor.data;
  const counts = {
    pass: data?.checks.filter((check) => check.status === "pass").length ?? 0,
    warn: data?.checks.filter((check) => check.status === "warn").length ?? 0,
    fail: data?.checks.filter((check) => check.status === "fail").length ?? 0,
  };

  return (
    <>
      <div className="space-y-4 p-6">
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
            <HeroBand
              title={
                counts.fail > 0
                  ? "Some checks are failing."
                  : counts.warn > 0
                    ? "Everything works, with caveats."
                    : "All checks passed."
              }
              description={`Last run at ${new Date(doctor.dataUpdatedAt).toLocaleTimeString()}.`}
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

            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile
                icon={<CircleCheck className="size-4" />}
                label="Passed"
                value={String(counts.pass)}
                sub="checks green"
              />
              <StatTile
                icon={<TriangleAlert className="size-4" />}
                label="Warnings"
                value={String(counts.warn)}
                sub="work, with caveats"
              />
              <StatTile
                icon={<CircleAlert className="size-4" />}
                label="Failing"
                value={String(counts.fail)}
                sub="blocking issues"
              />
            </div>

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
                        className="animate-in fade-in slide-in-from-bottom-2 flex items-start gap-3 p-3 duration-300"
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
                            className="break-words text-xs text-muted-foreground"
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
    </>
  );
}
