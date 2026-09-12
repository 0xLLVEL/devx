//! Integration tests for the desktop shell's IPC surface.
//!
//! These live in an integration test target (rather than `#[cfg(test)]` modules
//! inside the crate) because `build.rs` can only attach the Windows
//! Common-Controls manifest to test *targets*, and a test binary linking `tauri`
//! without that manifest fails to load. See `windows-test-manifest.xml`.

use devx_desktop::{commands, ipc, logging};

/// Normalises line endings so comparisons survive git's autocrlf.
fn normalize(input: &str) -> String {
    input.replace("\r\n", "\n")
}

#[test]
fn builder_constructs_without_panicking() {
    // `collect_commands!` performs duplicate-name detection at runtime, so
    // constructing the builder is a meaningful regression test.
    let _ = ipc::builder();
}

#[test]
fn app_info_command_reports_current_build() {
    let info = commands::app_info().expect("app_info should not fail");
    assert_eq!(info.name, "DevX");
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    assert!(info.debug, "tests run against a debug build");
}

#[test]
fn logging_init_is_idempotent() {
    logging::init();
    logging::init();
}

#[test]
fn committed_bindings_match_command_registry() {
    let builder = ipc::builder();
    let dir = tempfile::tempdir().expect("create temp dir");
    let generated_path = dir.path().join("bindings.ts");

    ipc::export_bindings_to(&builder, &generated_path).expect("export bindings");
    let generated = std::fs::read_to_string(&generated_path).expect("read generated bindings");

    let committed_path = ipc::BINDINGS_PATH;

    if std::env::var_os("DEVX_UPDATE_BINDINGS").is_some() {
        std::fs::write(committed_path, &generated).expect("write committed bindings");
        return;
    }

    let committed = std::fs::read_to_string(committed_path).unwrap_or_else(|err| {
        panic!(
            "{committed_path} is missing ({err}); regenerate with \
             `DEVX_UPDATE_BINDINGS=1 cargo test -p devx-desktop`"
        )
    });

    assert_eq!(
        normalize(&committed),
        normalize(&generated),
        "{committed_path} is stale; regenerate with \
         `DEVX_UPDATE_BINDINGS=1 cargo test -p devx-desktop`"
    );
}
