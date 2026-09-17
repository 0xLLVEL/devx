import { openPath } from "@tauri-apps/plugin-opener";

/**
 * Opens a directory in the OS file manager.
 *
 * Returns an error string when the open failed, `null` on success. The string
 * carries the underlying cause so the caller can show why instead of a bare
 * "it failed" — a button that reports failure for a folder the user can see on
 * disk is the complaint this exists to answer.
 *
 * DevX's own directories should prefer `ipc.revealManagedDir`, which validates
 * the path, creates it when missing, and opens it in one backend call; this
 * helper covers paths the backend cannot vouch for, such as a site's docroot
 * anywhere on the machine.
 */
export async function openFolder(path: string): Promise<string | null> {
  try {
    await openPath(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
