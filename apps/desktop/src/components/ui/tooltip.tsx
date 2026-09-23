import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/** §94: the tooltip waits 350–500ms before it appears. */
const SHOW_DELAY_MS = 400;

type TriggerProps = {
  onPointerEnter?: (event: PointerEvent) => void;
  onPointerLeave?: (event: PointerEvent) => void;
  onFocus?: (event: unknown) => void;
  onBlur?: (event: unknown) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  "aria-describedby"?: string;
};

/**
 * Tooltip for icon-only controls, unfamiliar actions and shortcuts (§94).
 *
 * Hover alone would put the label out of reach for keyboard users, so focus
 * opens it too — same delay, same content. The handlers are attached to the
 * trigger itself rather than a wrapper, so no extra element can disturb the
 * layout it sits in, and the bubble is positioned `fixed` from the trigger's
 * own box: neither the scrolling sidebar nor a card with `overflow-hidden`
 * can clip it.
 */
export function Tooltip({
  label,
  side = "bottom",
  children,
  className,
}: {
  label: ReactNode;
  side?: "top" | "bottom";
  children: ReactElement;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const place = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPosition({
      x: box.left + box.width / 2,
      y: side === "top" ? box.top : box.bottom,
    });
  }, [side]);

  const scheduleOpen = useCallback(
    (element: Element | null) => {
      anchor.current = element;
      clearTimer();
      timer.current = setTimeout(() => {
        place();
        setOpen(true);
      }, SHOW_DELAY_MS);
    },
    [clearTimer, place],
  );

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  // Unmounting with a tooltip open would leave the bubble hanging.
  useEffect(() => close, [close]);

  useEffect(() => {
    if (!open) {
      return;
    }
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const trigger = children as ReactElement<TriggerProps>;
  const element = cloneElement(trigger, {
    onPointerEnter: (event: PointerEvent) => {
      trigger.props.onPointerEnter?.(event);
      scheduleOpen(event.currentTarget as Element);
    },
    onPointerLeave: (event: PointerEvent) => {
      trigger.props.onPointerLeave?.(event);
      close();
    },
    onFocus: (event: unknown) => {
      trigger.props.onFocus?.(event);
      scheduleOpen((event as { currentTarget?: Element }).currentTarget ?? null);
    },
    onBlur: (event: unknown) => {
      trigger.props.onBlur?.(event);
      close();
    },
    onKeyDown: (event: KeyboardEvent) => {
      trigger.props.onKeyDown?.(event);
      if (event.key === "Escape") {
        close();
      }
    },
    "aria-describedby": open ? id : trigger.props["aria-describedby"],
  });

  return (
    <>
      {element}
      {open && position ? (
        <span
          role="tooltip"
          id={id}
          style={{ left: position.x, top: position.y }}
          className={cn(
            "pointer-events-none fixed z-50 -translate-x-1/2 rounded-sm border border-line-strong bg-elevated px-2 py-1 text-xs text-foreground",
            side === "top" ? "-translate-y-[calc(100%+6px)]" : "translate-y-1.5",
            className,
          )}
        >
          {label}
        </span>
      ) : null}
    </>
  );
}
