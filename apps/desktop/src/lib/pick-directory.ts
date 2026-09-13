import { open } from "@tauri-apps/plugin-dialog";

/**
 * Opens the native Windows folder picker and returns the chosen directory.
 *
 * Outside a Tauri runtime (tests) the dialog API is unavailable; the call
 * resolves to `null` and callers simply stay on their current value, the
 * same way cancelling the dialog does.
 */
export async function pickDirectory(current: string): Promise<string | null> {
  try {
    const selection = await open({
      directory: true,
      multiple: false,
      defaultPath: current.trim().length > 0 ? current : undefined,
    });
    if (typeof selection === "string") {
      return selection;
    }
    return null;
  } catch {
    return null;
  }
}
