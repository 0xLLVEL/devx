//! Tauri commands exposed to the DevX frontend.
//!
//! Every command is annotated with `#[specta::specta]` so that `tauri-specta`
//! can generate the TypeScript client in `src/bindings.ts`. Never call `invoke`
//! by hand from the frontend: use the generated client so renames break the
//! build instead of failing at runtime.

use devx_core::{AppInfo, AppPaths, Config, DoctorReport, Error, Site as ConfigSite};
use devx_privileged::PipeClient;
use devx_provision::{ComponentSummary, PhpPoolSummary, VersionListing};
use devx_sys::WindowsProbe;
use tauri::State;
use tauri_specta::Event as _;

use tauri::Manager as _;

use crate::events::{InstallPhase, InstallProgress};
use crate::state::AppState;

/// Status of a supervised service, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ServiceStatus {
    /// Service identifier.
    pub id: String,
    /// Current lifecycle state.
    pub state: devx_proc::ServiceState,
}

/// One captured log line, for the UI tail.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct LogEntry {
    /// Monotonic sequence number.
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    /// Which stream it came from.
    pub stream: devx_proc::LogStream,
    /// Line text.
    pub text: String,
}

impl From<devx_proc::LogLine> for LogEntry {
    fn from(line: devx_proc::LogLine) -> Self {
        Self {
            seq: line.seq,
            stream: line.stream,
            text: line.text,
        }
    }
}

/// A version of a component that is installed on disk.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct InstalledVersion {
    /// Component identifier.
    pub component_id: String,
    /// Installed version string.
    pub version: String,
    /// Absolute install directory.
    pub path: String,
}

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
pub fn config_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: Config,
) -> Result<Config, Error> {
    let stored = state.with_config_mut(|store| {
        store.replace(config)?;
        Ok::<_, Error>(store.config().clone())
    })?;

    // A successful write means whatever was wrong with the file is now fixed.
    state.mark_config_healthy();

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

/// Lists the components DevX can install.
#[tauri::command]
#[specta::specta]
pub fn catalog_list(state: State<'_, AppState>) -> Result<Vec<ComponentSummary>, Error> {
    Ok(state
        .catalog
        .components
        .iter()
        .map(ComponentSummary::from)
        .collect())
}

/// Lists the installable versions of one component.
///
/// Hits the component's upstream through a revalidating cache, so repeated calls
/// are cheap and a network failure returns the last known list marked stale
/// rather than an error.
#[tauri::command]
#[specta::specta]
pub async fn component_versions(
    state: State<'_, AppState>,
    component_id: String,
) -> Result<VersionListing, Error> {
    let component = state.catalog.component(&component_id)?.clone();
    state.resolver.list_versions(&component).await
}

/// Installs a component version, emitting [`InstallProgress`] events.
///
/// Returns the install directory on success. Progress is delivered through
/// events keyed by component and version so the UI can update the right row.
#[tauri::command]
#[specta::specta]
pub async fn component_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<String, Error> {
    let component = state.catalog.component(&component_id)?.clone();
    let listing = state.resolver.list_versions(&component).await?;

    let target = listing
        .versions
        .into_iter()
        .find(|candidate| candidate.version == version)
        .ok_or_else(|| {
            Error::not_found(format!(
                "{component_id} {version} is not an available version"
            ))
        })?;

    let emit_id = component_id.clone();
    let emit_version = version.clone();
    let install_dir = state
        .installer
        .install(&target, &component.layout, move |stage| {
            // A failed emit only costs a progress update, never the install.
            let _ = InstallProgress {
                component_id: emit_id.clone(),
                version: emit_version.clone(),
                phase: InstallPhase::from(stage),
            }
            .emit(&app);
        })
        .await?;

    Ok(install_dir.to_string_lossy().into_owned())
}

/// Removes an installed component version.
#[tauri::command]
#[specta::specta]
pub fn component_uninstall(
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<(), Error> {
    state.installer.uninstall(&component_id, &version)
}

/// Lists the component ids that DevX can supervise as background services.
#[tauri::command]
#[specta::specta]
pub fn service_component_ids() -> Result<Vec<String>, Error> {
    Ok(devx_provision::service_ids()
        .into_iter()
        .map(str::to_owned)
        .collect())
}

/// Lists every installed component version found on disk.
#[tauri::command]
#[specta::specta]
pub fn installed_versions(state: State<'_, AppState>) -> Result<Vec<InstalledVersion>, Error> {
    let mut installed = Vec::new();
    let runtimes = state.paths.runtimes_dir();

    let Ok(components) = std::fs::read_dir(&runtimes) else {
        // No runtimes directory yet means nothing is installed.
        return Ok(installed);
    };

    for component in components.flatten() {
        if !component.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let component_id = component.file_name().to_string_lossy().into_owned();

        let Ok(versions) = std::fs::read_dir(component.path()) else {
            continue;
        };
        for version in versions.flatten() {
            let version_str = version.file_name().to_string_lossy().into_owned();
            if state.installer.is_installed(&component_id, &version_str) {
                installed.push(InstalledVersion {
                    component_id: component_id.clone(),
                    version: version_str,
                    path: version.path().to_string_lossy().into_owned(),
                });
            }
        }
    }

    Ok(installed)
}

/// Starts a supervised service backed by an installed component version.
///
/// Resolves the service plan (config rendering, port allocation), runs any
/// pending one-time init steps, then registers and starts the supervisor.
/// Returns once the service is running or the start has failed.
#[tauri::command]
#[specta::specta]
pub async fn service_start(
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<ServiceStatus, Error> {
    if !state.installer.is_installed(&component_id, &version) {
        return Err(
            Error::not_found(format!("{component_id} {version} is not installed"))
                .with_hint("install the version first"),
        );
    }

    let plan = crate::services::plan_service(&state.paths, &component_id, &version, &[])?;
    let id = plan.spec.id.clone();

    // One-time init (initdb, mysql_install_db) must complete before launch.
    crate::services::run_init_steps(&plan.init_steps).await?;

    let supervisor = match state.services.get(&id) {
        Some(existing) if existing.state().is_active() => existing,
        _ => state.services.register(plan.spec)?,
    };

    supervisor.start().await?;

    Ok(ServiceStatus {
        id,
        state: supervisor.state(),
    })
}

/// Stops a running supervised service.
#[tauri::command]
#[specta::specta]
pub async fn service_stop(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, Error> {
    let supervisor = state.services.require(&id)?;
    supervisor.stop().await;
    Ok(ServiceStatus {
        id,
        state: supervisor.state(),
    })
}

/// Returns the status of a supervised service.
#[tauri::command]
#[specta::specta]
pub fn service_status(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, Error> {
    let supervisor = state.services.require(&id)?;
    Ok(ServiceStatus {
        id,
        state: supervisor.state(),
    })
}

/// Returns log lines for a service newer than `after` (0 for all retained).
#[tauri::command]
#[specta::specta]
pub fn service_logs(
    state: State<'_, AppState>,
    id: String,
    // `u32` on the wire rather than `u64`: Specta forbids exporting `u64`, and a
    // single session's log will never approach four billion lines.
    after: u32,
) -> Result<Vec<LogEntry>, Error> {
    let supervisor = state.services.require(&id)?;
    Ok(supervisor
        .logs_since(u64::from(after))
        .into_iter()
        .map(LogEntry::from)
        .collect())
}

/// Samples the CPU and memory use of every supervised service.
///
/// CPU percent is relative to the previous sample this process took, so the
/// first call after launch reports 0. Stopped services report zero usage but
/// are still listed, letting the dashboard zip this against the service list.
#[tauri::command]
#[specta::specta]
pub fn service_metrics(
    state: State<'_, AppState>,
) -> Result<Vec<devx_proc::ServiceMetrics>, Error> {
    Ok(state.services.metrics())
}

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
    let plan = crate::services::plan_php_pool(&state.paths, &version, port, workers, &extensions)?;
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
            let plan =
                crate::services::plan_php_pool(&state.paths, &version, port, workers, &extensions)?;

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

/// The enabled extensions for `version`, from the stored configuration.
fn pool_extensions(state: &AppState, version: &str) -> Vec<String> {
    state.with_config(|store| store.config().php_extensions.get(version).to_vec())
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

/// How the privileged helper looks from this machine right now.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PrivilegedStatus {
    /// Whether the helper's named pipe answered.
    pub available: bool,
    /// Protocol version of a reachable helper, when it answered.
    pub protocol_version: Option<u32>,
}

/// The bundled DNS resolver's status, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct DnsStatus {
    /// Whether the resolver is running inside DevX right now.
    pub running: bool,
    /// Port the resolver listens on, when running.
    pub port: Option<u16>,
    /// Whether the NRPT rule routes `.test` queries to DevX. `None` when
    /// the privileged helper is unavailable to check.
    pub nrpt_active: Option<bool>,
    /// The suffix the resolver answers for.
    pub suffix: String,
}

/// A connectable database server, as the UI's connection picker sees it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct DbServer {
    /// Engine behind the service.
    pub engine: devx_db::Engine,
    /// Service id (`mariadb`, `postgresql`, `redis`).
    pub service_id: String,
    /// Host the service binds.
    pub host: String,
    /// Port from the service's allocation.
    pub port: u16,
    /// Whether a TCP connection to the port succeeds right now.
    pub reachable: bool,
}

/// One site as the UI sees it, with the resolved FastCGI endpoint.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SiteStatus {
    /// Host name served.
    pub hostname: String,
    /// Absolute docroot path.
    pub docroot: String,
    /// PHP version serving the site, empty for a static site.
    pub php_version: String,
    /// The `fastcgi_pass` endpoint, when the site runs PHP.
    pub php_endpoint: Option<String>,
    /// Whether the site is served over HTTPS with the local CA certificate.
    pub https: bool,
    /// Environment variables exposed to the site's PHP requests.
    pub env: std::collections::BTreeMap<String, String>,
    /// Additional host names the site answers to.
    pub aliases: Vec<String>,
}

/// The local CA's trust status, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct CaStatus {
    /// Whether the CA exists on disk (signed certificates are possible).
    pub exists: bool,
    /// Whether the machine trusts the CA (browsers accept its certificates).
    /// `None` when the privileged helper is unavailable to check.
    pub trusted: Option<bool>,
}

/// Lists the configured sites with their resolved PHP endpoints.
#[tauri::command]
#[specta::specta]
pub fn site_list(state: State<'_, AppState>) -> Result<Vec<SiteStatus>, Error> {
    let sites = state.with_config(|store| store.config().sites.clone());

    let mut statuses = Vec::new();
    for site in &sites {
        let php_endpoint = match site.php() {
            Some(version) => {
                devx_provision::pool_endpoint_for(&state.paths.service_config_dir(), version).ok()
            }
            None => None,
        };
        statuses.push(SiteStatus {
            hostname: site.hostname.clone(),
            docroot: site.docroot.clone(),
            php_version: site.php_version.clone(),
            php_endpoint,
            https: site.https,
            env: site.env.clone(),
            aliases: site.aliases.clone(),
        });
    }

    Ok(statuses)
}

/// Adds (or replaces) a site, renders its nginx block, and syncs the set.
#[tauri::command]
#[specta::specta]
pub async fn site_add(
    state: State<'_, AppState>,
    hostname: String,
    docroot: String,
    php_version: String,
    https: bool,
) -> Result<Vec<SiteStatus>, Error> {
    let spec = devx_provision::SiteSpec {
        hostname: hostname.clone(),
        docroot: std::path::PathBuf::from(&docroot),
        php_version: if php_version.is_empty() {
            None
        } else {
            Some(php_version)
        },
        env: Vec::new(),
        aliases: Vec::new(),
    };

    // Validate everything up front: hostname shape, docroot absoluteness,
    // and that the chosen PHP pool has a rendered endpoint.
    devx_provision::validate_spec(&spec, &state.paths.service_config_dir())?;

    // Persist to config first: a failed save must abort the mutation before
    // any nginx block is written.
    let site = ConfigSite {
        hostname: spec.hostname.clone(),
        docroot: docroot.clone(),
        php_version: spec.php_version.clone().unwrap_or_default(),
        https,
        env: Default::default(),
        aliases: Vec::new(),
    };
    state.with_config_mut(|store| {
        store.update(|config| {
            config
                .sites
                .retain(|s| !s.hostname.eq_ignore_ascii_case(&site.hostname));
            config.sites.push(site.clone());
        })
    })?;

    sync_site_blocks(&state)?;

    site_list(state)
}

/// Removes a site, prunes its block, and syncs.
#[tauri::command]
#[specta::specta]
pub async fn site_remove(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    state.with_config_mut(|store| {
        store.update(|config| {
            config
                .sites
                .retain(|s| !s.hostname.eq_ignore_ascii_case(&hostname));
        })
    })?;

    sync_site_blocks(&state)?;

    site_list(state)
}

/// Sets one environment variable on a site, syncs its nginx block, and
/// restarts nginx when it is running so the change applies immediately.
#[tauri::command]
#[specta::specta]
pub async fn site_env_set(
    state: State<'_, AppState>,
    hostname: String,
    key: String,
    value: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    // Validation (key shape, value metacharacters) happens inside
    // `store.update` via `Config::validate`, so a rejected pair never lands.
    let known = state.with_config(|store| {
        store
            .config()
            .sites
            .iter()
            .any(|s| s.hostname.eq_ignore_ascii_case(&hostname))
    });
    if !known {
        return Err(Error::not_found(format!(
            "site `{hostname}` is not configured"
        )));
    }

    state.with_config_mut(|store| {
        store.update(|config| {
            let Some(site) = config
                .sites
                .iter_mut()
                .find(|s| s.hostname.eq_ignore_ascii_case(&hostname))
            else {
                return;
            };
            site.env.insert(key, value);
        })
    })?;

    sync_site_blocks(&state)?;
    restart_nginx_if_running(&state).await?;

    site_list(state)
}

/// Removes one environment variable from a site, syncing as
/// [`site_env_set`] does.
#[tauri::command]
#[specta::specta]
pub async fn site_env_delete(
    state: State<'_, AppState>,
    hostname: String,
    key: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    state.with_config_mut(|store| {
        store.update(|config| {
            let Some(site) = config
                .sites
                .iter_mut()
                .find(|s| s.hostname.eq_ignore_ascii_case(&hostname))
            else {
                return;
            };
            site.env.remove(&key);
        })
    })?;

    sync_site_blocks(&state)?;
    restart_nginx_if_running(&state).await?;

    site_list(state)
}

/// Adds an alias host name to a site, syncs, and restarts nginx when running.
#[tauri::command]
#[specta::specta]
pub async fn site_alias_add(
    state: State<'_, AppState>,
    hostname: String,
    alias: String,
) -> Result<Vec<SiteStatus>, Error> {
    mutate_site_aliases(state, hostname, |aliases| {
        let alias = alias.to_ascii_lowercase();
        if !aliases.iter().any(|a| a.eq_ignore_ascii_case(&alias)) {
            aliases.push(alias);
        }
    })
    .await
}

/// Removes an alias host name from a site, syncing as [`site_alias_add`].
#[tauri::command]
#[specta::specta]
pub async fn site_alias_delete(
    state: State<'_, AppState>,
    hostname: String,
    alias: String,
) -> Result<Vec<SiteStatus>, Error> {
    mutate_site_aliases(state, hostname, |aliases| {
        aliases.retain(|a| !a.eq_ignore_ascii_case(&alias));
    })
    .await
}

/// Applies an alias mutation, validating through `Config::validate` (shape
/// plus cross-site uniqueness), then syncing blocks and restarting nginx.
async fn mutate_site_aliases(
    state: State<'_, AppState>,
    hostname: String,
    edit: impl FnOnce(&mut Vec<String>),
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    let known = state.with_config(|store| {
        store
            .config()
            .sites
            .iter()
            .any(|s| s.hostname.eq_ignore_ascii_case(&hostname))
    });
    if !known {
        return Err(Error::not_found(format!(
            "site `{hostname}` is not configured"
        )));
    }

    state.with_config_mut(|store| {
        store.update(|config| {
            let Some(site) = config
                .sites
                .iter_mut()
                .find(|s| s.hostname.eq_ignore_ascii_case(&hostname))
            else {
                return;
            };
            edit(&mut site.aliases);
        })
    })?;

    sync_site_blocks(&state)?;
    restart_nginx_if_running(&state).await?;

    site_list(state)
}

/// Restarts nginx when it is running, re-planning its spec first so the new
/// process loads freshly rendered configuration.
///
/// A stopped nginx simply picks the new config up on its next start, so in
/// that case there is nothing to do. The restart follows the same
/// stop-then-re-register order as `php_ext_set`: the registry refuses to
/// replace an active supervisor.
async fn restart_nginx_if_running(state: &State<'_, AppState>) -> Result<(), Error> {
    let Some(supervisor) = state.services.get("nginx") else {
        return Ok(());
    };
    if !supervisor.state().is_active() {
        return Ok(());
    }

    supervisor.stop().await;

    // Re-plan with the newest installed version resolved from disk, so the
    // restarted nginx matches what is on disk.
    let newest = newest_installed_component(&state.paths, "nginx")?;
    let plan = crate::services::plan_service(&state.paths, "nginx", &newest, &[])?;
    let replacement = state.services.register(plan.spec)?;
    replacement.start().await?;
    Ok(())
}

/// The newest installed version of a component, from the runtimes directory.
fn newest_installed_component(paths: &AppPaths, component_id: &str) -> Result<String, Error> {
    let runtimes = paths.runtimes_dir().join(component_id);
    let mut versions: Vec<String> = std::fs::read_dir(&runtimes)
        .map_err(|_| {
            Error::not_found(format!("{component_id} is not installed"))
                .with_hint("install the component from the Components page first")
        })?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| runtimes.join(name).join(".devx-ok").is_file())
        .collect();
    versions.sort();
    versions
        .pop()
        .ok_or_else(|| Error::not_found(format!("{component_id} is not installed")))
}

/// (Re)writes every site's nginx block and prunes stale ones.
///
/// One sync per mutation keeps the include directory exactly equal to the
/// configured set, which is what makes nginx restarts deterministic.
fn sync_site_blocks(state: &State<'_, AppState>) -> Result<(), Error> {
    let sites = state.with_config(|store| store.config().sites.clone());
    let sites_dir = state.paths.service_config_dir().join("nginx").join("sites");

    for site in &sites {
        let spec = devx_provision::SiteSpec {
            hostname: site.hostname.clone(),
            docroot: std::path::PathBuf::from(&site.docroot),
            php_version: site.php().map(str::to_owned),
            env: site.env.clone().into_iter().collect(),
            aliases: site.aliases.clone(),
        };
        let endpoint = match spec.php_version.clone() {
            Some(version) => Some(devx_provision::pool_endpoint_for(
                &state.paths.service_config_dir(),
                &version,
            )?),
            None => None,
        };

        // HTTPS sites get their certificate minted (or reused) during the
        // sync, so nginx never references a cert file that does not exist.
        let tls = if site.https {
            devx_provision::ensure_site_cert(&state.paths.certs_dir(), &site.hostname)?;
            let https_port = state.with_config(|store| store.config().network.https_port);
            Some(devx_provision::tls_listen_snippet(
                &site.hostname,
                https_port,
            ))
        } else {
            None
        };

        devx_provision::write_site_block(&sites_dir, &spec, endpoint.as_deref(), tls.as_deref())?;
    }

    let live: Vec<String> = sites.iter().map(|s| s.hostname.clone()).collect();
    devx_provision::prune_stale_blocks(&sites_dir, &live)?;

    Ok(())
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

/// Lists the database servers DevX supervises and their reachability.
///
/// Ports come from each service's rendered state where available, falling
/// back to the definition's default port, so this works before first start
/// (unreachable) and after restarts (reassigned ports picked up live).
#[tauri::command]
#[specta::specta]
pub fn db_list_servers(state: State<'_, AppState>) -> Result<Vec<DbServer>, Error> {
    const DATABASE_SERVICES: &[(&str, devx_db::Engine)] = &[
        ("mariadb", devx_db::Engine::MariaDb),
        ("postgresql", devx_db::Engine::PostgreSql),
        ("redis", devx_db::Engine::Redis),
    ];

    let mut servers = Vec::new();
    for (service_id, engine) in DATABASE_SERVICES {
        let registry = &state.services;
        let default_port = match engine {
            devx_db::Engine::MariaDb => 3306,
            devx_db::Engine::PostgreSql => 5432,
            devx_db::Engine::Redis => 6379,
        };
        let port = registry.port_of(service_id).unwrap_or(default_port);

        let params = devx_db::ConnectionParams {
            engine: *engine,
            host: "127.0.0.1".to_owned(),
            port,
            username: None,
            password: None,
            database: None,
        };
        let reachable = devx_db::is_reachable(&params);

        servers.push(DbServer {
            engine: *engine,
            service_id: (*service_id).to_owned(),
            host: "127.0.0.1".to_owned(),
            port,
            reachable,
        });
    }

    Ok(servers)
}

/// Runs one read-only statement against `params` and renders a grid.
#[tauri::command]
#[specta::specta]
pub async fn db_query(
    params: devx_db::ConnectionParams,
    statement: String,
) -> Result<devx_db::DbResult, Error> {
    devx_db::query(&params, &statement).await
}

/// Lists the databases (schemas) visible on `params`.
#[tauri::command]
#[specta::specta]
pub async fn db_list_databases(
    params: devx_db::ConnectionParams,
) -> Result<devx_db::DbResult, Error> {
    devx_db::list_databases(&params).await
}

/// Lists the tables in `params.database`.
#[tauri::command]
#[specta::specta]
pub async fn db_list_tables(params: devx_db::ConnectionParams) -> Result<devx_db::DbResult, Error> {
    devx_db::list_tables(&params).await
}

/// One database backup file, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct BackupEntry {
    /// Service the backup belongs to (`mariadb`, `postgresql`, `redis`).
    pub service_id: String,
    /// File name inside the service's backups directory.
    pub file_name: String,
    /// Size on disk, in bytes.
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
    /// Creation time as Unix seconds.
    #[specta(type = specta_typescript::Number)]
    pub created_unix: u64,
}

/// How many backups to keep per service; older ones are pruned on create.
const MAX_BACKUPS_PER_SERVICE: usize = 10;

/// The backups directory for one database service.
fn backup_dir(paths: &AppPaths, service_id: &str) -> std::path::PathBuf {
    paths.data_dir.join("backups").join(service_id)
}

/// The [`devx_db::Engine`] a database service id maps to.
fn engine_of(service_id: &str) -> Result<devx_db::Engine, Error> {
    match service_id {
        "mariadb" => Ok(devx_db::Engine::MariaDb),
        "postgresql" => Ok(devx_db::Engine::PostgreSql),
        "redis" => Ok(devx_db::Engine::Redis),
        other => Err(Error::invalid_input(format!(
            "`{other}` has no backups; only mariadb, postgresql and redis do"
        ))),
    }
}

/// The connection params the dump tools and snapshots use for `service_id`.
fn db_params(state: &AppState, service_id: &str) -> Result<devx_db::ConnectionParams, Error> {
    let engine = engine_of(service_id)?;
    let default_port = match engine {
        devx_db::Engine::MariaDb => 3306,
        devx_db::Engine::PostgreSql => 5432,
        devx_db::Engine::Redis => 6379,
    };
    Ok(devx_db::ConnectionParams {
        engine,
        host: "127.0.0.1".into(),
        port: state.services.port_of(service_id).unwrap_or(default_port),
        username: None,
        password: None,
        database: None,
    })
}

/// Validates a backup file name: a safe stem plus a known extension.
fn validate_backup_file_name(file_name: &str) -> Result<(), Error> {
    let valid = !file_name.is_empty()
        && (file_name.ends_with(".sql") || file_name.ends_with(".rdb"))
        && file_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !file_name.contains("..");
    if valid {
        Ok(())
    } else {
        Err(Error::invalid_input(format!(
            "`{file_name}` is not a DevX backup file name"
        )))
    }
}

/// Lists the backups of one database service, newest first.
#[tauri::command]
#[specta::specta]
pub fn backup_list(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<Vec<BackupEntry>, Error> {
    engine_of(&service_id)?;
    let dir = backup_dir(&state.paths, &service_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut backups = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if validate_backup_file_name(&file_name).is_err() {
            continue;
        }
        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let created_unix = metadata
            .and_then(|m| m.created().or_else(|_| m.modified()).ok())
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs())
            })
            .unwrap_or(0);
        backups.push(BackupEntry {
            service_id: service_id.clone(),
            file_name,
            size_bytes,
            created_unix,
        });
    }
    backups.sort_by_key(|entry| std::cmp::Reverse(entry.created_unix));
    Ok(backups)
}

/// Creates a backup of one database service and prunes old ones.
///
/// MariaDB and PostgreSQL are dumped through their own tools into plain SQL;
/// Redis is snapshotted with a blocking `SAVE` and the RDB file copied. The
/// service must be running: the tools connect over TCP like any client.
#[tauri::command]
#[specta::specta]
pub async fn backup_create(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<BackupEntry, Error> {
    let engine = engine_of(&service_id)?;
    let params = db_params(&state, &service_id)?;
    if !devx_db::is_reachable(&params) {
        return Err(Error::conflict(format!(
            "{service_id} is not running; start it before taking a backup"
        )));
    }

    let dir = backup_dir(&state.paths, &service_id);
    std::fs::create_dir_all(&dir).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to create {}: {err}", dir.display()),
        )
    })?;

    let created_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = match engine {
        devx_db::Engine::Redis => format!("snapshot-{created_unix}.rdb"),
        _ => format!("dump-{created_unix}.sql"),
    };
    let out_path = dir.join(&file_name);

    match engine {
        devx_db::Engine::Redis => {
            devx_db::redis_snapshot(params.port).await?;
            let rdb = state
                .paths
                .service_data_dir()
                .join("redis")
                .join("dump.rdb");
            std::fs::copy(&rdb, &out_path).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to copy {}: {err}", rdb.display()),
                )
                .with_hint("the snapshot file was not found next to the redis service data")
            })?;
        }
        _ => {
            let version = newest_installed_component(&state.paths, &service_id)?;
            let install_dir = state.paths.runtimes_dir().join(&service_id).join(version);
            let plan = devx_db::plan_dump(engine, &install_dir, params.port, &out_path)?;
            devx_db::run_tool(&plan).await?;
        }
    }

    prune_backups(&dir, MAX_BACKUPS_PER_SERVICE)?;

    let size_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupEntry {
        service_id,
        file_name,
        size_bytes,
        created_unix,
    })
}

/// Deletes all but the newest `keep` backups in `dir`.
fn prune_backups(dir: &std::path::Path, keep: usize) -> Result<(), Error> {
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(dir)
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Io,
                format!("failed to read {}: {err}", dir.display()),
            )
        })?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    files.sort_by_key(|(time, _)| std::cmp::Reverse(*time));

    for (_, path) in files.into_iter().skip(keep) {
        if let Err(err) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), error = %err, "could not prune an old backup");
        }
    }
    Ok(())
}

/// Restores a database service from one of its backups.
///
/// SQL dumps are replayed through the engine's client against the running
/// server; a Redis snapshot is copied back into the service data directory,
/// which requires the server to be stopped first.
#[tauri::command]
#[specta::specta]
pub async fn backup_restore(
    state: State<'_, AppState>,
    service_id: String,
    file_name: String,
) -> Result<(), Error> {
    let engine = engine_of(&service_id)?;
    validate_backup_file_name(&file_name)?;

    let dir = backup_dir(&state.paths, &service_id);
    let backup_path = dir.join(&file_name);
    if !backup_path.is_file() {
        return Err(Error::not_found(format!(
            "backup `{file_name}` does not exist"
        )));
    }

    match engine {
        devx_db::Engine::Redis => {
            let running = state
                .services
                .get(&service_id)
                .is_some_and(|supervisor| supervisor.state().is_active());
            if running {
                return Err(Error::conflict(
                    "redis must be stopped to restore a snapshot",
                ));
            }
            let rdb = state
                .paths
                .service_data_dir()
                .join("redis")
                .join("dump.rdb");
            std::fs::copy(&backup_path, &rdb).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to restore {}: {err}", rdb.display()),
                )
            })?;
        }
        _ => {
            let params = db_params(&state, &service_id)?;
            if !devx_db::is_reachable(&params) {
                return Err(Error::conflict(format!(
                    "{service_id} is not running; start it before restoring"
                )));
            }
            let version = newest_installed_component(&state.paths, &service_id)?;
            let install_dir = state.paths.runtimes_dir().join(&service_id).join(version);
            let plan = devx_db::plan_restore(engine, &install_dir, params.port, &backup_path)?;
            devx_db::run_tool(&plan).await?;
        }
    }

    Ok(())
}

/// Deletes one backup of a database service.
#[tauri::command]
#[specta::specta]
pub fn backup_delete(
    state: State<'_, AppState>,
    service_id: String,
    file_name: String,
) -> Result<(), Error> {
    engine_of(&service_id)?;
    validate_backup_file_name(&file_name)?;

    let path = backup_dir(&state.paths, &service_id).join(&file_name);
    std::fs::remove_file(&path).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to delete {}: {err}", path.display()),
        )
    })
}

/// Status of the Mailpit service, as the Mail page needs it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct MailStatus {
    /// Whether the `mailpit` service is currently running.
    pub running: bool,
    /// Port the HTTP UI (and API) answers on; `null` while stopped.
    pub port: Option<u16>,
    /// SMTP port apps should send mail to.
    pub smtp_port: u16,
    /// Total and unread counts, when the API is reachable right now.
    ///
    /// Exported to TypeScript as plain `number`s (see the repo-wide `u64`
    /// note); `null` while the API is unreachable.
    #[specta(type = Option<specta_typescript::Number>)]
    pub total: Option<u64>,
    /// Unread count, when the API is reachable right now.
    #[specta(type = Option<specta_typescript::Number>)]
    pub unread: Option<u64>,
}

/// The SMTP port Mailpit listens on; matches the service definition.
const MAILPIT_SMTP_PORT: u16 = 1025;

/// Reports whether Mailpit is running and how full its inbox is.
#[tauri::command]
#[specta::specta]
pub async fn mail_status(state: State<'_, AppState>) -> Result<MailStatus, Error> {
    let (running, port) = {
        let registry = &state.services;
        let running = registry
            .get("mailpit")
            .map(|supervisor| supervisor.state().is_active())
            .unwrap_or(false);
        let port = registry.port_of("mailpit").or(if running {
            devx_provision::definition_for("mailpit")
                .ok()
                .and_then(|def| def.default_port)
        } else {
            None
        });
        (running, port)
    };

    // Counts are best-effort: a stopped or just-started service reports
    // `null`s instead of failing the whole status call.
    let (total, unread) = if running {
        match devx_mail::MailpitClient::new("127.0.0.1", port.unwrap_or(8025))
            .inbox(1)
            .await
        {
            Ok(inbox) => (Some(inbox.total), Some(inbox.unread)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(MailStatus {
        running,
        port,
        smtp_port: MAILPIT_SMTP_PORT,
        total,
        unread,
    })
}

/// Lists the newest messages in Mailpit's inbox.
#[tauri::command]
#[specta::specta]
pub async fn mail_list(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<devx_mail::MessageSummary>, Error> {
    let port = mail_api_port(&state)?;
    Ok(devx_mail::MailpitClient::new("127.0.0.1", port)
        .inbox(limit)
        .await?
        .messages)
}

/// Fetches one full message by ID. Mailpit marks it read on fetch.
#[tauri::command]
#[specta::specta]
pub async fn mail_message(
    state: State<'_, AppState>,
    id: String,
) -> Result<devx_mail::Message, Error> {
    let port = mail_api_port(&state)?;
    devx_mail::MailpitClient::new("127.0.0.1", port)
        .message(&id)
        .await
}

/// Deletes the given messages, or every message when `ids` is empty.
#[tauri::command]
#[specta::specta]
pub async fn mail_delete(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), Error> {
    let port = mail_api_port(&state)?;
    devx_mail::MailpitClient::new("127.0.0.1", port)
        .delete(&ids)
        .await
}

/// The port Mailpit's API answers on, from the running service's supervisor.
fn mail_api_port(state: &AppState) -> Result<u16, Error> {
    state
        .services
        .port_of("mailpit")
        .or_else(|| {
            devx_provision::definition_for("mailpit")
                .ok()
                .and_then(|def| def.default_port)
        })
        .ok_or_else(|| Error::not_found("the mailpit service has no port"))
}

/// The supervisor id of the tunnel process for `hostname`.
fn tunnel_service_id(hostname: &str) -> String {
    format!("cloudflared-tunnel-{hostname}")
}

/// Status of one site's public share, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TunnelStatus {
    /// The shared site's local host name.
    pub hostname: String,
    /// Whether the cloudflared process is running.
    pub running: bool,
    /// The public `https://…trycloudflare.com` URL, once assigned.
    ///
    /// Cloudflare announces it on stdout shortly after start, so this is
    /// `null` for a few seconds after `tunnel_start`.
    pub url: Option<String>,
}

/// Finds the installed cloudflared executable path.
fn cloudflared_exe(state: &AppState) -> Result<std::path::PathBuf, Error> {
    let runtimes = state.paths.runtimes_dir().join("cloudflared");
    let Ok(versions) = std::fs::read_dir(&runtimes) else {
        return Err(Error::not_found("cloudflared is not installed")
            .with_hint("install Cloudflare Tunnel from the Components page"));
    };
    for version in versions.flatten() {
        let exe = version.path().join("cloudflared.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    Err(Error::not_found("cloudflared is not installed")
        .with_hint("install Cloudflare Tunnel from the Components page"))
}

/// Shares `hostname` publicly through a Cloudflare quick tunnel.
///
/// The tunnel targets whichever port nginx actually serves (live allocation
/// or configured default), so the public URL reaches the same server block
/// the local `.test` host name does.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let exe = cloudflared_exe(&state)?;

    // nginx must be running to have anything to forward to; the port comes
    // from its supervisor (reallocated ports included), else the default.
    let nginx_port = state
        .services
        .port_of("nginx")
        .or_else(|| {
            devx_provision::definition_for("nginx")
                .ok()
                .and_then(|def| def.default_port)
        })
        .ok_or_else(|| Error::conflict("nginx has no port to forward"))?;
    let local_url = format!("http://127.0.0.1:{nginx_port}");

    let id = tunnel_service_id(&hostname);
    let args = devx_provision::tunnel::tunnel_args(&local_url);
    if args.is_empty() {
        return Err(Error::invalid_input(format!(
            "{local_url} is not a loopback target"
        )));
    }

    // Re-use the running process if a share already exists for this site.
    if let Some(existing) = state.services.get(&id) {
        if existing.state().is_active() {
            return tunnel_status(state, hostname).await;
        }
    }

    let mut spec = devx_proc::ProcessSpec::new(
        id.clone(),
        exe.to_string_lossy().into_owned(),
        state.paths.logs_dir(),
    );
    spec.args = args;
    let supervisor = state.services.register(spec)?;
    supervisor.start().await?;

    tunnel_status(state, hostname).await
}

/// Stops the share for `hostname`, if one is running.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_stop(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    if let Some(supervisor) = state.services.get(&tunnel_service_id(&hostname)) {
        supervisor.stop().await;
    }

    Ok(TunnelStatus {
        hostname,
        running: false,
        url: None,
    })
}

/// Reports the share status for `hostname`, parsing the tunnel URL from the
/// process's captured log output.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_status(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let id = tunnel_service_id(&hostname);

    let Some(supervisor) = state.services.get(&id) else {
        return Ok(TunnelStatus {
            hostname,
            running: false,
            url: None,
        });
    };
    let running = supervisor.state().is_active();
    let url = supervisor
        .logs()
        .into_iter()
        .rev()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    let url = devx_provision::tunnel::extract_tunnel_url(&url);

    Ok(TunnelStatus {
        hostname,
        running,
        url,
    })
}

/// One supervised worker instance, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct WorkerInstanceStatus {
    /// Supervisor id: `worker-<name>-<instance>`.
    pub id: String,
    /// Current lifecycle state.
    pub state: devx_proc::ServiceState,
}

/// One configured worker with the live state of its instances.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct WorkerStatus {
    /// The user-chosen worker name.
    pub name: String,
    /// Program to run; a relative name runs off `PATH`.
    pub program: Option<String>,
    /// PHP version running the worker, when DevX supplies the interpreter.
    pub php_version: Option<String>,
    /// Arguments passed to the program.
    pub args: Vec<String>,
    /// Directory the process runs in.
    pub working_dir: String,
    /// How many instances are configured.
    pub instances: u32,
    /// Live state of each instance that has been started.
    pub live: Vec<WorkerInstanceStatus>,
}

/// Builds a [`WorkerStatus`] for one configured worker.
fn worker_status(state: &AppState, worker: &devx_core::Worker) -> WorkerStatus {
    let live = (1..=worker.instances)
        .filter_map(|instance| {
            let id = devx_provision::worker_id(&worker.name, instance);
            state
                .services
                .get(&id)
                .map(|supervisor| WorkerInstanceStatus {
                    id,
                    state: supervisor.state(),
                })
        })
        .collect();

    WorkerStatus {
        name: worker.name.clone(),
        program: worker.program.clone(),
        php_version: worker.php_version.clone(),
        args: worker.args.clone(),
        working_dir: worker.working_dir.clone(),
        instances: worker.instances,
        live,
    }
}

/// Lists every configured worker with its live instance states.
#[tauri::command]
#[specta::specta]
pub fn worker_list(state: State<'_, AppState>) -> Result<Vec<WorkerStatus>, Error> {
    let workers = state.with_config(|store| store.config().workers.clone());
    Ok(workers
        .iter()
        .map(|worker| worker_status(&state, worker))
        .collect())
}

/// Adds (or replaces) a configured worker.
#[tauri::command]
#[specta::specta]
pub async fn worker_add(
    state: State<'_, AppState>,
    name: String,
    program: Option<String>,
    php_version: Option<String>,
    args: Vec<String>,
    working_dir: String,
    instances: u32,
) -> Result<Vec<WorkerStatus>, Error> {
    let worker = devx_core::Worker {
        name,
        program,
        php_version,
        args,
        working_dir,
        instances,
    };

    // `update` validates the whole config, so the name, instance bounds and
    // program/php_version exclusivity are checked before anything persists.
    // Persist first, exactly like `site_add`: a failed save aborts the change.
    state.with_config_mut(|store| {
        store.update(|config| {
            config.workers.retain(|w| w.name != worker.name);
            config.workers.push(worker.clone());
        })
    })?;

    worker_list(state)
}

/// Removes a worker, stopping any running instances first.
#[tauri::command]
#[specta::specta]
pub async fn worker_remove(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<WorkerStatus>, Error> {
    let worker = state.with_config(|store| {
        store
            .config()
            .workers
            .iter()
            .find(|w| w.name == name)
            .cloned()
    });
    if let Some(worker) = worker {
        for instance in 1..=worker.instances {
            let id = devx_provision::worker_id(&worker.name, instance);
            if let Some(supervisor) = state.services.get(&id) {
                supervisor.stop().await;
            }
        }
    }

    state.with_config_mut(|store| {
        store.update(|config| config.workers.retain(|w| w.name != name))
    })?;

    worker_list(state)
}

/// Starts every instance of a worker. Idempotent for running instances.
#[tauri::command]
#[specta::specta]
pub async fn worker_start(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<WorkerStatus>, Error> {
    let worker = state
        .with_config(|store| {
            store
                .config()
                .workers
                .iter()
                .find(|w| w.name == name)
                .cloned()
        })
        .ok_or_else(|| Error::not_found(format!("worker `{name}` is not configured")))?;

    let plans = devx_provision::plan_worker_instances(&worker, &state.paths.runtimes_dir())?;
    for plan in plans {
        let supervisor = match state.services.get(&plan.id) {
            Some(existing) if existing.state().is_active() => existing,
            _ => state
                .services
                .register(crate::services::worker_spec(&state.paths, &plan))?,
        };
        supervisor.start().await?;
    }

    worker_list(state)
}

/// Stops every instance of a worker.
#[tauri::command]
#[specta::specta]
pub async fn worker_stop(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<WorkerStatus>, Error> {
    let worker = state
        .with_config(|store| {
            store
                .config()
                .workers
                .iter()
                .find(|w| w.name == name)
                .cloned()
        })
        .ok_or_else(|| Error::not_found(format!("worker `{name}` is not configured")))?;

    for instance in 1..=worker.instances {
        let id = devx_provision::worker_id(&worker.name, instance);
        if let Some(supervisor) = state.services.get(&id) {
            supervisor.stop().await;
        }
    }

    worker_list(state)
}

/// Reports the bundled resolver's status and whether the NRPT rule is active.
#[tauri::command]
#[specta::specta]
pub async fn dns_status(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let (running, port) = {
        let guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(handle) => (true, Some(handle.local_addr().port())),
            None => (false, None),
        }
    };

    let nrpt_active = if PipeClient::is_available() {
        PipeClient::connect()
            .ok()
            .map(|_| true) // Presence of the helper is enough to manage rules.
            .or(Some(false))
    } else {
        None
    };

    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());

    Ok(DnsStatus {
        running,
        port,
        nrpt_active,
        suffix,
    })
}

/// Starts the bundled DNS resolver and (through the helper) points the NRPT
/// rule at it. Idempotent: starting twice keeps the running instance.
#[tauri::command]
#[specta::specta]
pub async fn dns_start(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());
    let dns_port = state.with_config(|store| store.config().network.dns_port);

    // The MutexGuard must not live across the `.await`: std guards are not
    // `Send`, and the Tauri runtime requires `Send` futures. Bind first,
    // then store the handle in a separate, await-free block.
    let already_running = state.dns_running();
    if !already_running {
        // Port 53 binds fail without elevation; fall back to an ephemeral
        // port, which works just as well because the NRPT rule names the
        // resolver's actual port.
        let port = if dns_port == 53 { 0 } else { dns_port };
        let handle = devx_dns::serve(port, devx_dns::ResolverConfig::default_for(&suffix))
            .await
            .map_err(|err| {
                Error::conflict(format!("could not start the DNS resolver: {err}")).with_hint(
                    "another resolver may own the port; stop it or change dns_port in Settings",
                )
            })?;
        tracing::info!(port = handle.local_addr().port(), "DNS resolver started");
        let mut guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(handle);
    }

    // Route .test queries to this resolver. The rule names the resolver's
    // real port, so it must be written after the socket exists.
    let resolver_port = {
        let guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_ref().map(|h| h.local_addr().port())
    };
    if let Some(resolver_port) = resolver_port {
        if PipeClient::is_available() {
            let mut client = PipeClient::connect()?;
            client.hello().await?;
            client.set_nrpt_rule(&suffix, resolver_port).await?;
            tracing::info!(%suffix, resolver_port, "NRPT rule installed");
        }
    }

    dns_status(state).await
}

/// Stops the bundled resolver and removes the NRPT rule.
#[tauri::command]
#[specta::specta]
pub async fn dns_stop(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());

    if PipeClient::is_available() {
        if let Ok(mut client) = PipeClient::connect() {
            if client.hello().await.is_ok() {
                if let Err(err) = client.remove_nrpt_rule(&suffix).await {
                    tracing::warn!(error = %err, "could not remove the NRPT rule");
                }
            }
        }
    }

    let handle = state
        .dns
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(handle) = handle {
        handle.stop().await;
        tracing::info!("DNS resolver stopped");
    }

    dns_status(state).await
}

/// Reports the local CA's status: present on disk and machine-trusted.
#[tauri::command]
#[specta::specta]
pub async fn ca_status() -> Result<CaStatus, Error> {
    let paths = devx_core::AppPaths::discover()?;
    let exists = devx_provision::pki::load_ca(&paths.certs_dir())?.is_some();

    let trusted = if PipeClient::is_available() {
        match PipeClient::connect() {
            Ok(mut client) => match client.check_ca(devx_provision::pki::CA_FRIENDLY_NAME).await {
                Ok(installed) => Some(installed),
                Err(err) => {
                    tracing::warn!(error = %err, "could not check CA trust through the helper");
                    None
                }
            },
            Err(err) => {
                tracing::warn!(error = %err, "helper probe succeeded but connect failed");
                None
            }
        }
    } else {
        None
    };

    Ok(CaStatus { exists, trusted })
}

/// Creates the local CA (if missing) and installs it into the machine trust
/// store through the privileged helper.
#[tauri::command]
#[specta::specta]
pub async fn ca_install() -> Result<CaStatus, Error> {
    let paths = devx_core::AppPaths::discover()?;
    let ca = devx_provision::pki::ensure_ca(&paths.certs_dir())?;

    let mut client = PipeClient::connect()?;
    client.hello().await?;
    client
        .install_ca(&ca.cert_pem, devx_provision::pki::CA_FRIENDLY_NAME)
        .await?;

    tracing::info!("installed the DevX local CA into the machine trust store");
    ca_status().await
}

/// Removes the DevX CA from the machine trust store (the on-disk CA and any
/// issued site certificates are left in place for a later reinstall).
#[tauri::command]
#[specta::specta]
pub async fn ca_remove() -> Result<CaStatus, Error> {
    let mut client = PipeClient::connect()?;
    client.hello().await?;
    client
        .remove_ca(devx_provision::pki::CA_FRIENDLY_NAME)
        .await?;

    tracing::info!("removed the DevX local CA from the machine trust store");
    ca_status().await
}

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
fn sync_autostart_setting(app: &tauri::AppHandle) -> Result<bool, Error> {
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

/// GitHub repository DevX publishes releases to.
const RELEASES_REPO: &str = "devx/devx";

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

// --- Terminal -------------------------------------------------------------

/// The exit of one terminal command run.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TerminalExit {
    /// Which run this belongs to, matching the streamed `TerminalOutput`s.
    pub run_id: u32,
    /// Exit code, when the process ended normally.
    pub code: Option<i32>,
}

/// Monotonic run counter for terminal output routing.
static TERMINAL_RUN_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Runtime directories worth having on the terminal's `PATH`.
///
/// Every installed runtime's directory is prepended (php, node, cloudflared
/// and friends keep their executables at the root; the databases nest them
/// in `bin`), so `php`, `composer` and `psql` resolve without the user
/// editing their system PATH — the whole point of the in-app terminal.
fn devx_path_entries(paths: &AppPaths) -> Vec<std::path::PathBuf> {
    let mut entries = Vec::new();
    let Ok(components) = std::fs::read_dir(paths.runtimes_dir()) else {
        return entries;
    };
    for component in components.flatten() {
        if !component.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(versions) = std::fs::read_dir(component.path()) else {
            continue;
        };
        for version in versions.flatten() {
            if !version.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let dir = version.path();
            entries.push(dir.clone());
            let bin = dir.join("bin");
            if bin.is_dir() {
                entries.push(bin);
            }
        }
    }
    entries
}

/// The `PATH` string the terminal runs with: DevX runtimes first, then the
/// system's own `PATH` untouched.
#[tauri::command]
#[specta::specta]
pub fn terminal_path(state: State<'_, AppState>) -> Result<String, Error> {
    let mut dirs = devx_path_entries(&state.paths);
    if let Some(system) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&system));
    }
    Ok(std::env::join_paths(dirs)
        .map_err(|err| Error::internal(format!("failed to build PATH: {err}")))?
        .to_string_lossy()
        .into_owned())
}

/// Runs one command through `cmd /c` in `cwd`, streaming its output.
///
/// Streams `TerminalOutput` events as lines arrive and resolves once the
/// process exits. This is a command runner, not a pty: interactive prompts
/// are not supported, which keeps the surface honest and typed. The child
/// gets the DevX runtimes on its `PATH` plus the usual working directory.
#[tauri::command]
#[specta::specta]
pub async fn terminal_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    command: String,
) -> Result<TerminalExit, Error> {
    use tauri_specta::Event as _;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid_input("the command must not be empty"));
    }
    let working_dir = std::path::PathBuf::from(&cwd);
    if !working_dir.is_absolute() || !working_dir.is_dir() {
        return Err(Error::invalid_input(format!(
            "`{cwd}` is not an existing directory"
        )));
    }

    let run_id = TERMINAL_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut path = devx_path_entries(&state.paths);
    if let Some(system) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&system));
    }
    let path = std::env::join_paths(path)
        .map_err(|err| Error::internal(format!("failed to build PATH: {err}")))?;

    let mut child = tokio::process::Command::new("cmd")
        .args(["/c", trimmed])
        .current_dir(&working_dir)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Process,
                format!("failed to run the command: {err}"),
            )
        })?;

    let mut streams: Vec<(String, Box<dyn tokio::io::AsyncRead + Unpin + Send>)> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        streams.push(("out".to_owned(), Box::new(stdout)));
    }
    if let Some(stderr) = child.stderr.take() {
        streams.push(("err".to_owned(), Box::new(stderr)));
    }

    let mut pump_tasks = Vec::new();
    for (stream, reader) in streams {
        let app = app.clone();
        pump_tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(text)) = lines.next_line().await {
                let _ = crate::events::TerminalOutput {
                    run_id,
                    stream: stream.clone(),
                    text,
                }
                .emit(&app);
            }
        }));
    }

    let output = child.wait().await.map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Process,
            format!("failed to await the command: {err}"),
        )
    })?;
    for task in pump_tasks {
        task.abort();
    }

    Ok(TerminalExit {
        run_id,
        code: output.code(),
    })
}

// --- Templates -------------------------------------------------------------

/// One scaffoldable site template, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TemplateInfo {
    /// Template identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// What the template sets up.
    pub description: String,
    /// Whether the files are generated locally, without downloading.
    pub local: bool,
}

/// Lists the site templates DevX can scaffold.
///
/// Templates follow the catalog's integrity policy: anything needing a
/// download without an obtainable checksum (WordPress publishes none for its
/// zip; Laravel scaffolds through composer) is not offered as a download —
/// the template only carries the suggested terminal command.
#[tauri::command]
#[specta::specta]
pub fn template_list() -> Result<Vec<TemplateInfo>, Error> {
    Ok(vec![
        TemplateInfo {
            id: "static".into(),
            name: "Static site".into(),
            description: "A single index.html page served as-is.".into(),
            local: true,
        },
        TemplateInfo {
            id: "php".into(),
            name: "PHP site".into(),
            description: "An index.php stub so the FastCGI pool has something to serve.".into(),
            local: true,
        },
        TemplateInfo {
            id: "wordpress".into(),
            name: "WordPress".into(),
            description: "Suggested terminal command; the upstream zip has no verifiable checksum, so DevX does not download it.".into(),
            local: false,
        },
        TemplateInfo {
            id: "laravel".into(),
            name: "Laravel".into(),
            description: "Suggested terminal command; scaffolding runs through composer and the PHP pool.".into(),
            local: false,
        },
    ])
}

/// The suggested terminal command for templates DevX will not download.
fn template_command(template_id: &str) -> Option<String> {
    match template_id {
        "wordpress" => Some(
            "curl -L -o wordpress.zip https://wordpress.org/latest.zip && tar -xf wordpress.zip && move wordpress\\* . && del wordpress.zip"
                .to_owned(),
        ),
        "laravel" => Some("composer create-project laravel/laravel .".to_owned()),
        _ => None,
    }
}

/// The result of scaffolding a site from a template.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TemplateCreateResult {
    /// The site that was created.
    pub hostname: String,
    /// The suggested terminal command, when the template delegates to one.
    pub follow_up_command: Option<String>,
}

/// Scaffolds `template_id` into `docroot` and creates the site.
///
/// Local templates write their files into the (created) docroot and never
/// overwrite existing content; download-based templates only create the
/// folder and return their suggested command, to be run in the Terminal.
#[tauri::command]
#[specta::specta]
pub async fn template_create(
    state: State<'_, AppState>,
    template_id: String,
    hostname: String,
    docroot: String,
    php_version: String,
    https: bool,
) -> Result<TemplateCreateResult, Error> {
    let docroot_path = std::path::PathBuf::from(&docroot);
    if !docroot_path.is_absolute() {
        return Err(Error::invalid_input(format!(
            "`{docroot}` must be an absolute path"
        )));
    }
    if docroot_path.is_file() {
        return Err(Error::invalid_input(format!(
            "`{docroot}` is a file, not a directory"
        )));
    }

    let not_empty = docroot_path
        .is_dir()
        .then(|| std::fs::read_dir(&docroot_path).ok())
        .flatten()
        .and_then(|mut entries| entries.next().map(|_| ()))
        .is_some();
    if not_empty {
        return Err(Error::conflict(format!(
            "`{docroot}` already exists and is not empty"
        )));
    }

    let follow_up_command = template_command(&template_id);
    match template_id.as_str() {
        "static" | "php" | "wordpress" | "laravel" => {
            std::fs::create_dir_all(&docroot_path).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to create {}: {err}", docroot_path.display()),
                )
            })?;
        }
        other => {
            return Err(Error::invalid_input(format!("unknown template `{other}`")));
        }
    }

    match template_id.as_str() {
        "static" => {
            let body = concat!(
                "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n",
                "  <title>New site</title>\n</head>\n<body>\n  <h1>New site</h1>\n",
                "  <p>Scaffolded by DevX. Replace this page with your own.</p>\n",
                "</body>\n</html>\n"
            );
            devx_core::fsx::write_atomic(docroot_path.join("index.html"), body)?;
        }
        "php" => {
            let body = concat!(
                "<?php\ndeclare(strict_types=1);\n\n",
                "echo 'New PHP site scaffolded by DevX.';\n"
            );
            devx_core::fsx::write_atomic(docroot_path.join("index.php"), body)?;
        }
        _ => {
            // Download-based templates leave the folder to the suggested command.
        }
    }

    // Reuse the site_add machinery: validate, persist, sync the block.
    let statuses = site_add(state, hostname.clone(), docroot, php_version, https).await?;

    let Some(created) = statuses
        .iter()
        .find(|site| site.hostname.eq_ignore_ascii_case(&hostname))
    else {
        return Err(Error::internal("the site was not created"));
    };
    tracing::info!(
        hostname = %created.hostname,
        template = %template_id,
        "site scaffolded from template"
    );

    Ok(TemplateCreateResult {
        hostname: created.hostname.clone(),
        follow_up_command,
    })
}

// --- Scheduler -------------------------------------------------------------

/// One scheduled task, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct CronStatus {
    /// The user-chosen task name (Windows task: `DevX <name>`).
    pub name: String,
    /// Program to run; a relative name runs off `PATH`.
    pub program: Option<String>,
    /// PHP version running the task, when DevX supplies the interpreter.
    pub php_version: Option<String>,
    /// Arguments passed to the program.
    pub args: Vec<String>,
    /// Directory the task runs in.
    pub working_dir: String,
    /// The interval in minutes.
    pub every_minutes: u32,
    /// Whether the Windows scheduled task exists right now.
    pub registered: bool,
}

/// Prefix of every Windows task name DevX creates.
const CRON_TASK_PREFIX: &str = "DevX ";

/// Lists the configured scheduled tasks with their Windows registration.
#[tauri::command]
#[specta::specta]
pub fn cron_list(state: State<'_, AppState>) -> Result<Vec<CronStatus>, Error> {
    let jobs = state.with_config(|store| store.config().cron.clone());
    Ok(jobs
        .iter()
        .map(|job| CronStatus {
            name: job.name.clone(),
            program: job.program.clone(),
            php_version: job.php_version.clone(),
            args: job.args.clone(),
            working_dir: job.working_dir.clone(),
            every_minutes: job.every_minutes,
            registered: cron_task_exists(&job.name),
        })
        .collect())
}

/// Creates or updates a scheduled task: persist the definition, then
/// reconcile the Windows task with it.
#[tauri::command]
#[specta::specta]
pub async fn cron_set(
    state: State<'_, AppState>,
    name: String,
    program: Option<String>,
    php_version: Option<String>,
    args: Vec<String>,
    working_dir: String,
    every_minutes: u32,
) -> Result<Vec<CronStatus>, Error> {
    let job = devx_core::CronJob {
        name,
        program,
        php_version,
        args,
        working_dir,
        every_minutes,
    };

    // `update` validates the whole config: name shape, program/php_version
    // exclusivity, interval bounds — all before anything persists.
    state.with_config_mut(|store| {
        store.update(|config| {
            config.cron.retain(|c| c.name != job.name);
            config.cron.push(job.clone());
        })
    })?;

    // Reconcile the OS task: config is the intent, schtasks the mechanism.
    cron_task_create(&job).await?;

    cron_list(state)
}

/// Deletes a scheduled task from the config and from Windows.
#[tauri::command]
#[specta::specta]
pub async fn cron_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<CronStatus>, Error> {
    state.with_config_mut(|store| store.update(|config| config.cron.retain(|c| c.name != name)))?;

    cron_task_delete(&name).await;

    cron_list(state)
}

/// The Windows task name for a DevX cron job.
fn cron_task_name(name: &str) -> String {
    format!("{CRON_TASK_PREFIX}{name}")
}

/// Whether the Windows scheduled task for `name` exists.
fn cron_task_exists(name: &str) -> bool {
    use std::os::windows::process::CommandExt as _;

    std::process::Command::new("schtasks")
        .args(["/Query", "/TN", &cron_task_name(name)])
        .creation_flags(0x0800_0000)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// The full command line a task runs, resolving a DevX PHP version when set.
///
/// `schtasks` has no start-in-directory flag, so the working directory is
/// part of the command: the payload changes into it before running.
fn cron_command_line(job: &devx_core::CronJob) -> Result<String, Error> {
    let program = match (&job.program, &job.php_version) {
        (Some(program), None) => program.clone(),
        (None, Some(version)) => format!("runtimes/php/{version}/php.exe"),
        _ => {
            return Err(Error::invalid_input(format!(
                "cron job `{}` must set exactly one of program or php_version",
                job.name
            )))
        }
    };

    let mut line = format!("cmd /c cd /d \"{}\"", job.working_dir);
    line.push_str(" && \"");
    line.push_str(&program);
    line.push('"');
    for arg in &job.args {
        line.push(' ');
        line.push_str(arg);
    }
    Ok(line)
}

/// Creates (or overwrites) the Windows scheduled task for `job`.
///
/// Runs per-user and unelevated: `schtasks /Create` for the current user
/// needs no admin, which keeps the helper out of scheduling entirely.
async fn cron_task_create(job: &devx_core::CronJob) -> Result<(), Error> {
    let line = cron_command_line(job)?;

    // /TR is stored verbatim, quotes and all:
    let output = tokio::process::Command::new("schtasks")
        .args([
            "/Create",
            "/TN",
            &cron_task_name(&job.name),
            "/TR",
            &line,
            "/SC",
            "MINUTE",
            "/MO",
            &job.every_minutes.to_string(),
            "/F",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .await
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Process,
                format!("failed to run schtasks: {err}"),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::new(
            devx_core::ErrorCode::Process,
            format!("schtasks failed for `{}`: {}", job.name, stderr.trim()),
        ));
    }

    Ok(())
}

/// Deletes the Windows scheduled task for `name`, tolerating absence.
async fn cron_task_delete(name: &str) {
    let _ = tokio::process::Command::new("schtasks")
        .args(["/Delete", "/TN", &cron_task_name(name), "/F"])
        .creation_flags(0x0800_0000)
        .output()
        .await;
}
