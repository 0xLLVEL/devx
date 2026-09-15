//! Queue worker commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

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
