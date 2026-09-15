//! Settings helpers: autostart, reveal, update check.

use crate::state::AppState;
use devx_core::Error;
use tauri::Manager as _;
use tauri::State;

/// Reveals a DevX directory in File Explorer.
///
/// Restricted to the managed directories so the command cannot be used to open
/// arbitrary paths from the webview.
#[tauri::command]
#[specta::specta]
pub fn reveal_managed_dir(state: State<'_, AppState>, path: String) -> Result<(), Error> {
    let requested = std::path::PathBuf::from(&path);

    let allowed = state
        .paths
        .managed_dirs()
        .into_iter()
        .any(|dir| dir == requested);

    if !allowed {
        return Err(Error::invalid_input(format!(
            "{path} is not a DevX-managed directory"
        )));
    }

    std::fs::create_dir_all(&requested)?;

    tauri_plugin_opener::open_path(&requested, None::<&str>)
        .map_err(|err| Error::internal(format!("failed to open {path}: {err}")))
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
    if wanted {
        manager
            .enable()
            .map_err(|err| Error::internal(format!("enabling autostart: {err}")))?;
    } else {
        manager
            .disable()
            .map_err(|err| Error::internal(format!("disabling autostart: {err}")))?;
    }

    manager
        .is_enabled()
        .map_err(|err| Error::internal(format!("reading autostart state: {err}")))
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
const RELEASES_REPO: &str = "devx/devx";
