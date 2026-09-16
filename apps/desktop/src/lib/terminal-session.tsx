import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { ipc, ipcEvents } from "@/lib/ipc";

/**
 * The terminal's one session (§31).
 *
 * A terminal is stateful: a transcript, a command history and a working
 * directory. `/terminal` shows it as a page and the bottom drawer shows it as
 * a panel, so that state cannot live in either of them — two copies would
 * drift the moment the user switched between the two, and one would silently
 * overwrite the other.
 *
 * So the session lives here, mounted once by the shell, and both surfaces are
 * views over it. Only one of them is ever mounted at a time: while the
 * Terminal page is on screen the drawer stays out of the way.
 *
 * The backend behind this is a one-shot command runner, not a pty: a command
 * starts, streams its output, and exits. There is no shell session to attach
 * to, which is why nothing here pretends otherwise.
 */

export type TerminalLine = {
  /** The run this line belongs to; `-1` for the echoed command and local errors. */
  runId: number;
  /** `cmd`, `exit`, `err`, or whatever standard stream the backend labelled. */
  stream: string;
  text: string;
};

export type TerminalSession = {
  cwd: string;
  setCwd: (value: string) => void;
  /** The command field's draft, shared so switching surfaces keeps what was typed. */
  command: string;
  setCommand: (value: string) => void;
  lines: TerminalLine[];
  running: boolean;
  historyLength: number;
  /** Runs the drafted command in the drafted directory; a no-op while one runs. */
  run: () => Promise<void>;
  clear: () => void;
  /** Walks the command history: `1` is the previous command, `-1` the next. */
  historyMove: (delta: number) => void;
  /** Set when the output stream could not be subscribed to; output is lost if it is. */
  streamError: string | null;
};

const TerminalSessionContext = createContext<TerminalSession | null>(null);

export function useTerminalSession(): TerminalSession {
  const session = useContext(TerminalSessionContext);
  if (!session) {
    throw new Error("useTerminalSession needs a TerminalSessionProvider above it");
  }
  return session;
}

export function TerminalSessionProvider({ children }: { children: ReactNode }) {
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // One subscription for the whole app. Registering it per surface would drop
  // the output of a command that is still running when the user switches from
  // the drawer to the page.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    ipcEvents.terminalOutput
      .listen((event) => {
        const { run_id, stream, text } = event.payload;
        setLines((current) => [...current, { runId: run_id, stream, text }]);
      })
      .then(
        (off) => {
          if (cancelled) {
            // Unmounted before the listener was registered (StrictMode, a
            // navigation): take it straight back down.
            off();
            return;
          }
          unlisten = off;
        },
        (error: unknown) => {
          if (cancelled) {
            return;
          }
          // §131 Rule 18: a console that cannot receive output says so rather
          // than looking like a command that printed nothing.
          setStreamError(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(async () => {
    const entered = command.trim();
    if (entered === "" || running) {
      return;
    }
    setHistory((current) =>
      [entered, ...current.filter((entry) => entry !== entered)].slice(0, 50),
    );
    setHistoryIndex(null);
    setLines((current) => [
      ...current,
      { runId: -1, stream: "cmd", text: entered },
    ]);
    setRunning(true);
    setCommand("");
    try {
      const exit = await ipc.terminalRun(cwd.trim(), entered);
      setLines((current) => [
        ...current,
        {
          runId: exit.run_id,
          stream: "exit",
          text: exit.code === null ? "terminated" : `exit code ${exit.code}`,
        },
      ]);
    } catch (error) {
      setLines((current) => [
        ...current,
        {
          runId: -1,
          stream: "err",
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setRunning(false);
    }
  }, [command, cwd, running]);

  const clear = useCallback(() => setLines([]), []);

  const historyMove = useCallback(
    (delta: number) => {
      if (history.length === 0) {
        return;
      }
      const next = (historyIndex ?? -1) + delta;
      if (next < 0 || next >= history.length) {
        return;
      }
      setHistoryIndex(next);
      setCommand(history[next] ?? "");
    },
    [history, historyIndex],
  );

  const value = useMemo<TerminalSession>(
    () => ({
      cwd,
      setCwd,
      command,
      setCommand,
      lines,
      running,
      historyLength: history.length,
      run,
      clear,
      historyMove,
      streamError,
    }),
    [cwd, command, lines, running, history.length, run, clear, historyMove, streamError],
  );

  return (
    <TerminalSessionContext.Provider value={value}>
      {children}
    </TerminalSessionContext.Provider>
  );
}
