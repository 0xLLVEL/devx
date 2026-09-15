import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Opens a URL in the user's default browser.
 *
 * Outside a Tauri runtime (tests) the plugin is unavailable; the call
 * resolves silently instead of throwing, so callers need no special casing.
 */
export async function openInBrowser(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    // No Tauri runtime (or the OS refused): nothing to do in the UI.
  }
}
