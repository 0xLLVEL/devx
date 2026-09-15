//! Central log viewer commands.

use crate::state::AppState;
use devx_core::{AppPaths, Error};
use tauri::State;

/// One log file in the DevX logs directory, for the log viewer.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct LogFileInfo {
    /// File name inside the logs directory, e.g. `nginx.log.1`.
    pub file_name: String,
    /// Service the log belongs to (`nginx`, `php-pool-8.4.25`, …).
    pub service_id: String,
    /// Whether this is a rotated (previous-generation) file.
    pub rotated: bool,
    /// Size on disk, in bytes.
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
    /// Last modification as Unix seconds; `null` when unavailable.
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_unix: Option<u64>,
}

/// Lists every log file DevX has written, newest first.
#[tauri::command]
#[specta::specta]
pub fn logs_list(state: State<'_, AppState>) -> Result<Vec<LogFileInfo>, Error> {
    let dir = state.paths.logs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some((service_id, rotated)) = parse_log_file_name(&file_name) else {
            continue;
        };

        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_unix = metadata.and_then(|m| m.modified().ok()).and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        });

        files.push(LogFileInfo {
            file_name,
            service_id,
            rotated,
            size_bytes,
            modified_unix,
        });
    }

    files.sort_by(|a, b| {
        b.modified_unix
            .cmp(&a.modified_unix)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    Ok(files)
}

/// The tail of one log file, for the log viewer.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct LogFileContent {
    /// The file that was read.
    pub file_name: String,
    /// Last `tail` lines, in file order.
    pub lines: Vec<String>,
    /// Whether the file has more lines than were returned.
    pub truncated: bool,
}

/// Reads the last `tail` lines of one DevX log file.
///
/// The file name is validated against the logs directory so the viewer can
/// never be coaxed into reading anything else on the machine.
#[tauri::command]
#[specta::specta]
pub fn logs_read(
    state: State<'_, AppState>,
    file_name: String,
    tail: u32,
) -> Result<LogFileContent, Error> {
    let path = log_file_path(&state.paths, &file_name)?;

    let body = std::fs::read_to_string(&path).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to read {}: {err}", path.display()),
        )
    })?;

    let tail = tail.clamp(1, 5_000) as usize;
    let lines: Vec<&str> = body.lines().collect();
    let truncated = lines.len() > tail;
    let start = lines.len().saturating_sub(tail);

    Ok(LogFileContent {
        file_name,
        lines: lines[start..].iter().map(|line| line.to_string()).collect(),
        truncated,
    })
}

/// Resolves a validated log file name to its path under the logs directory.
fn log_file_path(paths: &AppPaths, file_name: &str) -> Result<std::path::PathBuf, Error> {
    let Some((_, _)) = parse_log_file_name(file_name) else {
        return Err(Error::invalid_input(format!(
            "`{file_name}` is not a DevX log file name"
        )));
    };

    let path = paths.logs_dir().join(file_name);
    if !path.starts_with(paths.logs_dir()) {
        return Err(Error::invalid_input(format!(
            "`{file_name}` escapes the logs directory"
        )));
    }
    Ok(path)
}

/// Splits `nginx.log.1` into its service id and rotated flag.
fn parse_log_file_name(file_name: &str) -> Option<(String, bool)> {
    if let Some(service_id) = file_name.strip_suffix(".log.1") {
        validate_log_component(service_id)?;
        return Some((service_id.to_owned(), true));
    }
    if let Some(service_id) = file_name.strip_suffix(".log") {
        validate_log_component(service_id)?;
        return Some((service_id.to_owned(), false));
    }
    None
}

/// Log file name components are supervisor ids: filename-safe, no traversal.
fn validate_log_component(component: &str) -> Option<()> {
    if component.is_empty()
        || !component
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(())
}
