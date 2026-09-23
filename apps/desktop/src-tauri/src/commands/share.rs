//! Cloudflare quick-tunnel sharing commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

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
/// The tunnel targets the owning server's loopback and HTTP port (live
/// allocation or configured default), so the public URL reaches the same
/// site block the local `.test` host name does — no front door involved.
#[tauri::command]
#[specta::specta]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<TunnelStatus, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let exe = cloudflared_exe(&state)?;

    // Forward to the owning server's own loopback and HTTP port (live
    // allocation included), else its default.
    let site = state
        .with_config(|store| {
            store
                .config()
                .sites
                .iter()
                .find(|s| s.hostname.eq_ignore_ascii_case(&hostname))
                .cloned()
        })
        .ok_or_else(|| Error::not_found(format!("site `{hostname}` is not configured")))?;
    let bind_ip = devx_provision::server_ip_for_component(site.web_server.component_id());
    let http_port = crate::commands::sites::server_port_for(&state, site.web_server);
    let local_url = format!("http://{bind_ip}:{http_port}");

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
