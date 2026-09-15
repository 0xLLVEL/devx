import { open, save } from "@tauri-apps/plugin-dialog";

/**
 * Native Windows file pickers for the database tools.
 *
 * Outside a Tauri runtime (tests) the dialog API is unavailable; the calls
 * resolve to `null` the same way cancelling the dialog does, so callers can
 * simply skip the action.
 */

/** Picks an existing `.sql` dump to import; `null` when cancelled. */
export async function pickSqlFile(): Promise<string | null> {
  try {
    const selection = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "SQL dump", extensions: ["sql"] }],
    });
    return typeof selection === "string" ? selection : null;
  } catch {
    return null;
  }
}

/** Picks a `.csv` target path for an export; `null` when cancelled. */
export async function pickCsvSavePath(suggestedName: string): Promise<string | null> {
  try {
    const selection = await save({
      defaultPath: suggestedName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    return typeof selection === "string" ? selection : null;
  } catch {
    return null;
  }
}
