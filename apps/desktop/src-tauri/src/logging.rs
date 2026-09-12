//! Process-wide tracing setup for the desktop shell.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Default filter directives when `DEVX_LOG` is unset.
const DEFAULT_FILTER: &str = "info,devx_core=debug,devx_desktop=debug";

/// Initialises tracing for the desktop process.
///
/// Idempotent: a second call is a no-op, which keeps tests that construct the
/// app more than once from panicking.
pub fn init() {
    let filter =
        EnvFilter::try_from_env("DEVX_LOG").unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_target(true)
                .with_ansi(cfg!(debug_assertions)),
        )
        .try_init();
}
