//! DevX desktop shell.
//!
//! Thin Tauri layer: it wires the typed IPC surface to the domain crates and
//! owns nothing of the domain itself.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod commands;
pub mod events;
pub mod ipc;
pub mod logging;
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

            session::restore(app.handle().clone());

            spawn_service_watcher(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevX")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                persist_session(app);
            }
        });
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

/// Relays supervised-service transitions to the user.
///
/// Every transition is emitted as a typed event so the frontend reacts the
/// moment something happens; a non-requested failure additionally surfaces as
/// a Windows notification, unless the setting is turned off. A lagged receiver
/// is not fatal — the frontend's polling resyncs statuses on its own.
fn spawn_service_watcher(app: tauri::AppHandle) {
    let state = app.state::<state::AppState>();
    let mut events = state.services.events();

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
