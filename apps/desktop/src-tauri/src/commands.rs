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
    let plan = crate::services::plan_php_pool(&state.paths, &version, port, workers)?;
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
