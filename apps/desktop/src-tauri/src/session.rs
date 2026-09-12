//! Session persistence: which services were running when DevX last exited.
//!
//! DevX deliberately keeps this in a session file next to the config rather
//! than inside `config.toml`: which services happen to be running is state,
//! not configuration, and hand-editing it should never be encouraged.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use devx_core::{Error, Result};

use crate::state::AppState;

/// Everything running right now, persisted on exit and restored on start.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// Supervised service ids that were active, e.g. `nginx`, `mailpit`,
    /// `php-pool-8.4.25`. Sorted; written atomically.
    #[serde(default)]
    pub services: BTreeSet<String>,
}

/// Path of the session file for `paths`.
///
/// Lives next to `config.toml` in the config root — small, user-owned, and
/// unlike the runtimes it is per-machine *behaviour* rather than roamed
/// settings, which the config/data split tolerates either way.
pub fn session_file(paths: &devx_core::AppPaths) -> PathBuf {
    paths.config_dir.join("session.json")
}

/// Reads the last session, or an empty one when absent or unreadable.
///
/// A corrupt session is treated as "nothing was running": the file records
/// convenience state only, and refusing to start over it would trade a
/// one-time restart of a service for a dead app.
pub fn load(paths: &devx_core::AppPaths) -> Session {
    let path = session_file(paths);
    match std::fs::read_to_string(&path) {
        Ok(body) => serde_json::from_str(&body).unwrap_or_default(),
        Err(_) => Session::default(),
    }
}

/// Saves the session atomically.
///
/// # Errors
///
/// Fails when the file cannot be written, which is surfaced as a warning at
/// the exit path — losing the list only costs a manual restart next launch.
pub fn save(paths: &devx_core::AppPaths, session: &Session) -> Result<()> {
    let path = session_file(paths);
    let body = serde_json::to_string_pretty(session)
        .map_err(|err| Error::config(format!("failed to serialize the session: {err}")))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Io,
                format!("failed to write {}: {err}", path.display()),
            )
        })
}

/// Captures every currently active service into a [`Session`].
pub fn capture(state: &AppState) -> Session {
    let services = state
        .services
        .ids()
        .into_iter()
        .filter(|id| {
            state
                .services
                .get(id)
                .is_some_and(|sup| sup.state().is_active())
        })
        .collect();

    Session { services }
}

/// Restores the services recorded in the last session.
///
/// Each entry is started independently: one broken install or occupied port
/// must not stop the others, and failures are logged rather than propagated.
/// Runs only when `restore_services_on_start` is set; the file is left alone
/// either way so the next exit overwrites it.
///
/// Called once from setup, spawning a background task: restoring must never
/// delay the window from appearing.
pub fn restore(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let restore_enabled =
        state.with_config(|store| store.config().general.restore_services_on_start);
    let session = load(&state.paths);

    if !restore_enabled {
        tracing::info!(
            services = session.services.len(),
            "service restore disabled; skipping"
        );
        return;
    }

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // Workers record one session id per instance; restore each named
        // worker once, starting all its instances (idempotent for the ones
        // already covered by another recorded instance id).
        let mut restored_workers: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();

        for id in &session.services {
            // Pools are their own ids (`php-pool-8.4.25`); services carry the
            // plain component id. All three are stored side by side.
            let result = if let Some(version) = id.strip_prefix("php-pool-") {
                start_pool(&state, version).await
            } else if let Some(name) = worker_name_of(id) {
                if restored_workers.insert(name.to_owned()) {
                    start_worker(&state, name).await
                } else {
                    Ok(())
                }
            } else {
                start_service(&state, id).await
            };
            match result {
                Ok(()) => tracing::info!(service = %id, "restored service"),
                Err(err) => {
                    tracing::warn!(service = %id, error = %err, "could not restore service")
                }
            }
        }
    });
}

/// The worker name behind a supervised id like `worker-queue-3`, if it is one.
///
/// Worker names are validated to lowercase DNS labels, so the final `-<n>`
/// segment is always the instance number.
fn worker_name_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("worker-")?;
    let (name, tail) = rest.rsplit_once('-')?;
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if name.is_empty() {
        return None;
    }
    Some(name)
}

/// Starts every instance of a configured worker, mirroring `worker_start`.
async fn start_worker(state: &AppState, name: &str) -> Result<()> {
    let worker = state
        .with_config(|store| {
            store
                .config()
                .workers
                .iter()
                .find(|w| w.name == name)
                .cloned()
        })
        .ok_or_else(|| {
            Error::not_found(format!("worker `{name}` is not configured; cannot restore"))
        })?;

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
    Ok(())
}

/// Starts a plain service by component id, resolving the newest installed
/// version — restore wants the version that is on disk now, not the one that
/// happened to be current last time.
async fn start_service(state: &AppState, component_id: &str) -> Result<()> {
    let Some(version) = newest_installed(state, component_id) else {
        return Err(Error::not_found(format!(
            "{component_id} is not installed; cannot restore"
        )));
    };

    let plan = crate::services::plan_service(&state.paths, component_id, &version, &[])?;
    let id = plan.spec.id.clone();

    crate::services::run_init_steps(&plan.init_steps).await?;

    let supervisor = match state.services.get(&id) {
        Some(existing) if existing.state().is_active() => existing,
        _ => state.services.register(plan.spec)?,
    };
    supervisor.start().await
}

/// Starts the FastCGI pool of one PHP version, mirroring `php_pool_start`.
async fn start_pool(state: &AppState, version: &str) -> Result<()> {
    let workers = state
        .with_config(|store| store.config().php_pools.get(version))
        .unwrap_or(devx_provision::DEFAULT_WORKERS);

    let config_dir = state
        .paths
        .service_config_dir()
        .join(devx_provision::pool_id(version));
    let port = match devx_provision::pool_listen_addr(&config_dir) {
        Ok(listen) => listen
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or_else(|| next_pool_port(state)),
        Err(_) => next_pool_port(state),
    };

    let plan = crate::services::plan_php_pool(
        &state.paths,
        version,
        port,
        workers,
        &state.with_config(|store| store.config().php_extensions.get(version).to_vec()),
    )?;
    let supervisor = match state.services.get(&plan.id) {
        Some(existing) if existing.state().is_active() => existing,
        _ => {
            let spec = crate::services::pool_spec(&state.paths, &plan)?;
            state.services.register(spec)?
        }
    };
    supervisor.start().await
}

/// The next free FastCGI port, past every port an installed pool claims.
fn next_pool_port(state: &AppState) -> u16 {
    let reserved = crate::services::existing_pool_ports(&state.paths);
    crate::services::next_pool_port(&state.paths, &reserved)
}

/// The newest installed version of `component_id`, if any.
///
/// Versions that do not parse as semver still count — they are preferred when
/// nothing better exists, keeping catalogue experiments installable.
fn newest_installed(state: &AppState, component_id: &str) -> Option<String> {
    let mut best_semver: Option<semver::Version> = None;
    let mut best_name: Option<String> = None;
    let versions = state.paths.runtimes_dir().join(component_id);

    let Ok(entries) = std::fs::read_dir(&versions) else {
        return None;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let raw = entry.file_name().to_string_lossy().into_owned();
        if !state.installer.is_installed(component_id, &raw) {
            continue;
        }

        match semver::Version::parse(&raw) {
            Ok(candidate) => {
                if best_semver
                    .as_ref()
                    .is_none_or(|current| candidate > *current)
                {
                    best_semver = Some(candidate);
                    best_name = Some(raw);
                }
            }
            // A non-semver directory is only chosen when nothing else exists.
            Err(_) if best_name.is_none() => best_name = Some(raw),
            Err(_) => {}
        }
    }

    best_name
}
