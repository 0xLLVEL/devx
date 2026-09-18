//! Supervised-service lifecycle commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

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

    let custom_port = state.with_config(|store| {
        let config = store.config();
        config
            .service_ports
            .get(&component_id)
            .copied()
            .or_else(|| {
                if component_id == "nginx" {
                    Some(config.network.http_port)
                } else {
                    None
                }
            })
    });

    let plan =
        crate::services::plan_service(&state.paths, &component_id, &version, &[], custom_port)?;
    let id = plan.spec.id.clone();

    // One-time init (initdb, mysql_install_db) must complete before launch.
    crate::services::run_init_steps(&plan.init_steps).await?;

    let supervisor = match state.services.get(&id) {
        Some(existing) if existing.state().is_active() => existing,
        _ => state.services.register(plan.spec)?,
    };

    supervisor.start().await?;

    // Web servers route PHP requests to FastCGI pools; start any needed pools
    if matches!(
        component_id.as_str(),
        "nginx" | "apache" | "caddy" | "frankenphp"
    ) {
        let sites = state.with_config(|store| store.config().sites.clone());
        for site in sites {
            if let Some(php_ver) = site.php() {
                if state.installer.is_installed("php", php_ver) {
                    let pool_id = devx_provision::pool_id(php_ver);
                    let is_active = state
                        .services
                        .get(&pool_id)
                        .is_some_and(|s| s.state().is_active());
                    if !is_active {
                        let workers = crate::commands::php::pool_workers(&state, php_ver);
                        let _ =
                            crate::commands::php::start_php_pool_internal(&state, php_ver, workers)
                                .await;
                    }
                }
            }
        }
    }

    Ok(ServiceStatus {
        id,
        state: supervisor.state(),
    })
}

/// Sets or clears a custom port for a supervised service component or PHP pool.
///
/// If port is `Some(p)`, sets the custom port (p must be > 0). If `None`, clears the custom port.
/// Re-renders configuration, restarts active services/pools, and re-syncs site blocks.
#[tauri::command]
#[specta::specta]
pub async fn service_set_port(
    state: State<'_, AppState>,
    component_id: String,
    port: Option<u16>,
) -> Result<std::collections::BTreeMap<String, u16>, Error> {
    if let Some(p) = port {
        if p == 0 {
            return Err(Error::invalid_input("port must be greater than 0"));
        }
    }

    let php_version = if devx_provision::is_pool_id(&component_id) {
        devx_provision::version_of_pool(&component_id).map(str::to_string)
    } else if state.installer.is_installed("php", &component_id) {
        Some(component_id.clone())
    } else {
        None
    };

    state.with_config_mut(|store| {
        store.update(|config| {
            if let Some(p) = port {
                config.service_ports.insert(component_id.clone(), p);
                if let Some(ref ver) = php_version {
                    config.service_ports.insert(devx_provision::pool_id(ver), p);
                    config.service_ports.insert(ver.clone(), p);
                }
            } else {
                config.service_ports.remove(&component_id);
                if let Some(ref ver) = php_version {
                    config.service_ports.remove(&devx_provision::pool_id(ver));
                    config.service_ports.remove(ver);
                }
            }
        })
    })?;

    if let Some(ref ver) = php_version {
        crate::php_pool::PhpPool::new(state.clone())
            .restart_with(ver)
            .await?;
        let _ = crate::commands::sites::sync_site_blocks(&state);
    } else {
        // If nginx port changed, re-sync site server blocks
        if component_id == "nginx" {
            let _ = crate::commands::sites::sync_site_blocks(&state);
        }

        // If the service is running, restart it with the new port
        if let Some(supervisor) = state.services.get(&component_id) {
            if supervisor.state().is_active() {
                let runtimes = state.paths.runtimes_dir().join(&component_id);
                if let Ok(entries) = std::fs::read_dir(&runtimes) {
                    let mut versions: Vec<String> = entries
                        .flatten()
                        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|v| runtimes.join(v).join(".devx-ok").is_file())
                        .collect();
                    versions.sort();
                    if let Some(version) = versions.pop() {
                        supervisor.stop().await;
                        if let Ok(plan) = crate::services::plan_service(
                            &state.paths,
                            &component_id,
                            &version,
                            &[],
                            port,
                        ) {
                            if let Ok(replacement) = state.services.register(plan.spec) {
                                let _ = replacement.start().await;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(state.with_config(|store| store.config().service_ports.clone()))
}

/// Returns the configured custom service ports map.
#[tauri::command]
#[specta::specta]
pub fn service_get_ports(
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, u16>, Error> {
    Ok(state.with_config(|store| store.config().service_ports.clone()))
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

/// Starts every registered service that is not already running.
///
/// Starts run concurrently; each failure is collected rather than aborting
/// the rest, so one broken service never blocks bringing up the others.
/// The result pairs each id with its outcome, keeping partial-success
/// honest in the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct BatchStartOutcome {
    /// Service identifier.
    pub id: String,
    /// `None` on success; the error message when that one failed.
    pub error: Option<String>,
}

/// Starts every service that is not running; see [`BatchStartOutcome`].
#[tauri::command]
#[specta::specta]
pub async fn services_start_all(
    state: State<'_, AppState>,
) -> Result<Vec<BatchStartOutcome>, Error> {
    // Also start installed PHP pools so sites don't hit 502 Bad Gateway
    let php_versions =
        crate::commands::php::installed_php_versions(state.paths.runtimes_dir().join("php"));
    for version in &php_versions {
        let workers = crate::commands::php::pool_workers(&state, version);
        let _ = crate::commands::php::start_php_pool_internal(&state, version, workers).await;
    }

    let ids = state.services.ids();
    let mut jobs = tokio::task::JoinSet::new();
    for id in ids {
        let supervisor = state.services.get(&id);
        jobs.spawn(async move {
            match supervisor {
                Some(s) if s.state().can_start() => {
                    if let Err(err) = s.start().await {
                        Some(BatchStartOutcome {
                            id,
                            error: Some(err.to_string()),
                        })
                    } else {
                        Some(BatchStartOutcome { id, error: None })
                    }
                }
                Some(_) => Some(BatchStartOutcome { id, error: None }),
                None => None,
            }
        });
    }

    let mut outcomes: Vec<BatchStartOutcome> = Vec::new();
    while let Some(result) = jobs.join_next().await {
        if let Ok(Some(outcome)) = result {
            outcomes.push(outcome);
        }
    }
    outcomes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(outcomes)
}

/// Stops every active supervised service, concurrently and non-fatal per
/// service, exactly as [`services_start_all`] starts them.
#[tauri::command]
#[specta::specta]
pub async fn services_stop_all(
    state: State<'_, AppState>,
) -> Result<Vec<BatchStartOutcome>, Error> {
    let ids = state.services.ids();
    state.services.stop_all().await;
    let outcomes = ids
        .into_iter()
        .map(|id| BatchStartOutcome { id, error: None })
        .collect();
    Ok(outcomes)
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
