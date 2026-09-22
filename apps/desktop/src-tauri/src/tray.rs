//! System tray: the icon in the notification area and its custom popup.
//!
//! The tray is the app's second face. Right-clicking the icon opens a small
//! popup window (HTML/CSS, styled like the rest of the app) instead of a
//! native OS menu, because native menus cannot be styled: no brand colors,
//! no typography, no radius. Left-click keeps the old behaviour and shows
//! the main window.
//!
//! The popup is a plain Tauri window (`tray-popup`, route `/tray`):
//! frameless, transparent, always-on-top, hidden from the taskbar. It hides
//! itself whenever it loses focus, which is what makes clicks outside it
//! dismiss it like a native menu. Closing the window hides it to the tray
//! when `close_to_tray` is set; quitting from the popup is the explicit way
//! out and takes the job objects (and every supervised service) with it.

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize,
};

use crate::state::AppState;

/// Label of the main window, as created from `tauri.conf.json` defaults.
const MAIN_LABEL: &str = "main";
/// Label of the popup window showing the tray menu.
const POPUP_LABEL: &str = "tray-popup";
/// Popup size in logical pixels; scaled by the monitor factor at show time.
const POPUP_SIZE_LOGICAL: (f64, f64) = (320.0, 460.0);
/// Gap between the cursor and the popup, in physical pixels.
const POPUP_GAP: i32 = 8;

/// Builds the tray icon and installs the close-to-tray hook.
///
/// Called once from setup, before the window is shown. The popup window is
/// created lazily on the first right-click so startup pays nothing for it.
///
/// # Errors
///
/// Fails when the tray icon cannot be created, which means a broken build
/// rather than a recoverable runtime condition.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let mut tray = TrayIconBuilder::with_id("devx-tray")
        .tooltip("DevX")
        .on_tray_icon_event(on_tray_icon_event);

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    Ok(())
}

/// Global window-event hook: hides windows that should not really close.
///
/// Only the main window hides to the tray on close (when `close_to_tray` is
/// set). The popup hides whenever it loses focus, which is the light-dismiss
/// behaviour a menu needs.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_LABEL => {
            let Some(state) = window.app_handle().try_state::<AppState>() else {
                return;
            };
            let close_to_tray = state.with_config(|store| store.config().general.close_to_tray);
            if close_to_tray {
                api.prevent_close();
                let _ = window.hide();
            }
        }
        tauri::WindowEvent::Focused(false) if window.label() == POPUP_LABEL => {
            let _ = window.hide();
        }
        _ => {}
    }
}

/// Shows the main window, focusing it.
#[tauri::command]
#[specta::specta]
pub fn tray_show_main(app: AppHandle) -> Result<(), devx_core::Error> {
    show_main(&app);
    Ok(())
}

/// Quits the app, stopping every supervised service first (via the normal
/// exit path, which the tray used before the popup existed).
#[tauri::command]
#[specta::specta]
pub fn tray_quit(app: AppHandle) -> Result<(), devx_core::Error> {
    tracing::info!("quit requested from the tray popup");
    app.exit(0);
    Ok(())
}

/// Reacts to tray icon clicks: left shows the window, right toggles the popup.
fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button,
        button_state,
        position,
        ..
    } = event
    else {
        return;
    };
    if button_state != MouseButtonState::Up {
        return;
    }
    let app = tray.app_handle();
    match button {
        MouseButton::Left => show_main(app),
        MouseButton::Right => toggle_popup(app, position),
        MouseButton::Middle => {}
    }
}

/// Shows the main window, focusing it. Shared by left-click and the popup.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Shows the popup at the click position, or hides it when already visible.
fn toggle_popup(app: &AppHandle, position: PhysicalPosition<f64>) {
    let window = match app.get_webview_window(POPUP_LABEL) {
        Some(window) => window,
        None => match build_popup(app) {
            Ok(window) => window,
            Err(err) => {
                tracing::warn!(error = %err, "could not build the tray popup");
                return;
            }
        },
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let (w, h) = popup_physical_size(app, position);
    let (x, y) = popup_position(app, position, w, h);
    let _ = window.set_size(PhysicalSize::new(w, h));
    if let Err(err) = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y))) {
        tracing::warn!(error = %err, "could not place the tray popup");
        return;
    }
    if window.show().is_ok() {
        let _ = window.set_focus();
    }
}

/// Creates the hidden popup window. The frontend serves route `/tray` in it.
fn build_popup(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, POPUP_LABEL, tauri::WebviewUrl::App("/tray".into()))
        .title("DevX")
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()
}

/// Popup size in physical pixels for the monitor under the click.
fn popup_physical_size(app: &AppHandle, position: PhysicalPosition<f64>) -> (u32, u32) {
    let scale = monitor_containing(app, position)
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    (
        (POPUP_SIZE_LOGICAL.0 * scale).round() as u32,
        (POPUP_SIZE_LOGICAL.1 * scale).round() as u32,
    )
}

/// Popup top-left in physical pixels for the monitor under the click.
fn popup_position(app: &AppHandle, position: PhysicalPosition<f64>, w: u32, h: u32) -> (i32, i32) {
    let anchor_x = position.x.round() as i32;
    let anchor_y = position.y.round() as i32;
    match monitor_containing(app, position) {
        Some(monitor) => {
            let origin = monitor.position();
            let size = monitor.size();
            popup_rect(
                (anchor_x, anchor_y),
                (w, h),
                (origin.x, origin.y, size.width, size.height),
            )
        }
        // No monitor reported: show above the cursor and hope for the best.
        None => (anchor_x - w as i32 / 2, anchor_y - POPUP_GAP - h as i32),
    }
}

/// Finds the monitor containing a physical point, if the OS reports any.
fn monitor_containing(app: &AppHandle, position: PhysicalPosition<f64>) -> Option<tauri::Monitor> {
    let (x, y) = (position.x.round() as i32, position.y.round() as i32);
    app.available_monitors().ok()?.into_iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        x >= origin.x
            && x < origin.x + size.width as i32
            && y >= origin.y
            && y < origin.y + size.height as i32
    })
}

/// Top-left corner for a popup anchored at a click, clamped to the monitor.
/// Prefers above the cursor (taskbar at the bottom, the common case) and
/// flips below when there is no room; always stays on screen, so top
/// taskbars and multi-monitor offsets cannot push it out of view.
fn popup_rect(
    (anchor_x, anchor_y): (i32, i32),
    (w, h): (u32, u32),
    (mon_x, mon_y, mon_w, mon_h): (i32, i32, u32, u32),
) -> (i32, i32) {
    let w = w as i32;
    let h = h as i32;
    let mon_w = mon_w as i32;
    let mon_h = mon_h as i32;

    let x = (anchor_x - w / 2).clamp(mon_x, mon_x + mon_w - w);

    let above = anchor_y - POPUP_GAP - h;
    let y = if above >= mon_y {
        above
    } else {
        (anchor_y + POPUP_GAP).min(mon_y + mon_h - h)
    }
    .max(mon_y);

    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One 1080p monitor at the origin; the tray lives bottom-right.
    const MON: (i32, i32, u32, u32) = (0, 0, 1920, 1080);

    #[test]
    fn popup_prefers_above_the_cursor() {
        let (x, y) = popup_rect((1800, 1060), (320, 460), MON);
        assert_eq!((x, y), (1600, 592));
    }

    #[test]
    fn popup_flips_below_when_no_room_above() {
        // Top taskbar: the cursor sits near the top edge.
        let (x, y) = popup_rect((1800, 20), (320, 460), MON);
        assert_eq!((x, y), (1600, 28));
    }

    #[test]
    fn popup_clamps_into_narrow_monitors() {
        // A popup taller than the monitor still stays on screen.
        let (x, y) = popup_rect((100, 100), (320, 2000), MON);
        assert_eq!((x, y), (0, 0));
    }

    #[test]
    fn popup_handles_offset_monitors() {
        // Second monitor to the right of the primary.
        let (x, y) = popup_rect((2100, 1060), (320, 460), (1920, 0, 1920, 1080));
        assert_eq!((x, y), (1940, 592));
    }
}
