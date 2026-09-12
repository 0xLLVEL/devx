// Hide the console window on Windows release builds; keep it in debug so
// `tracing` output stays visible during development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    devx_desktop::run();
}
