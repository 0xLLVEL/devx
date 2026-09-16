import { useQuery } from "@tanstack/react-query";
import { Loader2, Play, Square, TerminalSquare } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { ipc } from "@/lib/ipc";
import { useTerminalSession } from "@/lib/terminal-session";
import { cn } from "@/lib/utils";

/**
 * The terminal console: working directory, command line, transcript.
 *
 * This is the *only* terminal surface in the app (§31). The page puts it on a
 * card and the drawer puts it in a panel; both read the same session, and
 * exactly one of them is mounted at a time. Everything that makes a command
 * run — the draft, the history, the transcript — belongs to
 * [`useTerminalSession`](@/lib/terminal-session), not to this component.
 *
 * The backend is a one-shot runner: one command at a time, no interactive
 * prompt. §31's shell picker, project picker, tabs and split are not here
 * because nothing behind them exists.
 */
export function TerminalConsole({
  transcriptClassName,
  toolbar,
}: {
  /** The transcript box; the drawer lets it fill the panel. */
  transcriptClassName?: string;
  /** Extra controls for the console's header row — the drawer's window buttons. */
  toolbar?: ReactNode;
}) {
  const session = useTerminalSession();
  const sites = useQuery({ queryKey: ["sites"], queryFn: ipc.siteList });
  const pathDirs = useQuery({ queryKey: ["terminal-path"], queryFn: ipc.terminalPath });
  const scrollRef = useRef<HTMLDivElement>(null);
  const cwdId = useId();
  const commandId = useId();
  const docrootsId = useId();

  // First run: point the working directory at the first site, which is where
  // most commands are aimed. Afterwards the session owns it.
  const { cwd, setCwd, lines } = session;
  useEffect(() => {
    if (cwd === "" && (sites.data?.length ?? 0) > 0) {
      setCwd(sites.data![0]!.docroot);
    }
  }, [cwd, setCwd, sites.data]);

  // Keep the transcript pinned to the bottom.
  useEffect(() => {
    const area = scrollRef.current;
    if (area) {
      area.scrollTop = area.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor={cwdId}>Working directory</Label>
          <Input
            id={cwdId}
            value={session.cwd}
            onChange={(event) => session.setCwd(event.target.value)}
            placeholder="C:\dev\myapp"
            spellCheck={false}
            list={docrootsId}
          />
          <datalist id={docrootsId}>
            {(sites.data ?? []).map((site) => (
              <option key={site.hostname} value={site.docroot} />
            ))}
          </datalist>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void session.run();
          }}
        >
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label htmlFor={commandId}>Command</Label>
            <Input
              id={commandId}
              value={session.command}
              onChange={(event) => session.setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  session.historyMove(1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  session.historyMove(-1);
                }
              }}
              placeholder="php artisan queue:work"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              disabled={session.running}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={session.running || session.command.trim().length === 0}
          >
            {session.running ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
          {session.historyLength > 0 ? (
            <Tooltip label="Previous command">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => session.historyMove(1)}
                aria-label="Previous command"
              >
                ↑
              </Button>
            </Tooltip>
          ) : null}
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-selectable>
          {/* An unread PATH must not be described as if it had been read
              (§131 Rule 17). */}
          {pathDirs.isError
            ? "Could not read PATH."
            : pathDirs.isPending
              ? "Reading PATH…"
              : pathDirs.data
                ? `${pathDirs.data.split(";").length} directories on PATH`
                : "PATH is empty."}
        </span>
        <div className="flex items-center gap-2">
          {toolbar}
          {lines.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={session.clear}>
              <Square />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {session.streamError ? (
        // §39: what failed, and the backend's own text as the detail.
        <Callout variant="warning" title="Output is not streaming.">
          <p>{session.streamError}</p>
        </Callout>
      ) : null}

      <div
        ref={scrollRef}
        className={cn(
          // §97: output is preformatted, and a long token wraps instead of
          // running out of the box.
          "min-h-0 overflow-y-auto rounded-sm border border-border bg-background/60 p-2 whitespace-pre-wrap break-words",
          transcriptClassName,
        )}
        data-selectable
      >
        {lines.length === 0 ? (
          <EmptyState
            icon={<TerminalSquare />}
            title={
              <>
                No output yet. Commands run with the DevX runtimes on PATH; try{" "}
                <code>php -v</code> or <code>composer --version</code>.
              </>
            }
          />
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
              <p key={index} className="data-value">
                {line.text}
              </p>
            ),
          )
        )}
      </div>
    </div>
  );
}
