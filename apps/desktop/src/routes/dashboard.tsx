import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ipc } from "@/lib/ipc";

/** Landing page: environment overview and build identity. */
export function DashboardPage() {
  const appInfo = useQuery({
    queryKey: ["app-info"],
    queryFn: ipc.appInfo,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your local development environment at a glance."
      />

      <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Build</CardTitle>
            <CardDescription>Identity of this DevX installation</CardDescription>
          </CardHeader>
          <CardContent>
            {appInfo.isPending ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading build info…
              </p>
            ) : appInfo.isError ? (
              <p
                className="flex items-center gap-2 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="size-4" />
                {appInfo.error.message}
              </p>
            ) : (
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="font-mono" data-selectable>
                    {appInfo.data.version}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Target</dt>
                  <dd className="font-mono text-xs" data-selectable>
                    {appInfo.data.target}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Profile</dt>
                  <dd>
                    <Badge variant={appInfo.data.debug ? "warning" : "success"}>
                      {appInfo.data.debug ? "debug" : "release"}
                    </Badge>
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Services</CardTitle>
            <CardDescription>Runtime and backing services</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Service supervision arrives in Task 5.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sites</CardTitle>
            <CardDescription>Local .test domains</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Site management arrives in Task 9.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
