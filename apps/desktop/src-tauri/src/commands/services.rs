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
pub async fn services_stop_all(state: State<'_, AppState>) -> Result<Vec<BatchStartOutcome>, Error> {
    let ids = state.services.ids();
    let mut jobs = tokio::task::JoinSet::new();
    for id in ids {
        let supervisor = state.services.get(&id);
        jobs.spawn(async move {
            match supervisor {
                Some(s) if s.state().is_active() => {
                    s.stop().await;
                }
                _ => {}
            }
            Some(BatchStartOutcome { id, error: None })
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
