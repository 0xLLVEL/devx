//! DevX desktop shell.
//!
//! Thin Tauri layer: it wires the typed IPC surface to the domain crates and
//! owns nothing of the domain itself.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod commands;
pub mod event_log;
pub mod events;
pub mod helper;
pub mod ipc;
pub mod logging;
pub mod mail;
pub mod notifications;
pub mod services;
pub mod session;
pub mod state;
pub mod tray;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tauri_specta::Event;

/// Runs the DevX desktop application.
///
/// # Panics
///
/// Panics if the Tauri context cannot be initialised, which indicates a broken
/// build rather than a recoverable runtime condition.
pub fn run() {
    logging::init();

    let ipc_builder = ipc::builder();

    #[cfg(debug_assertions)]
    if let Err(err) = ipc::export_bindings(&ipc_builder) {
        // A failed export must not stop the app: the developer still gets a
        // running window, just with stale bindings.
        tracing::error!("{err}");
    }

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "starting DevX desktop shell"
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch means the user clicked the icon again: surface
            // the existing window instead of spawning a second app.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(ipc_builder.invoke_handler())
        .on_window_event(tray::on_window_event)
        .setup(move |app| {
            ipc_builder.mount_events(app);

            // Configuration and directory layout must exist before any command
            // can run, so failure here is fatal and reported verbatim.
            let state = state::AppState::initialise()?;
            app.manage(state);

            tray::init(app.handle())?;

            // Reconcile the OS autostart entry with the setting: the registry
            // key is the OS's state, and startup is the one place where a
            // silent repair (e.g. after a renamed executable) is safe.
            let _ = commands::settings_sync_autostart(app.handle().clone());

            // Re-render the nginx site blocks at startup: on-disk state must
            // match the config even after an app update changed the rendered
            // format, and before the auto-started resolver matters.
            if let Err(err) = commands::sync_site_blocks(&app.state()) {
                tracing::warn!(error = %err, "could not sync nginx site blocks at startup");
            }

            session::restore(app.handle().clone());

            // Bring the DNS resolver up with the app: sites resolve without a
            // manual Start. In hosts-file mode there is no resolver to run.
            let dns_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mode = dns_handle
                    .state::<state::AppState>()
                    .with_config(|store| store.config().network.dns_mode);
                if mode == devx_core::DnsMode::Resolver {
                    if let Err(err) = commands::dns_start(dns_handle.state()).await {
                        tracing::warn!(error = %err, "could not auto-start the DNS resolver");
                    }
                }
            });

            spawn_service_watcher(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevX")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                persist_session(app);
                shutdown_services(app);
                shutdown_privileged(app);
            }
        });
}

/// Shuts down all supervised background services and the DNS resolver on full app exit.
///
/// Running services are persisted to `session.json` *before* this function runs so
/// that next launch can restore them if configured. Services are stopped concurrently
/// with a 5-second timeout, ensuring clean termination without hanging the exit.
fn shutdown_services(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<state::AppState>() else {
        return;
    };

    let teardown = async {
        // 1. Stop the bundled DNS resolver if active.
        let dns_handle = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = dns_handle {
            handle.stop().await;
            tracing::info!("DNS resolver stopped on exit");
        }

        // 2. Stop all active supervised services concurrently.
        state.services.stop_all().await;
        tracing::info!("all background services stopped on exit");
    };

    let bounded = async {
        tokio::select! {
            _ = teardown => tracing::info!("services shutdown completed cleanly"),
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                tracing::warn!("services shutdown timed out after 5s; proceeding with exit");
            }
        }
    };

    tauri::async_runtime::block_on(bounded);
}

/// Captures the running services so the next launch can restore them.
///
/// Called on the exit event. Losing the file only costs a manual restart of
/// a service next launch, so failures are logged, never fatal.
pub fn persist_session(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<state::AppState>() else {
        return;
    };
    let snapshot = session::capture(&state);

    if let Err(err) = session::save(&state.paths, &snapshot) {
        tracing::warn!(error = %err, "could not persist the session");
    }
}

/// Tears the privileged side down on a full app exit.
///
/// The supervised services die with the job objects; what would otherwise
/// outlive the app is the helper process DevX elevated and the NRPT rule
/// pointing *.test at a resolver that no longer exists. Both are cleaned
/// here: the rule is removed first (the helper must be alive for that),
/// then the helper is asked to exit. Every step is best-effort — an
/// unreachable helper simply means there is nothing to clean.
fn shutdown_privileged(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let Some(state) = app.try_state::<state::AppState>() else {
        return;
    };
    if !devx_privileged::PipeClient::is_available() {
        return;
    }

    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());

    let teardown = async {
        let mut client = devx_privileged::PipeClient::connect()?;
        client.hello().await?;
        if let Err(err) = client.remove_nrpt_rule(&suffix).await {
            tracing::warn!(error = %err, "could not remove the NRPT rule on exit");
        }
        client.shutdown().await
    };

    match tauri::async_runtime::block_on(teardown) {
        Ok(()) => tracing::info!("privileged helper stopped"),
        Err(err) => {
            tracing::debug!(error = %err, "privileged teardown skipped (helper may be manual)");
        }
    }
}

/// Relays supervised-service transitions to the user.
///
/// Every transition is emitted as a typed event so the frontend reacts the
/// moment something happens; a non-requested failure additionally surfaces as
/// a Windows notification, unless the setting is turned off. A lagged receiver
/// is not fatal — the frontend's polling resyncs statuses on its own.
fn spawn_service_watcher(app: tauri::AppHandle) {
    let state = app.state::<state::AppState>();
    let mut events = state.services.events();
    let paths = state.paths.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let update = events::ServiceEventUpdate {
                        event: event.clone(),
                    };
                    if let Err(err) = update.emit(&app) {
                        tracing::warn!(error = %err, "could not emit service event");
                    }

                    event_log::record(&paths, &event);

                    if event.state == devx_proc::ServiceState::Failed {
                        notify_failure(&app, &event);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::warn!(
                        missed,
                        "service event bus lagged; statuses resync by polling"
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Sends the failure toast, when the setting allows it.
fn notify_failure(app: &tauri::AppHandle, event: &devx_proc::ServiceEvent) {
    let notify = app
        .state::<state::AppState>()
        .with_config(|config| config.config().general.notify_on_failure);
    if !notify {
        return;
    }

    let body = match &event.exit {
        Some(devx_proc::ExitReason::Crashed { code: Some(code) }) => {
            format!("{} exited unexpectedly (code {code}).", event.id)
        }
        Some(devx_proc::ExitReason::Crashed { code: None }) => {
            format!("{} exited unexpectedly.", event.id)
        }
        Some(devx_proc::ExitReason::HealthTimeout) => format!(
            "{} started but never became healthy; check its logs.",
            event.id
        ),
        Some(devx_proc::ExitReason::SpawnFailed { message }) => {
            format!("{} could not start: {message}.", event.id)
        }
        _ => format!("{} failed. Check its logs in DevX.", event.id),
    };

    if let Err(err) = app
        .notification()
        .builder()
        .title("DevX service failed")
        .body(body)
        .show()
    {
        tracing::warn!(error = %err, id = %event.id, "could not show failure notification");
    }
}
