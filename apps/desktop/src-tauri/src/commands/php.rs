//! PHP FastCGI pool and extension commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

use super::services::{service_logs, LogEntry};
use devx_provision::PhpPoolSummary;

/// A summary of one PHP FastCGI pool, including its live state.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PhpPoolStatus {
    /// Pool identifier (`php-pool-8.4.25`).
    pub id: String,
    /// PHP version served by this pool.
    pub version: String,
    /// FastCGI workers configured for the pool.
    pub workers: u32,
    /// Port the pool's FastCGI socket binds to.
    pub port: u16,
    /// Current lifecycle state.
    pub state: devx_proc::ServiceState,
}

/// Lists the PHP FastCGI pools DevX can supervise: one per installed PHP.
///
/// Pools are planned on the fly rather than persisted, so the list always
/// matches what is on disk. Workers reflect the stored setting when the pool
/// has one, and the default otherwise.
#[tauri::command]
#[specta::specta]
pub fn php_pool_list(state: State<'_, AppState>) -> Result<Vec<PhpPoolStatus>, Error> {
    let installed = installed_php_versions(state.paths.runtimes_dir().join("php"));
    let stored = state.with_config(|store| store.config().php_pools.clone());

    let mut pools = Vec::new();
    for version in installed {
        let workers = match stored.get(&version) {
            Some(workers) => workers,
            None => devx_provision::DEFAULT_WORKERS,
        };
        let port = pool_port(&state, &version)?;
        let summary = PhpPoolSummary {
            id: devx_provision::pool_id(&version),
            version: version.clone(),
            workers,
        };
        pools.push(PhpPoolStatus {
            state: pool_state(&state, &summary.id),
            port,
            ..from_summary(summary)
        });
    }

    Ok(pools)
}

/// Starts (or reports) the FastCGI pool for one installed PHP version.
///
/// The pool keeps the port its rendered `pool.conf` claims, so restarting
/// DevX never renumbers existing pools. Returns once the pool is running or
/// the start has failed.
#[tauri::command]
#[specta::specta]
pub async fn php_pool_start(
    state: State<'_, AppState>,
    version: String,
    workers: u32,
) -> Result<PhpPoolStatus, Error> {
    devx_provision::validate_workers(workers)?;

    // Remember the choice so the list view and the next start agree.
    if pool_workers(&state, &version) != workers {
        state.with_config_mut(|store| {
            store.update(|config| config.php_pools.insert(version.clone(), workers))
        })?;
    }

    let port = pool_port(&state, &version)?;
    let extensions = pool_extensions(&state, &version);
    let xdebug = pool_xdebug(&state, &version);
    let plan =
        crate::services::plan_php_pool(&state.paths, &version, port, workers, &extensions, xdebug)?;
    let id = plan.id.clone();

    let supervisor = match state.services.get(&id) {
        Some(existing) if existing.state().is_active() => existing,
        _ => {
            let spec = crate::services::pool_spec(&state.paths, &plan)?;
            state.services.register(spec)?
        }
    };

    supervisor.start().await?;

    Ok(PhpPoolStatus {
        state: supervisor.state(),
        port,
        ..from_summary(plan.summary())
    })
}

/// Stops the FastCGI pool of one PHP version.
#[tauri::command]
#[specta::specta]
pub async fn php_pool_stop(
    state: State<'_, AppState>,
    version: String,
) -> Result<PhpPoolStatus, Error> {
    let id = devx_provision::pool_id(&version);
    let supervisor = state.services.require(&id)?;
    supervisor.stop().await;

    let workers = pool_workers(&state, &version);
    let port = pool_port(&state, &version)?;

    Ok(PhpPoolStatus {
        state: supervisor.state(),
        id,
        port,
        version,
        workers,
    })
}

/// Returns the status of one PHP pool, stopped when it has never started.
#[tauri::command]
#[specta::specta]
pub fn php_pool_status(
    state: State<'_, AppState>,
    version: String,
) -> Result<PhpPoolStatus, Error> {
    let id = devx_provision::pool_id(&version);
    let workers = pool_workers(&state, &version);
    let port = pool_port(&state, &version)?;
    let live_state = pool_state(&state, &id);

    Ok(PhpPoolStatus {
        id,
        version,
        workers,
        port,
        state: live_state,
    })
}

/// Returns log lines for a pool newer than `after` (0 for all retained).
///
/// Pools reuse the service log machinery; this alias keeps the UI from
/// reaching into service ids by hand.
#[tauri::command]
#[specta::specta]
pub fn php_pool_logs(
    state: State<'_, AppState>,
    version: String,
    after: u32,
) -> Result<Vec<LogEntry>, Error> {
    service_logs(state, devx_provision::pool_id(&version), after)
}

/// The PHP extensions a version ships and which are enabled, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PhpExtensionInfo {
    /// PHP version these extensions belong to.
    pub version: String,
    /// Every extension DLL the installed version ships, sorted.
    pub installed: Vec<String>,
    /// Extension DLLs currently enabled for the version.
    pub enabled: Vec<String>,
}

/// Lists the extensions of one installed PHP version and which are enabled.
#[tauri::command]
#[specta::specta]
pub fn php_ext_list(
    state: State<'_, AppState>,
    version: String,
) -> Result<PhpExtensionInfo, Error> {
    let install_dir = state.paths.runtimes_dir().join("php").join(&version);
    if !install_dir.join(".devx-ok").is_file() {
        return Err(Error::not_found(format!("php {version} is not installed"))
            .with_hint("install the PHP version first"));
    }

    let installed = devx_provision::list_php_extensions(&install_dir)?;
    let enabled = state.with_config(|store| store.config().php_extensions.get(&version).to_vec());

    Ok(PhpExtensionInfo {
        version,
        installed,
        enabled,
    })
}

/// Enables or disables one extension of a PHP version.
///
/// The setting is persisted first; a running pool is then restarted with a
/// re-rendered `php.ini`, so the change applies immediately. A failed restart
/// does not roll back the setting — the next manual start picks it up.
#[tauri::command]
#[specta::specta]
pub async fn php_ext_set(
    state: State<'_, AppState>,
    version: String,
    extension: String,
    enabled: bool,
) -> Result<PhpExtensionInfo, Error> {
    // The extension must be one the installed version actually ships, so a
    // typo can never render an ini PHP refuses to start with.
    let install_dir = state.paths.runtimes_dir().join("php").join(&version);
    let installed = devx_provision::list_php_extensions(&install_dir)?;
    if enabled && !installed.contains(&extension) {
        return Err(Error::not_found(format!(
            "php {version} does not ship {extension}"
        )));
    }

    state.with_config_mut(|store| {
        store.update(|config| {
            if enabled {
                config.php_extensions.enable(&version, extension.clone());
            } else {
                config.php_extensions.disable(&version, &extension);
            }
        })
    })?;

    // A running pool must restart to load (or unload) the extension: re-render
    // its ini with the new set, keeping its claimed port, then bounce it.
    let id = devx_provision::pool_id(&version);
    if let Some(supervisor) = state.services.get(&id) {
        if supervisor.state().is_active() {
            let workers = pool_workers(&state, &version);
            let port = pool_port(&state, &version)?;
            let extensions = pool_extensions(&state, &version);
            let xdebug = pool_xdebug(&state, &version);
            let plan = crate::services::plan_php_pool(
                &state.paths,
                &version,
                port,
                workers,
                &extensions,
                xdebug,
            )?;

            // Stop before re-registering: the registry refuses to replace an
            // active supervisor, and the stop is harmless for a stale one.
            supervisor.stop().await;
            let spec = crate::services::pool_spec(&state.paths, &plan)?;
            let replacement = state.services.register(spec)?;
            replacement.start().await?;
        }
    }

    php_ext_list(state, version)
}

/// The Xdebug state of one PHP version, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PhpXdebugInfo {
    /// PHP version this configuration belongs to.
    pub version: String,
    /// Whether Xdebug is configured for this version at all.
    pub enabled: bool,
    /// Xdebug mode set (`off`, `debug`, `develop,debug`, …); empty when unconfigured.
    pub mode: String,
    /// The IDE port the debugger connects back to.
    pub client_port: u16,
}

/// Reads the Xdebug configuration of one installed PHP version.
#[tauri::command]
#[specta::specta]
pub fn php_xdebug_get(state: State<'_, AppState>, version: String) -> Result<PhpXdebugInfo, Error> {
    let install_dir = state.paths.runtimes_dir().join("php").join(&version);
    if !install_dir.join(".devx-ok").is_file() {
        return Err(Error::not_found(format!("php {version} is not installed"))
            .with_hint("install the PHP version first"));
    }

    let stored = state
        .with_config(|store| store.config().php_xdebug.get(&version).cloned());
    Ok(match stored {
        Some(config) => PhpXdebugInfo {
            version,
            enabled: config.is_enabled(),
            mode: config.mode,
            client_port: config.client_port,
        },
        None => PhpXdebugInfo {
            version,
            enabled: false,
            mode: String::new(),
            client_port: 0,
        },
    })
}

/// Enables, disables or reconfigures Xdebug for one PHP version.
///
/// `enabled = false` clears the stored configuration entirely; `enabled = true`
/// with an empty `mode` means Xdebug's default debugger profile. A running
/// pool restarts with the re-rendered ini, exactly like an extension toggle.
#[tauri::command]
#[specta::specta]
pub async fn php_xdebug_set(
    state: State<'_, AppState>,
    version: String,
    enabled: bool,
    mode: String,
    client_port: u16,
) -> Result<PhpXdebugInfo, Error> {
    let install_dir = state.paths.runtimes_dir().join("php").join(&version);
    if !install_dir.join(".devx-ok").is_file() {
        return Err(Error::not_found(format!("php {version} is not installed"))
            .with_hint("install the PHP version first"));
    }

    if enabled {
        // Xdebug only ships as a Zend extension; without its DLL in `ext/` the
        // rendered ini would stop PHP from starting at all.
        let installed = devx_provision::list_php_extensions(&install_dir)?;
        if !installed
            .iter()
            .any(|name| {
                let stem = name
                    .strip_prefix("php_")
                    .and_then(|rest| rest.strip_suffix(".dll"))
                    .unwrap_or(name);
                stem == "xdebug"
            })
        {
            return Err(Error::not_found(format!(
                "php {version} does not ship the xdebug extension"
            )));
        }
    }

    state.with_config_mut(|store| {
        store.update(|config| {
            if enabled {
                let mode = if mode.trim().is_empty() {
                    "debug".to_owned()
                } else {
                    mode.trim().to_owned()
                };
                let port = if client_port == 0 { 9003 } else { client_port };
                config.php_xdebug.insert(
                    version.clone(),
                    devx_core::config::XdebugConfig {
                        mode,
                        client_port: port,
                    },
                );
            } else {
                config.php_xdebug.remove(&version);
            }
        })
    })?;

    // A running pool must restart to load (or unload) the debugger.
    let id = devx_provision::pool_id(&version);
    if let Some(supervisor) = state.services.get(&id) {
        if supervisor.state().is_active() {
            let workers = pool_workers(&state, &version);
            let port = pool_port(&state, &version)?;
            let extensions = pool_extensions(&state, &version);
            let xdebug = pool_xdebug(&state, &version);
            let plan = crate::services::plan_php_pool(
                &state.paths,
                &version,
                port,
                workers,
                &extensions,
                xdebug,
            )?;

            supervisor.stop().await;
            let spec = crate::services::pool_spec(&state.paths, &plan)?;
            let replacement = state.services.register(spec)?;
            replacement.start().await?;
        }
    }

    php_xdebug_get(state, version)
}

/// The enabled extensions for `version`, from the stored configuration.
fn pool_extensions(state: &AppState, version: &str) -> Vec<String> {
    state.with_config(|store| store.config().php_extensions.get(version).to_vec())
}

/// The Xdebug settings for `version`, from the stored configuration.
fn pool_xdebug(state: &AppState, version: &str) -> Option<devx_core::config::XdebugConfig> {
    state
        .with_config(|store| store.config().php_xdebug.get(version).cloned())
}

/// The configured worker count for `version`, or the default.
fn pool_workers(state: &AppState, version: &str) -> u32 {
    state
        .with_config(|store| store.config().php_pools.get(version))
        .unwrap_or(devx_provision::DEFAULT_WORKERS)
}

/// The port `version`'s pool uses: the one its rendered conf claims, or a
/// free one for a pool that has never run.
fn pool_port(state: &AppState, version: &str) -> Result<u16, Error> {
    let config_dir = state
        .paths
        .service_config_dir()
        .join(devx_provision::pool_id(version));

    if let Ok(listen) = devx_provision::pool_listen_addr(&config_dir) {
        if let Some(port) = listen.rsplit(':').next().and_then(|p| p.parse().ok()) {
            return Ok(port);
        }
    }

    let reserved = crate::services::existing_pool_ports(&state.paths);
    Ok(crate::services::next_pool_port(&state.paths, &reserved))
}

/// The supervisor state of `id`, `Stopped` when it was never started.
fn pool_state(state: &AppState, id: &str) -> devx_proc::ServiceState {
    state
        .services
        .get(id)
        .map(|sup| sup.state())
        .unwrap_or(devx_proc::ServiceState::Stopped)
}

/// Installed PHP versions found under the runtimes directory.
fn installed_php_versions(runtimes: std::path::PathBuf) -> Vec<String> {
    let mut versions = Vec::new();

    let Ok(entries) = std::fs::read_dir(&runtimes) else {
        return versions;
    };

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let version = entry.file_name().to_string_lossy().into_owned();
        if entry.path().join(".devx-ok").is_file() {
            versions.push(version);
        }
    }

    versions.sort();
    versions
}

/// Widens a [`PhpPoolSummary`] into a [`PhpPoolStatus`], state unset.
fn from_summary(summary: PhpPoolSummary) -> PhpPoolStatus {
    PhpPoolStatus {
        state: devx_proc::ServiceState::Stopped,
        port: 0,
        id: summary.id,
        version: summary.version,
        workers: summary.workers,
    }
}
