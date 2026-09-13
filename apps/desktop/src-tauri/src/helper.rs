//! On-demand elevation of the privileged helper.
//!
//! Flows that need Windows elevation (NRPT rules, the hosts file, the
//! certificate store) talk to the DevXHelper pipe. The flow the user sees:
//! open DevX → one UAC prompt → the helper starts automatically → the
//! resolver comes up. DevX spawns the helper executable with the `runas`
//! verb, so it runs elevated in the background until it is stopped or the
//! machine reboots; the next launch repeats the same one-prompt dance.

use std::path::PathBuf;
use std::time::Duration;

use devx_core::{Error, Result};
use devx_privileged::PipeClient;

/// How long to wait for the helper pipe after launching the process.
const PIPE_WAIT: Duration = Duration::from_secs(15);

/// Ensures the privileged helper is running, prompting for elevation when
/// needed.
///
/// Returns immediately when the pipe already answers. Otherwise the helper
/// executable is located next to the running app (dev layout) or in the
/// install directory (packaged layout), launched through one UAC prompt,
/// and the pipe is polled until it comes up.
///
/// # Errors
///
/// Fails when the helper executable cannot be found, the spawn fails, or
/// the pipe never appears within the wait window — typically because the
/// UAC prompt was declined.
pub async fn ensure_helper_running() -> Result<()> {
    if PipeClient::is_available() {
        return Ok(());
    }

    let exe = find_helper_exe().ok_or_else(|| {
        Error::privileged("devx-helper.exe was not found next to the application")
            .with_hint("build the helper with `cargo build -p devx-helper`")
    })?;

    tracing::info!(
        helper = %exe.display(),
        "launching the privileged helper (one elevation prompt)"
    );
    spawn_elevated(&exe)?;

    let deadline = tokio::time::Instant::now() + PIPE_WAIT;
    while tokio::time::Instant::now() < deadline {
        if PipeClient::is_available() {
            tracing::info!("privileged helper is up");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err(
        Error::privileged("the helper did not start within the wait window")
            .with_hint("accept the Windows UAC prompt to let DevX register and start the helper"),
    )
}

/// Candidate locations of the helper executable, in priority order: next to
/// the running app under its packaged (target-triple) name, then under its
/// plain name — which is also the dev layout (`target/debug`).
fn helper_candidates() -> Option<Vec<PathBuf>> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    let arch = std::env::consts::ARCH;

    Some(vec![
        dir.join(format!("devx-helper-{arch}-pc-windows-msvc.exe")),
        dir.join("devx-helper.exe"),
    ])
}

/// The helper executable to launch, when one of the candidates exists.
fn find_helper_exe() -> Option<PathBuf> {
    helper_candidates()?
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// The elevated PowerShell command that starts the helper.
///
/// Pure so the quoting can be tested.
fn elevation_script(exe: &std::path::Path) -> String {
    let exe = exe.display().to_string().replace('\'', "''");

    format!(
        "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Hidden",
        exe
    )
}

/// Spawns the elevated setup, detached from this process so the helper
/// outlives the relay that launched it. It runs until stopped or the machine
/// reboots; the next app launch repeats the same one-prompt flow.
fn spawn_elevated(exe: &std::path::Path) -> Result<()> {
    use std::os::windows::process::CommandExt as _;

    // CREATE_NO_WINDOW keeps the relay PowerShell invisible; the helper
    // itself runs hidden.
    let script = elevation_script(exe);

    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|err| Error::privileged(format!("failed to launch the helper setup: {err}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_candidates_cover_both_layouts() {
        let candidates = helper_candidates().expect("current exe always has a parent");
        let names: Vec<String> = candidates
            .iter()
            .map(|c| c.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            names,
            vec![
                format!("devx-helper-{}-pc-windows-msvc.exe", std::env::consts::ARCH),
                "devx-helper.exe".to_owned(),
            ]
        );
    }

    #[test]
    fn a_candidate_that_exists_is_picked() {
        let dir = tempfile::tempdir().expect("temp");
        let plain = dir.path().join("devx-helper.exe");
        std::fs::write(&plain, b"stub").expect("write");

        // Candidates come from current_exe, so assert the picking rule
        // directly against a synthetic candidate list.
        let picked = [plain.clone(), dir.path().join("missing.exe")]
            .into_iter()
            .find(|c| c.is_file());
        assert_eq!(picked, Some(plain.clone()));

        // And the packaged name wins when both exist.
        let packaged = dir.path().join(format!(
            "devx-helper-{}-pc-windows-msvc.exe",
            std::env::consts::ARCH
        ));
        std::fs::write(&packaged, b"stub").expect("write");
        let picked = [packaged.clone(), plain].into_iter().find(|c| c.is_file());
        assert_eq!(picked, Some(packaged.clone()));
    }

    #[test]
    fn elevation_script_starts_the_helper_hidden() {
        let script = elevation_script(std::path::Path::new("C:/devx/devx-helper.exe"));

        assert_eq!(
            script,
            "Start-Process -FilePath 'C:/devx/devx-helper.exe' -Verb RunAs -WindowStyle Hidden"
        );
    }

    #[test]
    fn elevation_script_escapes_single_quotes_in_paths() {
        let script = elevation_script(std::path::Path::new("C:/o'brien/devx-helper.exe"));

        assert_eq!(
            script,
            "Start-Process -FilePath 'C:/o''brien/devx-helper.exe' -Verb RunAs -WindowStyle Hidden"
        );
    }
}
