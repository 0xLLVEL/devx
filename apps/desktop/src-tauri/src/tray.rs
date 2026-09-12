//! System tray: the icon in the notification area and its menu.
//!
//! The tray is the app's second face. It offers what the window offers minus
//! what only the window can do — show/hide and quit, with the full UI one
//! click away. Closing the window hides it to the tray when `close_to_tray`
//! is set; quitting from the tray menu is the explicit way out and takes the
//! job objects (and every supervised service) with it.

use tauri::{
    menu::{CheckMenuItem, MenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::state::AppState;

/// Menu item ids, matched in [`on_menu_event`].
const ID_SHOW: &str = "show";
const ID_CLOSE_TO_TRAY: &str = "close-to-tray";
const ID_QUIT: &str = "quit";

/// Builds the tray icon and its menu, and installs the close-to-tray hook.
///
/// Called once from setup, before the window is shown.
///
/// # Errors
///
/// Fails when the menu or tray icon cannot be created, which means a broken
/// build rather than a recoverable runtime condition.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let close_to_tray = state.with_config(|store| store.config().general.close_to_tray);

    let show = CheckMenuItem::with_id(app, ID_SHOW, "Show DevX", true, true, None::<&str>)?;
    let pin = CheckMenuItem::with_id(
        app,
        ID_CLOSE_TO_TRAY,
        "Close to tray",
        true,
        close_to_tray,
        None::<&str>,
    )?;
    let quit = CheckMenuItem::with_id(app, ID_QUIT, "Quit DevX", true, false, None::<&str>)?;

    let menu = MenuBuilder::new(app).items(&[&show, &pin, &quit]).build()?;

    let mut tray = TrayIconBuilder::with_id("devx-tray")
        .menu(&menu)
        .tooltip("DevX")
        .on_menu_event(on_menu_event);

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    Ok(())
}

/// Global window-event hook: hides the main window to the tray on close when
/// `close_to_tray` is set.
///
/// Registered on the Tauri [`tauri::Builder`]. The config is read on every
/// close request, so toggling the setting in the UI takes effect immediately
/// without rebuilding anything.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        return;
    }
    let Some(state) = window.app_handle().try_state::<AppState>() else {
        return;
    };
    let close_to_tray = state.with_config(|store| store.config().general.close_to_tray);

    if close_to_tray {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Suppress this close; the window stays alive in the tray.
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Reacts to tray menu clicks.
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        ID_SHOW => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        ID_QUIT => {
            tracing::info!("quit requested from the tray");
            app.exit(0);
        }
        // The two check items are pure settings: the close-to-tray one is read
        // live from config at close time, and "Show" is checked whenever the
        // window is visible. Nothing to do beyond ignoring unknown ids.
        _ => {}
    }
}
