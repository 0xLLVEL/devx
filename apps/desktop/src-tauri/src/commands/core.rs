//! Core commands: app metadata, paths, configuration and diagnostics.

use devx_core::{AppInfo, AppPaths, Config, DoctorReport, Error};
use tauri::State;

use super::settings::sync_autostart_setting;
use super::sites::reconcile_hosts_entries;
use crate::state::AppState;
use devx_privileged::PipeClient;
use devx_sys::WindowsProbe;

/// Returns metadata about the running DevX build.
#[tauri::command]
#[specta::specta]
pub fn app_info() -> Result<AppInfo, Error> {
    tracing::debug!("app_info requested");
    Ok(AppInfo::current())
}

/// Returns the resolved configuration and data directories.
#[tauri::command]
#[specta::specta]
pub fn paths_get(state: State<'_, AppState>) -> Result<AppPaths, Error> {
    Ok(state.paths.clone())
}

/// Returns the current configuration.
#[tauri::command]
#[specta::specta]
pub fn config_get(state: State<'_, AppState>) -> Result<Config, Error> {
    Ok(state.with_config(|store| store.config().clone()))
}

/// Validates and persists a replacement configuration.
///
/// Returns the stored configuration, which may differ from the input where
/// DevX normalises values such as `schema_version`.
#[tauri::command]
#[specta::specta]
pub async fn config_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: Config,
) -> Result<Config, Error> {
    let previous_mode = state.with_config(|store| store.config().network.dns_mode);
    let stored = state.with_config_mut(|store| {
        store.replace(config)?;
        Ok::<_, Error>(store.config().clone())
    })?;

    // A successful write means whatever was wrong with the file is now fixed.
    state.mark_config_healthy();

    // Switching the resolution strategy must reconcile the hosts file: the
    // hosts-first strategies write every configured name, resolver-only
    // clears DevX-owned entries so nothing stale keeps resolving.
    if stored.network.dns_mode != previous_mode {
        reconcile_hosts_entries(&state, stored.network.dns_mode).await;
    }

    // The OS autostart entry must follow the setting immediately; a failure
    // is reported but does not roll back the save.
    if let Err(err) = sync_autostart_setting(&app) {
        tracing::warn!(error = %err, "could not sync the autostart entry");
    }

    Ok(stored)
}

/// Restores the default configuration.
#[tauri::command]
#[specta::specta]
pub fn config_reset(state: State<'_, AppState>) -> Result<Config, Error> {
    let stored = state.with_config_mut(|store| {
        store.replace(Config::default())?;
        Ok::<_, Error>(store.config().clone())
    })?;

    state.mark_config_healthy();

    Ok(stored)
}

/// Exports the current configuration as TOML text.
///
/// The text round-trips: `config_import` accepts it verbatim, and so does a
/// fresh DevX via the same parse-and-validate path a config file receives.
#[tauri::command]
#[specta::specta]
pub fn config_export(state: State<'_, AppState>) -> Result<String, Error> {
    let config = state.with_config(|store| store.config().clone());
    devx_core::serialize_config(&config)
}

/// Imports a configuration from TOML text, validating before it persists.
///
/// Missing sections fall back to defaults, so a partial export still imports;
/// anything invalid is refused and leaves the running configuration alone.
#[tauri::command]
#[specta::specta]
pub fn config_import(state: State<'_, AppState>, body: String) -> Result<Config, Error> {
    let imported = devx_core::parse_config(&body)?;

    state.with_config_mut(|store| store.replace(imported))?;
    state.mark_config_healthy();

    Ok(state.with_config(|store| store.config().clone()))
}

/// Runs environment diagnostics against the live system.
#[tauri::command]
#[specta::specta]
pub fn doctor_run(state: State<'_, AppState>) -> Result<DoctorReport, Error> {
    let probe = WindowsProbe::new();
    Ok(devx_core::doctor::run(
        &state.paths,
        &probe,
        &state.config_health(),
    ))
}

/// One recorded service transition from the persistent event log, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct EventEntry {
    /// Unix timestamp in seconds.
    #[specta(type = specta_typescript::Number)]
    pub at_unix: u64,
    /// Id of the supervised service.
    pub id: String,
    /// The state it moved to (`running`, `failed`, `starting`, …).
    pub state: String,
    /// Why it left the running state (`crashed`, `health_timeout`, …), when it did.
    pub exit: Option<String>,
}

/// Returns the newest service events from the persistent log, newest first.
///
/// The log survives app restarts, so this answers "what happened while I
/// was away" — including failures the live badge already moved past.
#[tauri::command]
#[specta::specta]
pub fn events_recent(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<EventEntry>, Error> {
    let events = crate::event_log::recent(
        &state.paths,
        limit.unwrap_or(50).clamp(1, crate::event_log::MAX_RECENT as u32) as usize,
    );
    Ok(events
        .into_iter()
        .map(|event| EventEntry {
            at_unix: event.at_unix,
            id: event.id,
            state: event.state,
            exit: event.exit,
        })
        .collect())
}

/// How the privileged helper looks from this machine right now.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PrivilegedStatus {
    /// Whether the helper's named pipe answered.
    pub available: bool,
    /// Protocol version of a reachable helper, when it answered.
    pub protocol_version: Option<u32>,
}

/// Probes the privileged helper so the UI can show whether elevated
/// operations (hosts entries today, HTTPS and NRPT later) are possible.
///
/// Deliberately cheap: an open-and-close of the pipe, no handshake round
/// trip, so it can be polled without cost.
#[tauri::command]
#[specta::specta]
pub fn privileged_status() -> Result<PrivilegedStatus, Error> {
    let available = PipeClient::is_available();
    tracing::debug!(available, "probed the privileged helper");

    Ok(PrivilegedStatus {
        available,
        // The version handshake needs a live request cycle; deferred until a
        // command actually uses the helper, which also serves as validation.
        protocol_version: if available {
            Some(devx_ipc::PROTOCOL_VERSION)
        } else {
            None
        },
    })
}
