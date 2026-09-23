import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { CommandPalette } from "@/components/command-palette";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { useAppCommands, useStartAllServices } from "@/lib/commands";
import { NAV_SHORTCUTS } from "@/lib/navigation";

/**
 * Application shell (preview `.app`): sidebar full height on the left, an
 * optional rail column sites portal their list into, topbar above the main
 * content only. Flat surfaces and hairline borders — no ambient layer.
 */

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const commands = useAppCommands();
  const startAllServices = useStartAllServices();

  // The command closes over live service state, so it is a new function on
  // most renders. The keydown listener reads it through a ref: re-subscribing
  // the window listener on every metrics poll would be a real cost.
  const startAllRef = useRef(startAllServices);
  useEffect(() => {
    startAllRef.current = startAllServices;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // §56: shortcuts must never fight a text input.
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        navigate("/settings");
        return;
      }
      // §56's Ctrl+Shift+S. Bound unconditionally: when there is nothing to
      // start the command says so, rather than the key quietly doing nothing.
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key === "s") {
        event.preventDefault();
        startAllRef.current.start();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.shiftKey) {
        const to = NAV_SHORTCUTS[event.key];
        if (to) {
          event.preventDefault();
          navigate(to);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[999] focus:not-sr-only focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <div className="grid h-full grid-cols-[220px_auto_minmax(0,1fr)] grid-rows-[72px_minmax(0,1fr)] bg-app">
        <Sidebar className="col-start-1 row-span-2" />
        {/* Sites portals its list here; empty → #shell-rail:empty hides it. */}
        <aside
          id="shell-rail"
          aria-label="Page rail"
          className="col-start-2 row-span-2 min-h-0 overflow-y-auto border-r border-line-subtle bg-surface"
        />
        <Topbar className="col-start-3 row-start-1" onOpenSearch={() => setPaletteOpen(true)} />
        <main
          id="main"
          tabIndex={-1}
          className="col-start-3 row-start-2 min-h-0 min-w-0 overflow-y-auto outline-none"
        >
          <div className="relative">{children}</div>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </>
  );
}

/** True while the user is entering text, where global shortcuts must stand down. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
