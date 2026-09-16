//! Integration tests for the desktop shell's IPC surface.
//!
//! These live in an integration test target (rather than `#[cfg(test)]` modules
//! inside the crate) because `build.rs` can only attach the Windows
//! Common-Controls manifest to test *targets*, and a test binary linking `tauri`
//! without that manifest fails to load. See `windows-test-manifest.xml`.

use devx_core::ErrorCode;
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

/// §110: the Port Inspector's Stop Process must refuse the PIDs that would end
/// the machine or DevX, and it must refuse them before it looks at the port —
/// so the refusal cannot depend on what happens to be listening.
#[test]
fn stop_process_refuses_the_pids_it_must_not_touch() {
    for pid in [0, 4, std::process::id()] {
        let error =
            commands::stop_process_on_port(pid, 80).expect_err("this PID must never be stopped");

        assert_eq!(
            error.code,
            ErrorCode::InvalidInput,
            "PID {pid} was refused for the wrong reason: {error}"
        );
        assert!(
            error.hint.is_some(),
            "PID {pid} was refused without saying what to do instead"
        );
    }
}

/// §110: PIDs are reused as soon as a process exits, so a row that is a few
/// seconds old must not be able to end whatever inherited the number. The
/// listener here belongs to this test process, and the PID in the request is
/// deliberately not it: the command must stop at the mismatch and never reach
/// the OS with a kill request.
#[test]
fn stop_process_will_not_kill_a_pid_that_no_longer_holds_the_port() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();

    // Not 0, 4 or our own PID, so the guard passes it through to the check
    // that matters here. The value is far outside the range Windows hands out.
    let stranger = u32::MAX - 3;

    let error = commands::stop_process_on_port(stranger, port)
        .expect_err("a PID that does not hold the port must be refused");

    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(
        error.message.contains(&std::process::id().to_string()),
        "the refusal should name the PID that holds the port now: {error}"
    );
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
