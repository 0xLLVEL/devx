import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="Checks that must pass before DevX can manage your environment."
        actions={
          <Button
            variant="outline"
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

      <div className="space-y-3 p-6">
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
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Overall</span>
              <Badge variant={STATUS_META[doctor.data.status].badge}>
                {STATUS_META[doctor.data.status].label}
              </Badge>
            </div>

            {doctor.data.checks.map((check) => {
              const meta = STATUS_META[check.status];
              const Icon = meta.icon;

              return (
                <Card key={check.id}>
                  <CardContent className="flex items-start gap-3 p-4">
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
                      <p className="break-words text-xs text-muted-foreground" data-selectable>
                        {check.detail}
                      </p>
                      {check.remedy ? (
                        <p className="text-xs">{check.remedy}</p>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
