import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AmbientBackground } from "@/components/ambient-background";
import { CommandPalette } from "@/components/command-palette";
import { Sidebar } from "@/components/sidebar";
import { TerminalDrawer } from "@/components/terminal-drawer";
import { Topbar } from "@/components/topbar";
import { useAppCommands, useStartAllServices } from "@/lib/commands";
import { NAV_SHORTCUTS } from "@/lib/navigation";
import { TerminalSessionProvider } from "@/lib/terminal-session";

/**
 * Application shell (§4): topbar across the top, sidebar and content row
 * under it. The ambient background belongs to the content region only, so the
 * chrome stays on solid surfaces.
 *
 * Collapse is UI state, remembered per machine like a window size — it is a
 * layout preference, not application configuration, so it does not go near
 * config.toml.
 *
 * The terminal session (§31) is provided here, once, because the console has
 * two homes — this shell's drawer and the `/terminal` page — and a terminal
 * split across two owners would diverge the first time the user switched.
 */

const COLLAPSE_STORAGE_KEY = "devx.sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const commands = useAppCommands();
  const startAllServices = useStartAllServices();

  // §31: on `/terminal` the page *is* the terminal. The drawer stands down
  // there instead of showing the same session twice, and its shortcut stands
  // down with it — a key that silently does nothing is worse than no key.
  const drawerAvailable = pathname !== "/terminal";

  // The command closes over live service state, so it is a new function on
  // most renders. The keydown listener reads it through a ref: re-subscribing
  // the window listener on every metrics poll would be a real cost, and the
  // key would still do the same thing.
  const startAllRef = useRef(startAllServices);
  useEffect(() => {
    startAllRef.current = startAllServices;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // Losing the preference is not worth failing a render over.
    }
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // §56: shortcuts must never fight the terminal or any other text input.
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // §56's Ctrl+T opens a terminal; here that is the drawer.
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "t") {
        if (!drawerAvailable) {
          return;
        }
        event.preventDefault();
        setTerminalOpen((current) => !current);
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === ",") {
        event.preventDefault();
        navigate("/settings");
        return;
      }
      // §56's Ctrl+Shift+S. It is bound unconditionally: when there is nothing
      // to start the command says so, rather than the key quietly doing
      // nothing (which is the failure mode the drawer shortcut above avoids by
      // standing down only where it is documented to).
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
  }, [navigate, drawerAvailable]);

  return (
    <TerminalSessionProvider>
      {/* `isolate` gives the window its own stacking context, so the ambient
          layer can sit above the app background and below everything in flow. */}
      <div className="relative isolate flex h-full flex-col bg-app">
        <AmbientBackground />

        <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => setCollapsed((current) => !current)}
          onOpenSearch={() => setPaletteOpen(true)}
          terminalOpen={terminalOpen && drawerAvailable}
          onToggleTerminal={() => setTerminalOpen((current) => !current)}
        />

        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={collapsed} />
          {/* Transparent on purpose: the ambient layer shows through it. */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="relative">{children}</div>
          </main>
        </div>

        {/* Rendered even while closed: it then keeps the height the user
            dragged it to, without mounting a second console. */}
        <TerminalDrawer
          open={terminalOpen && drawerAvailable}
          onClose={() => setTerminalOpen(false)}
        />

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={commands}
        />
      </div>
    </TerminalSessionProvider>
  );
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
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
