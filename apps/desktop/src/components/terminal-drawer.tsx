import { Maximize2, Minimize2, TerminalSquare, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { TerminalConsole } from "@/components/terminal-console";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The bottom terminal drawer (§31).
 *
 * Default 280px, resizable from 180px up to 70vh, with a full-screen option.
 * It holds no terminal state of its own: the transcript, the history and the
 * working directory belong to the session, so the drawer and the `/terminal`
 * page are two views of one terminal rather than two terminals.
 *
 * Deliberately absent: §31's tabs, shell picker, project picker and split.
 * `terminal_run` is a one-shot command runner — there is no shell session to
 * pick, no project concept anywhere in the backend, and one transcript cannot
 * be split into two.
 *
 * This is a panel, not a modal: it leaves page focus and the tab order alone,
 * and it sits below toasts and dialogs in the stack.
 */

export const TERMINAL_DRAWER_DEFAULT_HEIGHT = 280;
export const TERMINAL_DRAWER_MIN_HEIGHT = 180;
/** §31's upper bound, as a fraction of the window. */
const MAX_HEIGHT_RATIO = 0.7;
/** One keypress of the resize handle. */
const RESIZE_STEP = 24;

/** §31: the drawer grows to 70vh at most — past that, maximize it. */
export function terminalDrawerMaxHeight(): number {
  return Math.round(window.innerHeight * MAX_HEIGHT_RATIO);
}

export function TerminalDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(TERMINAL_DRAWER_DEFAULT_HEIGHT);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  /** Takes down the drag listeners, whether the pointer was released or not. */
  const endDrag = useRef<(() => void) | null>(null);

  const clamp = useCallback((value: number) => {
    const max = Math.max(terminalDrawerMaxHeight(), TERMINAL_DRAWER_MIN_HEIGHT);
    return Math.min(Math.max(value, TERMINAL_DRAWER_MIN_HEIGHT), max);
  }, []);

  useEffect(() => {
    const onResize = () => setHeight((current) => clamp(current));
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      // A drag that outlives the panel would keep a pair of window listeners
      // alive for the rest of the session.
      endDrag.current?.();
    };
  }, [clamp]);

  // The panel is `<section>`-shaped while open and absent while closed: a
  // hidden terminal that the tab order can still reach is a trap (§55).
  if (!open) {
    return null;
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startHeight: height };
    const onMove = (move: PointerEvent) => {
      const started = drag.current;
      if (!started) {
        return;
      }
      // The handle is on the top edge: dragging up makes the panel taller.
      setHeight(clamp(started.startHeight + (started.startY - move.clientY)));
    };
    const onUp = () => {
      drag.current = null;
      endDrag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    endDrag.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHeight((current) => clamp(current + RESIZE_STEP));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHeight((current) => clamp(current - RESIZE_STEP));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setHeight(TERMINAL_DRAWER_MIN_HEIGHT);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setHeight(clamp(terminalDrawerMaxHeight()));
    }
  };

  const sizeLabel = maximized ? "full screen" : `${height}px tall`;

  return (
    <section
      role="region"
      aria-label="Terminal"
      className={cn(
        "drawer-enter fixed inset-x-0 bottom-0 z-40 flex flex-col border-t border-line-strong bg-elevated shadow-lg",
        maximized && "top-0",
      )}
      style={maximized ? undefined : { height }}
    >
      {/* §31: the handle is a real separator, so it resizes from the keyboard
          too — arrows for a step, Home/End for the two bounds. */}
      {maximized ? null : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          aria-valuenow={height}
          aria-valuemin={TERMINAL_DRAWER_MIN_HEIGHT}
          aria-valuemax={terminalDrawerMaxHeight()}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={onHandleKeyDown}
          // §55: a 2px outline offset 2px around an 8px grabber is unreadable,
          // so focus is shown as the accent fill across the whole bar instead.
          // The whole bar is the control, so this is a stronger indicator than
          // the ring it replaces, not a removal of one.
          className="absolute inset-x-0 -top-1 h-2 cursor-row-resize touch-none hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none"
        />
      )}

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <TerminalSquare aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-caption tracking-wide text-ink-muted uppercase">
          Terminal
        </h2>
        {/* §55: the size is a state, and it is written down. */}
        <span className="truncate text-xs text-muted-foreground">{sizeLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip label={maximized ? "Restore the terminal" : "Full screen"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={maximized}
              aria-label="Full screen terminal"
              onClick={() => setMaximized((current) => !current)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </Tooltip>
          <Tooltip label="Close the terminal">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close the terminal"
              onClick={onClose}
            >
              <X />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <TerminalConsole transcriptClassName="min-h-24 flex-1" />
      </div>
    </section>
  );
}
