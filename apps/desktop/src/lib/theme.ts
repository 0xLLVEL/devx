import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { ipc, type Config, type Theme } from "@/lib/ipc";

/**
 * Theme runtime (§9, §74).
 *
 * `config.general.theme` is the source of truth and it lives in Rust, so the
 * UI never invents a theme: it reads the setting, resolves `system` against
 * the OS preference, and toggles the single `dark` class that the token layer
 * keys off. The applied value is mirrored into `localStorage` only so the
 * first paint after a restart is already correct — see the inline script in
 * index.html, which runs long before IPC answers.
 */

export const THEME_STORAGE_KEY = "devx.theme";

export type ResolvedTheme = "light" | "dark";

/** Every value the backend can send, used to validate the cached mirror. */
const THEMES: readonly Theme[] = ["system", "light", "dark"];

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** Resolves the configured theme against the OS preference (§9). */
export function resolveTheme(theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return theme;
}

/** Reads the theme the last session painted with, when it was recorded. */
export function readCachedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    // Storage can be unavailable; the app still themes, it just flashes on
    // the first paint of a cold start.
    return null;
  }
}

/** Records the configured theme for the next cold start. */
export function cacheTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // See readCachedTheme.
  }
}

/**
 * Puts a resolved theme on the document.
 *
 * One class, one place: every colour in the app is a token that responds to
 * it (§73), so nothing else needs to know the theme exists.
 */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // Native surfaces — scrollbars, form widgets, the <dialog> backdrop — follow
  // this rather than the class.
  root.style.colorScheme = resolved;
  root.dataset.theme = resolved;
}

/** True when the OS currently asks for a dark colour scheme. */
export function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The configured theme, resolved and applied, plus the way to change it.
 *
 * `theme` is what config.toml says; `resolved` is what is on screen. The
 * distinction matters for the topbar control, which shows all three choices
 * but only one of them wins.
 */
export function useThemeRuntime() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: ipc.configGet });
  const [osDark, setOsDark] = useState(systemPrefersDark);

  // Falling back to the cached mirror keeps the first render after restart in
  // the last known theme until config.toml arrives.
  const theme: Theme = config.data?.general.theme ?? readCachedTheme() ?? "system";
  const resolved = resolveTheme(theme, osDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setOsDark(media.matches);
    const listener = (event: MediaQueryListEvent) => setOsDark(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  // Applied in a layout effect so the class is on the document before the
  // browser paints this render — no flash of the wrong theme.
  useLayoutEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (config.data) {
      cacheTheme(theme);
    }
  }, [config.data, theme]);

  const setThemeMutation = useMutation({
    mutationFn: (next: Theme) => {
      const current = queryClient.getQueryData<Config>(["config"]);
      if (!current) {
        throw new Error("Configuration has not loaded yet.");
      }
      // A targeted patch persisted through the same command the Settings page
      // uses, so the two entry points cannot drift apart.
      return ipc.configSet({
        ...current,
        general: { ...current.general, theme: next },
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["config"], saved);
    },
  });

  // `mutate` is stable, so callers can depend on this instead of re-creating
  // their own callbacks every render.
  const { mutate } = setThemeMutation;
  const setTheme = useCallback((next: Theme) => mutate(next), [mutate]);

  return {
    theme,
    resolved,
    /** False until config.toml has been read; the control waits for it. */
    ready: config.data !== undefined,
    setTheme,
    saving: setThemeMutation.isPending,
    error: setThemeMutation.error,
  };
}
