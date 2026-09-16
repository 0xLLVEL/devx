import { createContext, useContext, type ReactNode } from "react";

import { useThemeRuntime } from "@/lib/theme";
import type { Theme } from "@/lib/ipc";

type ThemeContextValue = ReturnType<typeof useThemeRuntime>;

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Applies the configured theme (§9) and shares it with the chrome that offers
 * to change it. Mounted once, above the shell, so the whole window switches
 * together instead of per-page (§74).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const runtime = useThemeRuntime();
  return <ThemeContext.Provider value={runtime}>{children}</ThemeContext.Provider>;
}

/** The live theme and its setter. Throws if used outside the provider. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}

/** Cycles System → Light → Dark, the order §46 lists the choices in. */
export const THEME_CYCLE: readonly Theme[] = ["system", "light", "dark"];

export function nextTheme(current: Theme): Theme {
  const index = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? "system";
}

/** §46's labels, including the resolved value for the "system" case. */
export function themeLabel(theme: Theme): string {
  if (theme === "system") {
    return "System";
  }
  return theme === "dark" ? "Dark" : "Light";
}
