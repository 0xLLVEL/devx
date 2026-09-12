//! `devx-helper` — the privileged helper service binary.
//!
//! Runs as LocalSystem (installed as the `DevXHelper` service by the DevX
//! installer's NSIS hooks), serves the helper pipe until stopped, and does
//! nothing else. Logs to stderr; the service wrapper captures that into the
//! Windows event log.

// A service has no console: without this attribute a release build would
// flash an empty console window at every start.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

#[cfg(windows)]
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("devx_helper=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let backends: Arc<devx_helper::Backends> = Arc::new(devx_helper::Backends::system());

    tracing::info!("DevX privileged helper starting");
    if let Err(err) = devx_helper::server::serve_blocking(backends) {
        tracing::error!(error = %err, "helper loop terminated");
        std::process::exit(1);
    }
}

/// Off Windows the binary exists but refuses to run, keeping the workspace
/// buildable everywhere.
#[cfg(not(windows))]
fn main() {
    eprintln!("devx-helper requires Windows");
    std::process::exit(1);
}
