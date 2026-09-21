//! §111's Hosts Manager commands.
//!
//! Everything here is a thin shell around the privileged helper: the app
//! cannot read or write a marked entry itself, and it must not pretend
//! otherwise. Two rules follow from that and are visible in the code below.
//!
//! 1. **Reading never elevates.** `hosts_list` is called when the page
//!    renders, and a page that raises a UAC prompt on its own is a page that
//!    escalated without being asked. When the helper is down the list fails
//!    with a sentence saying so, and the UI shows that sentence (§131 Rule 18)
//!    rather than an empty list that would read as "you have no entries".
//! 2. **Writing says what it will do.** The mutating commands validate first
//!    (so a typo never costs a permission prompt), then bring the helper up
//!    through the same on-demand elevation every other privileged flow uses.
//!    A declined prompt surfaces as an error naming the prompt, never as a
//!    success.

use devx_core::Error;
use devx_ipc::HostsEntry;
use devx_privileged::PipeClient;

/// Lists the hosts entries DevX manages.
///
/// Only marked entries: the file's other lines belong to the user and to the
/// system, and this command does not report them at all.
///
/// # Errors
///
/// Fails with [`devx_core::ErrorCode::Privileged`] when the helper is not
/// running. Elevation is deliberately not attempted from here.
#[tauri::command]
#[specta::specta]
pub async fn hosts_list() -> Result<Vec<HostsEntry>, Error> {
    if !PipeClient::is_available() {
        return Err(helper_unavailable());
    }

    let mut client = PipeClient::connect()?;
    client.list_hosts_entries().await
}

/// Adds one DevX-managed hosts entry, or updates the existing one for that
/// host name.
///
/// Returns the list as it stands after the change, so the caller never renders
/// a list it did not just read.
///
/// # Errors
///
/// Propagates validation failures (before anything is elevated), the
/// elevation failure when the helper cannot be started, and the helper's own
/// refusal — a host name already mapped by a line outside DevX's control is a
/// conflict, not something to overwrite.
#[tauri::command]
#[specta::specta]
pub async fn hosts_add(hostname: String, ip: String) -> Result<Vec<HostsEntry>, Error> {
    let entry = HostsEntry { hostname, ip };
    // §111: refuse nonsense before the permission prompt, not after it.
    entry.validate()?;

    let mut client = helper_session().await?;
    client.add_hosts_entry(entry).await?;
    tracing::info!("hosts entry added through the helper");

    client.list_hosts_entries().await
}

/// Removes the DevX-managed hosts entry for `hostname`.
///
/// Returns the list as it stands after the change. Removing a name DevX does
/// not manage is not an error: there is nothing of DevX's to remove.
///
/// # Errors
///
/// Propagates validation failures, the elevation failure when the helper
/// cannot be started, and the helper's own refusal.
#[tauri::command]
#[specta::specta]
pub async fn hosts_remove(hostname: String) -> Result<Vec<HostsEntry>, Error> {
    devx_ipc::validate_hostname(&hostname)?;

    let mut client = helper_session().await?;
    client.remove_hosts_entry(&hostname).await?;
    tracing::info!("hosts entry removed through the helper");

    client.list_hosts_entries().await
}

/// Drops the machine's DNS client resolver cache.
///
/// Separate from the mutations on purpose: a name that resolved once keeps
/// resolving from the cache after the hosts file changed, and sometimes the
/// cache is the only thing that needs clearing.
///
/// # Errors
///
/// Propagates the elevation failure when the helper cannot be started, and the
/// helper's refusal when `ipconfig /flushdns` itself fails.
#[tauri::command]
#[specta::specta]
pub async fn hosts_flush_dns() -> Result<(), Error> {
    let mut client = helper_session().await?;
    client.flush_dns().await?;
    tracing::info!("DNS resolver cache flushed through the helper");

    Ok(())
}

/// What a hosts re-sync produced: the fresh list plus the names it could
/// not write.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct HostsResyncResult {
    /// Managed entries as they stand after the change.
    pub entries: Vec<HostsEntry>,
    /// Site names that were skipped, with reasons. A name owned by a
    /// hand-written (foreign) hosts line is refused rather than shadowed —
    /// remove that line by hand, then re-sync.
    pub skipped: Vec<super::sites::HostsSkipped>,
}

/// Rewrites every site hostname and alias with its owning server's loopback.
///
/// The one-click repair for entries left stale by older DevX (a name pointing
/// at a previous address while its server moved on): entries for names no
/// site owns are left alone, so hand-added custom lines are never touched.
#[tauri::command]
#[specta::specta]
pub async fn hosts_resync(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<HostsResyncResult, Error> {
    let skipped = crate::commands::sites::resync_resolution(&state).await;

    if !PipeClient::is_available() {
        return Err(helper_unavailable());
    }
    let mut client = PipeClient::connect()?;
    let entries = client.list_hosts_entries().await?;
    Ok(HostsResyncResult { entries, skipped })
}

/// Connects to the helper, prompting for elevation when it is not running.
///
/// The prompt this may raise is exactly the one the UI warned about before the
/// user confirmed the action; a declined prompt comes back as an error that
/// names it (the wait in [`crate::helper::ensure_helper_running`] expires with
/// that wording), so it is never silently reported as success.
async fn helper_session() -> Result<PipeClient, Error> {
    crate::helper::ensure_helper_running().await?;
    PipeClient::connect()
}

/// What to say when the helper is not running and this command will not
/// start it.
fn helper_unavailable() -> Error {
    Error::privileged(
        "the privileged helper is not running, so DevX cannot read the hosts entries it manages",
    )
    .with_hint(
        "elevated actions on this page (installing the CA, starting the resolver) bring the helper up after one Windows permission prompt, and these entries become readable then",
    )
}
