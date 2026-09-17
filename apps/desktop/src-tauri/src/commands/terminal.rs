//! Share (public tunnel) and terminal commands: run commands with the DevX
//! runtimes on `PATH`, and pin versions there via shims.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

// --- Share (Cloudflare quick tunnel) ----------------------------------------

/// The supervisor id of the tunnel process for `hostname`.
fn tunnel_service_id(hostname: &str) -> String {
    format!("cloudflared-tunnel-{hostname}")
}

/// Status of one site's public share, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TunnelStatus {
    /// The shared site's local host name.
    pub hostname: String,
    /// Whether the cloudflared process is running.
    pub running: bool,
    /// The public `https://…trycloudflare.com` URL, once assigned.
    ///
    /// Cloudflare announces it on stdout shortly after start, so this is
    /// `null` for a few seconds after `tunnel_start`.
    pub url: Option<String>,
}

/// Finds the installed cloudflared executable path.
fn cloudflared_exe(state: &AppState) -> Result<std::path::PathBuf, Error> {
    let runtimes = state.paths.runtimes_dir().join("cloudflared");
    let Ok(versions) = std::fs::read_dir(&runtimes) else {
        return Err(Error::not_found("cloudflared is not installed")
            .with_hint("install Cloudflare Tunnel from the Components page"));
    };
    for version in versions.flatten() {
        let exe = version.path().join("cloudflared.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    Err(Error::not_found("cloudflared is not installed")
        .with_hint("install Cloudflare Tunnel from the Components page"))
}

/// Shares `hostname` publicly through a Cloudflare quick tunnel.
///
/// The tunnel targets whichever port nginx actually serves (live allocation
/// or configured default), so the public URL reaches the same server block
/// the local `.test` host name does.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let exe = cloudflared_exe(&state)?;

    // nginx must be running to have anything to forward to; the port comes
    // from its supervisor (reallocated ports included), else the default.
    let nginx_port = state
        .services
        .port_of("nginx")
        .or_else(|| {
            devx_provision::definition_for("nginx")
                .ok()
                .and_then(|def| def.default_port)
        })
        .ok_or_else(|| Error::conflict("nginx has no port to forward"))?;
    let local_url = format!("http://127.0.0.1:{nginx_port}");

    let id = tunnel_service_id(&hostname);
    let args = devx_provision::tunnel::tunnel_args(&local_url);
    if args.is_empty() {
        return Err(Error::invalid_input(format!(
            "{local_url} is not a loopback target"
        )));
    }

    // Re-use the running process if a share already exists for this site.
    if let Some(existing) = state.services.get(&id) {
        if existing.state().is_active() {
            return tunnel_status(state, hostname).await;
        }
    }

    let mut spec = devx_proc::ProcessSpec::new(
        id.clone(),
        exe.to_string_lossy().into_owned(),
        state.paths.logs_dir(),
    );
    spec.args = args;
    let supervisor = state.services.register(spec)?;
    supervisor.start().await?;

    tunnel_status(state, hostname).await
}

/// Stops the share for `hostname`, if one is running.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_stop(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    if let Some(supervisor) = state.services.get(&tunnel_service_id(&hostname)) {
        supervisor.stop().await;
    }

    Ok(TunnelStatus {
        hostname,
        running: false,
        url: None,
    })
}

/// Reports the share status for `hostname`, parsing the tunnel URL from the
/// process's captured log output.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_status(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let id = tunnel_service_id(&hostname);

    let Some(supervisor) = state.services.get(&id) else {
        return Ok(TunnelStatus {
            hostname,
            running: false,
            url: None,
        });
    };
    let running = supervisor.state().is_active();
    let url = supervisor
        .logs()
        .into_iter()
        .rev()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    let url = devx_provision::tunnel::extract_tunnel_url(&url);

    Ok(TunnelStatus {
        hostname,
        running,
        url,
    })
}

// --- Terminal ----------------------------------------------------------------

/// One terminal run's exit information.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TerminalExit {
    /// Which run this belongs to, matching the streamed `TerminalOutput`s.
    pub run_id: u32,
    /// Exit code, when the process ended normally.
    pub code: Option<i32>,
}

/// Monotonic run counter for terminal output routing.
static TERMINAL_RUN_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Runtime directories worth having on the terminal's `PATH`.
///
/// Every installed runtime's directory is prepended (php, node, cloudflared
/// and friends keep their executables at the root; the databases nest them
/// in `bin`), so `php`, `composer` and `psql` resolve without the user
/// editing their system PATH — the whole point of the in-app terminal.
fn devx_path_entries(paths: &devx_core::AppPaths) -> Vec<std::path::PathBuf> {
    let mut entries = Vec::new();
    let Ok(components) = std::fs::read_dir(paths.runtimes_dir()) else {
        return entries;
    };
    for component in components.flatten() {
        if !component.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(versions) = std::fs::read_dir(component.path()) else {
            continue;
        };
        for version in versions.flatten() {
            if !version.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let dir = version.path();
            entries.push(dir.clone());
            let bin = dir.join("bin");
            if bin.is_dir() {
                entries.push(bin);
            }
        }
    }
    entries
}

/// The `PATH` string the terminal runs with: DevX runtimes first, then the
/// system's own `PATH` untouched.
#[tauri::command]
#[specta::specta]
pub fn terminal_path(state: State<'_, AppState>) -> Result<String, Error> {
    let mut dirs = devx_path_entries(&state.paths);
    dirs.push(devx_provision::use_shim::shims_dir(&state.paths));
    if let Some(system) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&system));
    }
    Ok(std::env::join_paths(dirs)
        .map_err(|err| Error::internal(format!("failed to build PATH: {err}")))?
        .to_string_lossy()
        .into_owned())
}

/// Pins a component version for the terminal by writing PATH shims.
///
/// Mirrors `devx use <component> <version>` so the UI and the CLI share one
/// implementation (see `devx_provision::use_shim`).
#[tauri::command]
#[specta::specta]
pub fn terminal_use_version(
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<(), Error> {
    devx_provision::use_shim::use_version(&state.paths, &component_id, &version).map(drop)
}

/// Clears any shims pinned for a component (the UI's unpin action).
#[tauri::command]
#[specta::specta]
pub fn terminal_unset_version(
    state: State<'_, AppState>,
    component_id: String,
) -> Result<(), Error> {
    devx_provision::use_shim::unset_version(&state.paths, &component_id).map(drop)
}

/// Runs one command through `cmd /c` in `cwd`, streaming its output.
///
/// Streams `TerminalOutput` events as lines arrive and resolves once the
/// process exits. This is a command runner, not a pty: interactive prompts
/// are not supported, which keeps the surface honest and typed. The child
/// gets the DevX runtimes on its `PATH` plus the usual working directory.
#[tauri::command]
#[specta::specta]
pub async fn terminal_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    command: String,
) -> Result<TerminalExit, Error> {
    use tauri_specta::Event as _;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid_input("the command must not be empty"));
    }
    let working_dir = std::path::PathBuf::from(&cwd);
    if !working_dir.is_absolute() || !working_dir.is_dir() {
        return Err(Error::invalid_input(format!(
            "`{cwd}` is not an existing directory"
        )));
    }

    let run_id = TERMINAL_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut path = devx_path_entries(&state.paths);
    path.push(devx_provision::use_shim::shims_dir(&state.paths));
    if let Some(system) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&system));
    }
    let path = std::env::join_paths(path)
        .map_err(|err| Error::internal(format!("failed to build PATH: {err}")))?;

    let mut child = tokio::process::Command::new("cmd")
        .args(["/c", trimmed])
        .current_dir(&working_dir)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Process,
                format!("failed to run the command: {err}"),
            )
        })?;

    let mut streams: Vec<(String, Box<dyn tokio::io::AsyncRead + Unpin + Send>)> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        streams.push(("out".to_owned(), Box::new(stdout)));
    }
    if let Some(stderr) = child.stderr.take() {
        streams.push(("err".to_owned(), Box::new(stderr)));
    }

    let mut pump_tasks = Vec::new();
    for (stream, reader) in streams {
        let app = app.clone();
        pump_tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(text)) = lines.next_line().await {
                let _ = crate::events::TerminalOutput {
                    run_id,
                    stream: stream.clone(),
                    text,
                }
                .emit(&app);
            }
        }));
    }

    let output = child.wait().await.map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Process,
            format!("failed to await the command: {err}"),
        )
    })?;
    for task in pump_tasks {
        task.abort();
    }

    Ok(TerminalExit {
        run_id,
        code: output.code(),
    })
}
