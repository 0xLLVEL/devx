import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pin, Play, Square, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { ipcEvents, ipc } from "@/lib/ipc";
import { useInstalledVersions } from "@/lib/queries";

type OutputLine = {
  runId: number;
  stream: string;
  text: string;
};

/**
 * Terminal page: run commands with the DevX runtimes on PATH.
 *
 * The backend streams each run's output as events; this page keeps one
 * scrolling transcript and a per-run exit badge. It is a command runner, not
 * a pty — interactive prompts are not supported.
 */
export function TerminalPage() {
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  const pathDirs = useQuery({ queryKey: ["terminal-path"], queryFn: ipc.terminalPath });
  const installed = useInstalledVersions();
  const queryClient = useQueryClient();

  const [pinComponent, setPinComponent] = useState("");
  const [pinVersion, setPinVersion] = useState("");

  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Default the working directory to the first site's docroot.
  useEffect(() => {
    if (cwd === "" && (sites.data?.length ?? 0) > 0) {
      setCwd(sites.data![0]!.docroot);
    }
  }, [sites.data, cwd]);

  // Subscribe once; every run's lines append to the transcript.
  useEffect(() => {
    const unlisten = ipcEvents.terminalOutput.listen((event) => {
      const { run_id, stream, text } = event.payload;
      setLines((current) => [...current, { runId: run_id, stream, text }]);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Keep the transcript pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const run = async () => {
    if (command.trim().length === 0 || running !== null) {
      return;
    }
    const previous = command;
    setHistory((current) => [previous, ...current.filter((c) => c !== previous)].slice(0, 50));
    setHistoryIndex(null);
    setLines((current) => [...current, { runId: -1, stream: "cmd", text: previous }]);
    setRunning(-2);
    setCommand("");
    try {
      const exit = await ipc.terminalRun(cwd.trim(), previous);
      setRunning(null);
      setLines((current) => [
        ...current,
        {
          runId: exit.run_id,
          stream: "exit",
          text: exit.code === null ? "terminated" : `exit code ${exit.code}`,
        },
      ]);
    } catch (err) {
      setRunning(null);
      setLines((current) => [
        ...current,
        {
          runId: -1,
          stream: "err",
          text: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  };

  const historyMove = (delta: number) => {
    if (history.length === 0) {
      return;
    }
    const next = (historyIndex ?? -1) + delta;
    if (next < 0 || next >= history.length) {
      return;
    }
    setHistoryIndex(next);
    setCommand(history[next] ?? "");
  };

  const pinVersionMutation = useMutation({
    mutationFn: ({ component, version }: { component: string; version: string }) =>
      ipc.terminalUseVersion(component, version),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["terminal-path"] });
    },
  });
  const unpinMutation = useMutation({
    mutationFn: (component: string) => ipc.terminalUnsetVersion(component),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["terminal-path"] });
    },
  });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-5">
      <PageHeader
          title="Run anything."
          description="One command at a time, with the DevX runtimes (php, composer, node, psql…) already on PATH."
          right={
            pathDirs.data ? (
              <span className="text-xs text-muted-foreground" data-selectable>
                {pathDirs.data.split(";").length} directories on PATH
              </span>
            ) : null
          }
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
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="terminal-cwd">Working directory</Label>
              <Input
                id="terminal-cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="C:\dev\myapp"
                spellCheck={false}
                list="site-docroots"
              />
              <datalist id="site-docroots">
                {(sites.data ?? []).map((site) => (
                  <option key={site.hostname} value={site.docroot} />
                ))}
              </datalist>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <div className="min-w-64 flex-1 space-y-1.5">
                <Label htmlFor="terminal-command">Command</Label>
                <Input
                  id="terminal-command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      historyMove(1);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      historyMove(-1);
                    }
                  }}
                  placeholder="php artisan queue:work"
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={running !== null}
                />
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={running !== null || command.trim().length === 0}
              >
                {running !== null ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                Run
              </Button>
              {history.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => historyMove(1)}
                  aria-label="Previous command"
                >
                  ↑
                </Button>
              ) : null}
            </form>
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
            {installed.data && installed.data.length > 0 ? (
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
                  <select
                    id="pin-component"
                    value={pinComponent}
                    onChange={(event) => {
                      setPinComponent(event.target.value);
                      setPinVersion("");
                    }}
                    className="h-9 rounded-sm border border-border bg-background px-2 text-sm"
                  >
                    <option value="">Choose…</option>
                    {[...new Set(installed.data.map((v) => v.component_id))].map(
                      (component) => (
                        <option key={component} value={component}>
                          {component}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pin-version">Version</Label>
                  <select
                    id="pin-version"
                    value={pinVersion}
                    onChange={(event) => setPinVersion(event.target.value)}
                    className="h-9 rounded-sm border border-border bg-background px-2 text-sm"
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
                  </select>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!pinComponent || !pinVersion || pinVersionMutation.isPending}
                >
                  Pin
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pinComponent || unpinMutation.isPending}
                  onClick={() => unpinMutation.mutate(pinComponent)}
                >
                  Unpin
                </Button>
                {pinVersionMutation.isSuccess ? (
                  <span className="text-xs text-muted-foreground">
                    Pinned {pinComponent} {pinVersion}.
                  </span>
                ) : null}
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing installed yet — install a component first to pin one of
                its versions here.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Output</CardTitle>
              {lines.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setLines([])}>
                  <Square />
                  Clear
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            <div
              ref={scrollRef}
              className="max-h-[50vh] min-h-32 overflow-y-auto rounded-sm border border-border bg-background/60 p-2"
              data-selectable
            >
              {lines.length === 0 ? (
                <p className="data-value text-muted-foreground">
                  No output yet. Commands run with the DevX runtimes on PATH;
                  try <code>php -v</code> or <code>composer --version</code>.
                </p>
              ) : (
                lines.map((line, index) =>
                  line.stream === "cmd" ? (
                    <p key={index} className="data-value mt-2 font-semibold text-foreground">
                      &gt; {line.text}
                    </p>
                  ) : line.stream === "exit" ? (
                    <p key={index} className="mt-1">
                      <Badge variant={line.text === "exit code 0" ? "success" : "warning"}>
                        {line.text}
                      </Badge>
                    </p>
                  ) : line.stream === "err" ? (
                    <p key={index} className="data-value text-destructive">
                      {line.text}
                    </p>
                  ) : (
                    <p key={index} className="data-value">{line.text}</p>
                  ),
                )
              )}
            </div>
          </CardContent>
        </Card>
      </div>
  );
}
