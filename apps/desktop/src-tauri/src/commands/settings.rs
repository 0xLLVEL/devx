//! Settings helpers: autostart, reveal, update check.

use crate::state::AppState;
use devx_core::Error;
use tauri::Manager as _;
use tauri::State;

/// Reveals a DevX directory in File Explorer.
///
/// Restricted to the managed directories (and anything beneath them, such as a
/// single service's config folder) so the command cannot be used to open
/// arbitrary paths from the webview.
///
/// The directory is created first when missing: several of DevX's folders (a
/// service's `service-config/<id>`, for instance) only come into existence
/// after the service has run once, and a button that reports failure for a
/// folder DevX simply has not written yet reads as broken to the user.
#[tauri::command]
#[specta::specta]
pub fn reveal_managed_dir(state: State<'_, AppState>, path: String) -> Result<(), Error> {
    let requested = std::path::PathBuf::from(&path);

    // Accept the managed roots themselves and anything below them. The same
    // canonical form on both sides matters: the frontend receives the roots
    // from `paths_get`, and on Windows the same directory can be spelled with
    // a different casing or separator, so the check compares canonically.
    let canonical = canonicalise(&requested);
    let allowed = state.paths.managed_dirs().into_iter().any(|dir| {
        let managed = canonicalise(&dir);
        canonical == managed || canonical.starts_with(&managed)
    });

    if !allowed {
        return Err(Error::invalid_input(format!(
            "{path} is not a DevX-managed directory"
        )));
    }

    std::fs::create_dir_all(&requested)?;

    tauri_plugin_opener::open_path(&requested, None::<&str>)
        .map_err(|err| Error::internal(format!("failed to open {path}: {err}")))
}

/// Best-effort canonical form of a path: absolute, with normalized casing.
///
/// Falls back to the plain absolute path when the path does not exist yet,
/// where there is nothing to canonicalise against the filesystem.
pub(super) fn canonicalise(path: &std::path::Path) -> std::path::PathBuf {
    match path.canonicalize() {
        Ok(resolved) => resolved,
        Err(_) => {
            let absolute = if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path))
                    .unwrap_or_else(|_| path.to_path_buf())
            };
            // Windows paths are case-insensitive; normalize the drive letter so
            // `c:\` and `C:\` compare equal.
            match absolute.to_str() {
                Some(text) if text.len() >= 2 && text.as_bytes()[1] == b':' => {
                    let mut chars = text.chars();
                    let drive = chars.next().unwrap_or_default().to_ascii_uppercase();
                    std::path::PathBuf::from(format!("{drive}{}", chars.as_str()))
                }
                _ => absolute,
            }
        }
    }
}

/// Applies `general.start_with_windows` to the OS autostart entry.
///
/// The registry key is the operating system's state, not DevX's, so it is
/// synced here when the user flips the toggle (and once at startup) rather
/// than being derived implicitly. Returns the resulting enabled state.
#[tauri::command]
#[specta::specta]
pub fn settings_sync_autostart(app: tauri::AppHandle) -> Result<bool, Error> {
    sync_autostart_setting(&app)
}

/// Shared autostart reconciliation, used at startup and from the command.
pub(crate) fn sync_autostart_setting(app: &tauri::AppHandle) -> Result<bool, Error> {
    use tauri_plugin_autostart::ManagerExt as _;

    let state: tauri::State<AppState> = app.state();
    let wanted = state.with_config(|store| store.config().general.start_with_windows);

    let manager = app.autolaunch();
    // Idempotent: check first so disabling an already-disabled entry does not
    // try to delete a missing registry value (os error 2) and warn at startup.
    let current = manager
        .is_enabled()
        .map_err(|err| Error::internal(format!("reading autostart state: {err}")))?;
    if wanted != current {
        let res = if wanted {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(err) = res {
            let msg = err.to_string().to_ascii_lowercase();
            let not_found = msg.contains("cannot find the file")
                || msg.contains("not found")
                || msg.contains("os error 2");
            if !(not_found && !wanted) {
                return Err(Error::internal(format!(
                    "{} autostart: {err}",
                    if wanted { "enabling" } else { "disabling" }
                )));
            }
            tracing::debug!(error = %err, "autostart disable: already absent, treating as disabled");
        }
    }

    manager
        .is_enabled()
        .map_err(|err| Error::internal(format!("reading autostart state: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalise_normalises_the_drive_letter() {
        let lower = canonicalise(std::path::Path::new("c:\\devx\\config"));
        let upper = canonicalise(std::path::Path::new("C:\\devx\\config"));
        assert_eq!(lower, upper);
    }

    #[test]
    fn canonicalise_preserves_relative_fallback() {
        // A non-existent path cannot be canonicalised against the filesystem;
        // it must still come back absolute-ish rather than empty.
        let ghost = canonicalise(std::path::Path::new("C:\\devx\\service-config\\nginx"));
        assert!(ghost.starts_with("C:\\"));
    }

    #[test]
    fn managed_subdirectories_are_within_a_managed_root() {
        let root = canonicalise(std::path::Path::new("C:\\devx\\service-config"));
        let child = canonicalise(std::path::Path::new("C:\\devx\\service-config\\nginx"));
        assert!(child.starts_with(root));
    }
}

/// Whether a newer DevX release is available upstream.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct UpdateStatus {
    /// Version of the running build.
    pub current: String,
    /// Newest release tag upstream, when one could be resolved.
    pub latest: Option<String>,
    /// Whether `latest` is newer than `current`.
    pub update_available: bool,
    /// Release page for the new version, when known.
    pub url: Option<String>,
}

/// Checks the newest published DevX release and compares it to this build.
///
/// Network failures return `latest: None` rather than an error: the checker
/// runs on startup, and an offline machine must not surface a red banner for
/// what is only a missed HTTP call. The result is cached with the ordinary
/// resolver cache, so repeated checks are cheap.
#[tauri::command]
#[specta::specta]
pub async fn update_check(state: State<'_, AppState>) -> Result<UpdateStatus, Error> {
    let current = env!("CARGO_PKG_VERSION").to_owned();

    let url = format!("https://api.github.com/repos/{RELEASES_REPO}/releases/latest");
    let release = state
        .http
        .get_text_with_headers(&url, &[("Accept", "application/vnd.github+json")])
        .await;

    let latest = match release {
        Ok(response) => parse_latest_release(&response.body),
        Err(err) => {
            tracing::debug!(error = %err, "release check failed; assuming current");
            None
        }
    };

    let update_available = latest
        .as_deref()
        .and_then(|tag| semver::Version::parse(tag.trim_start_matches('v')).ok())
        .and_then(|upstream| {
            semver::Version::parse(&current)
                .ok()
                .map(|mine| upstream > mine)
        })
        .unwrap_or(false);

    Ok(UpdateStatus {
        update_available,
        url: update_available
            .then(|| format!("https://github.com/{RELEASES_REPO}/releases/latest")),
        latest,
        current,
    })
}

/// Extracts the newest non-draft, non-prerelease tag from a releases payload.
fn parse_latest_release(body: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Release {
        tag_name: String,
        #[serde(default)]
        draft: bool,
        #[serde(default)]
        prerelease: bool,
    }

    let release: Release = serde_json::from_str(body).ok()?;
    (!release.draft && !release.prerelease).then_some(release.tag_name)
}

/// GitHub repository DevX publishes releases to.
const RELEASES_REPO: &str = "0xLLVEL/devx";
