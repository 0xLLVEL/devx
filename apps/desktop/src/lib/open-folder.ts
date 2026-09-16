import { openPath } from "@tauri-apps/plugin-opener";

/**
 * Opens a directory in the OS file manager.
 *
 * Returns `false` when the shell refused (no Tauri runtime, missing path), so
 * the caller can say so instead of leaving a button that looks like it worked.
 * `reveal_managed_dir` is not an option here: it only accepts DevX's own
 * directories, and a site's docroot is wherever the user pointed it.
 */
export async function openFolder(path: string): Promise<boolean> {
  try {
    await openPath(path);
    return true;
  } catch {
    return false;
  }
}
