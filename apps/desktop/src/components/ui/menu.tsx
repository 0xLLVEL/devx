import { Ellipsis, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The secondary actions of one entity, kept off the surface so the row stays
 * readable and the primary action keeps its place (§90, §91).
 *
 * Two entry points share one panel:
 *
 * - [`OverflowMenu`] — the `…` trigger. It is the keyboard route, and the one
 *   that stays visible for anyone who never right-clicks.
 * - [`useContextMenu`] — the §47 context menu, opened on the entity itself.
 *   Both stay wired on the same rows, so the pointer shortcut is never the
 *   only way in (§55).
 *
 * The panel is portalled and positioned `fixed` for the same reason the
 * tooltip is: a menu opened inside a table that scrolls or clips must not be
 * cut in half by it. The panel is a `menu` of `menuitem` buttons, `Esc`
 * closes it, and `Tab` leaves rather than trapping.
 */

export type MenuItem = {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** §48/§47: a destructive entry states its intent in the danger tone. */
  destructive?: boolean;
  disabled?: boolean;
};

type Position = { left: number; top: number };

/**
 * A menu open behind a click somewhere else is a menu the user cannot get rid
 * of. Scrolling it away from its anchor would leave it pointing at nothing, so
 * any scroll closes it as well.
 */
function useMenuDismissal({
  open,
  close,
  panel,
  keep,
}: {
  open: boolean;
  close: () => void;
  panel: RefObject<HTMLDivElement | null>;
  /** A second element that counts as inside — an overflow trigger, say. */
  keep?: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !keep?.current?.contains(target)) {
        close();
      }
    };
    const onScrollOrResize = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close, panel, keep]);
}

/** Arrow-key movement inside an open panel, skipping disabled entries. */
function moveFocus(panel: HTMLElement | null, offset: number) {
  const nodes = Array.from(
    panel?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    ) ?? [],
  );
  if (nodes.length === 0) {
    return;
  }
  const current = nodes.findIndex((node) => node === document.activeElement);
  const next = (current + offset + nodes.length) % nodes.length;
  nodes[next]?.focus();
}

/** The panel both entry points render: same markup, same entries, both ways in. */
function MenuPanel({
  label,
  items,
  position,
  panel,
  onPick,
  onKeyDown,
}: {
  label: string;
  items: readonly MenuItem[];
  position: Position | null;
  panel: RefObject<HTMLDivElement | null>;
  onPick: (item: MenuItem) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      className="fixed z-50 min-w-44 rounded-lg border border-line-strong bg-elevated p-1"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => onPick(item)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:opacity-50",
            item.destructive
              ? "text-destructive hover:bg-destructive-soft"
              : "text-foreground hover:bg-hover",
          )}
        >
          {item.icon ? (
            <item.icon className="size-4 shrink-0" aria-hidden />
          ) : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function OverflowMenu({
  label,
  items,
  align = "end",
}: {
  /** Accessible name for the icon-only trigger (§55). */
  label: string;
  items: readonly MenuItem[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (refocus) {
      trigger.current?.focus();
    }
  }, []);

  // `useMenuDismissal` must not re-register on every render, so it gets a
  // stable callback that only ever closes without moving focus.
  const dismiss = useCallback(() => close(false), [close]);
  useMenuDismissal({
    open,
    close: dismiss,
    panel,
    keep: trigger as RefObject<HTMLElement | null>,
  });

  // Place after the panel exists but before the browser paints it, so a menu
  // never appears at the top-left corner first.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const anchor = trigger.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!anchor || !box) {
      return;
    }
    const below = window.innerHeight - anchor.bottom;
    // Flip above the trigger when the panel would run off the bottom edge.
    const top =
      below < box.height + 12 ? anchor.top - box.height - 4 : anchor.bottom + 4;
    const left = align === "end" ? anchor.right - box.width : anchor.left;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - box.width - 8)),
      top: Math.max(8, top),
    });
  }, [open, align, items.length]);

  const openMenu = useCallback((focusFirst: boolean) => {
    setOpen(true);
    if (focusFirst) {
      // The panel is not mounted yet; focus on the next frame.
      requestAnimationFrame(() => {
        panel.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
          ?.focus();
      });
    }
  }, []);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // A click-opened menu leaves focus on the trigger, so Escape has to be
    // answered here as well as in the panel.
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(true);
    }
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(panel.current, 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(panel.current, -1);
      return;
    }
    if (event.key === "Tab") {
      // Let the browser move on: the panel is not a focus trap.
      close(false);
    }
  };

  return (
    <>
      {/* §94/§123: `…` is icon-only, so it names itself on hover and focus
          like every other icon-only control in the app. */}
      <Tooltip label={label}>
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => (open ? close(false) : openMenu(false))}
          onKeyDown={onTriggerKeyDown}
          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Tooltip>

      {open
        ? createPortal(
            <MenuPanel
              label={label}
              items={items}
              position={position}
              panel={panel}
              onPick={(item) => {
                close(true);
                item.onSelect();
              }}
              onKeyDown={onPanelKeyDown}
            />,
            document.body,
          )
        : null}
    </>
  );
}

export type ContextMenu = {
  /** Goes on the entity: it replaces the browser's own menu. */
  onContextMenu: (event: ReactMouseEvent) => void;
  /** Rendered wherever it reads best — it is a portal, so it occupies no space. */
  panel: ReactNode;
};

/**
 * §47's context menu: the same entries an entity already offers through its
 * overflow menu, opened by right-clicking the entity itself.
 *
 * Callers should hand over the very array the row feeds its `OverflowMenu`, so
 * the two entry points cannot drift apart. The first entry takes focus, which
 * is what makes arrow keys and `Esc` work without a second click; the element
 * that had focus when the menu opened gets it back.
 */
export function useContextMenu({
  label,
  items,
}: {
  label: string;
  items: readonly MenuItem[];
}): ContextMenu {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const pointer = useRef<Position>({ left: 0, top: 0 });
  const returnTo = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) {
      target.focus();
    }
  }, []);

  useMenuDismissal({ open, close, panel });

  // Measured once the panel is in the DOM, so it gets pulled back inside the
  // window rather than hanging off the right or bottom edge.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const box = panel.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPosition(
      clampToViewport(pointer.current.left, pointer.current.top, box),
    );
  }, [open, items.length]);

  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    pointer.current = { left: event.clientX, top: event.clientY };
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement ? active : null;
    setPosition(null);
    setOpen(true);
    requestAnimationFrame(() => {
      panel.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
        ?.focus();
    });
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(panel.current, 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(panel.current, -1);
      return;
    }
    if (event.key === "Tab") {
      // Not a focus trap: the tab order continues behind the menu.
      close();
    }
  };

  return {
    onContextMenu,
    panel: open
      ? createPortal(
          <MenuPanel
            label={label}
            items={items}
            position={position}
            panel={panel}
            onPick={(item) => {
              close();
              item.onSelect();
            }}
            onKeyDown={onPanelKeyDown}
          />,
          document.body,
        )
      : null,
  };
}

/** Keeps a pointer-positioned panel on screen. */
function clampToViewport(left: number, top: number, box: DOMRect): Position {
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - box.width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)),
  };
}
