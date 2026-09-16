import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Package, Pin, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { TerminalConsole } from "@/components/terminal-console";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ipc } from "@/lib/ipc";
import { useInstalledVersions } from "@/lib/queries";

/**
 * Terminal page (§31): the console, with room around it.
 *
 * The console itself is shared with the bottom drawer and reads the app-wide
 * session, so the transcript started in the drawer is the very same one shown
 * here — never a second terminal with its own history. What this page adds is
 * the thing that needs space: pinning a component version for every command.
 */
export function TerminalPage() {
  const installed = useInstalledVersions();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [pinComponent, setPinComponent] = useState("");
  const [pinVersion, setPinVersion] = useState("");
  const pinVersionMutation = useMutation({
    mutationFn: ({ component, version }: { component: string; version: string }) =>
      ipc.terminalUseVersion(component, version),
    onError: (error: Error) => {
      toast.error("Could not pin the version", { details: error.message });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["terminal-path"] });
    },
  });
  const unpinMutation = useMutation({
    mutationFn: (component: string) => ipc.terminalUnsetVersion(component),
    onSuccess: async (_result, component) => {
      toast.success(`Unpinned ${component}`);
      await queryClient.invalidateQueries({ queryKey: ["terminal-path"] });
    },
    onError: (error: Error) => {
      toast.error("Could not unpin the version", { details: error.message });
    },
  });

  const pinError =
    pinVersionMutation.error !== null
      ? {
          title: "Could not pin the version.",
          message: pinVersionMutation.error.message,
        }
      : unpinMutation.error !== null
        ? {
            title: "Could not unpin the version.",
            message: unpinMutation.error.message,
          }
        : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-5">
      <PageHeader
        title="Run anything."
        description="One command at a time, with the DevX runtimes (php, composer, node, psql…) already on PATH."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
            Command
          </CardTitle>
          <CardDescription>
            One command at a time, streamed as it runs. Interactive prompts
            are not supported.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TerminalConsole transcriptClassName="max-h-[50vh] min-h-32" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Pin className="size-4 text-muted-foreground" aria-hidden />
            Pin a version for commands
          </CardTitle>
          <CardDescription>
            Writes PATH shims (the same ones <code>devx use</code> creates) so
            the chosen version wins in every terminal command.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {installed.isPending ? (
            <div className="space-y-2" role="status">
              <span className="sr-only">Loading the installed components…</span>
              {[0, 1].map((row) => (
                <span
                  key={row}
                  aria-hidden
                  className="block h-9 animate-pulse rounded-sm bg-secondary"
                />
              ))}
            </div>
          ) : installed.isError ? (
            <Callout variant="destructive" title="Could not read the installed components.">
              <p>{installed.error.message}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => void installed.refetch()}
              >
                Try again
              </Button>
            </Callout>
          ) : installed.data && installed.data.length > 0 ? (
            <>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pinComponent && pinVersion) {
                    pinVersionMutation.mutate({
                      component: pinComponent,
                      version: pinVersion,
                    });
                  }
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="pin-component">Component</Label>
                  <Select
                    id="pin-component"
                    value={pinComponent}
                    onChange={(event) => {
                      setPinComponent(event.target.value);
                      setPinVersion("");
                    }}
                  >
                    <option value="">Choose…</option>
                    {[...new Set(installed.data.map((v) => v.component_id))].map(
                      (component) => (
                        <option key={component} value={component}>
                          {component}
                        </option>
                      ),
                    )}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pin-version">Version</Label>
                  <Select
                    id="pin-version"
                    value={pinVersion}
                    onChange={(event) => setPinVersion(event.target.value)}
                    disabled={!pinComponent}
                  >
                    <option value="">Choose…</option>
                    {installed.data
                      .filter((v) => v.component_id === pinComponent)
                      .map((v) => (
                        <option key={v.version} value={v.version}>
                          {v.version}
                        </option>
                      ))}
                  </Select>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!pinComponent || !pinVersion || pinVersionMutation.isPending}
                >
                  {pinVersionMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Pin
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pinComponent || unpinMutation.isPending}
                  onClick={() => unpinMutation.mutate(pinComponent)}
                >
                  {unpinMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Unpin
                </Button>
                {pinVersionMutation.isSuccess ? (
                  <span className="text-xs text-muted-foreground">
                    Pinned {pinComponent} {pinVersion}.
                  </span>
                ) : null}
              </form>

              {pinError ? (
                /* §39/§131 Rule 18: the form is still on screen, so a rejected
                   pin or unpin is stated beside it and not only in a toast. */
                <Callout variant="destructive" className="mt-3" title={pinError.title}>
                  <p>{pinError.message}</p>
                </Callout>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={<Package />}
              title="Nothing installed yet."
              description="Install a component first to pin one of its versions here."
              action={
                <Link
                  to="/components"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Open Components
                </Link>
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
