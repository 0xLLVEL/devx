import { afterEach, describe, expect, it } from "vitest";

import {
  applyResolvedTheme,
  cacheTheme,
  readCachedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/** The theme runtime's pure half: what the OS preference means, and what ends
 *  up on the document. The React half only decides when to call these. */
describe("resolveTheme", () => {
  it("follows the OS while the setting says system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS once a theme is chosen explicitly", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("applyResolvedTheme", () => {
  afterEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("puts the dark class on the root element", () => {
    applyResolvedTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    // Native widgets and the dialog backdrop follow this, not the class.
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("removes the dark class when the theme is light", () => {
    applyResolvedTheme("dark");
    applyResolvedTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("the cached theme mirror", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a theme for the next cold start", () => {
    cacheTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readCachedTheme()).toBe("dark");
  });

  it("ignores a value it does not recognise", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");
    expect(readCachedTheme()).toBeNull();
  });
});
