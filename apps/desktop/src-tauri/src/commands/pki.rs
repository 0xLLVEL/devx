//! Local certificate authority commands.

use devx_core::Error;
use devx_privileged::PipeClient;

/// The local CA's trust status, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct CaStatus {
    /// Whether the CA exists on disk (signed certificates are possible).
    pub exists: bool,
    /// Whether the machine trusts the CA (browsers accept its certificates).
    /// `None` when the privileged helper is unavailable to check.
    pub trusted: Option<bool>,
}

/// Reports the local CA's status: present on disk and machine-trusted.
#[tauri::command]
#[specta::specta]
pub async fn ca_status() -> Result<CaStatus, Error> {
    let paths = devx_core::AppPaths::discover()?;
    let exists = devx_provision::pki::load_ca(&paths.certs_dir())?.is_some();

    let trusted = if PipeClient::is_available() {
        match PipeClient::connect() {
            Ok(mut client) => match client.check_ca(devx_provision::pki::CA_FRIENDLY_NAME).await {
                Ok(installed) => Some(installed),
                Err(err) => {
                    tracing::warn!(error = %err, "could not check CA trust through the helper");
                    None
                }
            },
            Err(err) => {
                tracing::warn!(error = %err, "helper probe succeeded but connect failed");
                None
            }
        }
    } else {
        None
    };

    Ok(CaStatus { exists, trusted })
}

/// Creates the local CA (if missing) and installs it into the machine trust
/// store through the privileged helper.
#[tauri::command]
#[specta::specta]
pub async fn ca_install() -> Result<CaStatus, Error> {
    let paths = devx_core::AppPaths::discover()?;
    let ca = devx_provision::pki::ensure_ca(&paths.certs_dir())?;

    crate::helper::ensure_helper_running().await?;

    let mut client = PipeClient::connect()?;
    client.hello().await?;
    client
        .install_ca(&ca.cert_pem, devx_provision::pki::CA_FRIENDLY_NAME)
        .await?;

    tracing::info!("installed the DevX local CA into the machine trust store");
    ca_status().await
}

/// Removes the DevX CA from the machine trust store (the on-disk CA and any
/// issued site certificates are left in place for a later reinstall).
#[tauri::command]
#[specta::specta]
pub async fn ca_remove() -> Result<CaStatus, Error> {
    let mut client = PipeClient::connect()?;
    client.hello().await?;
    client
        .remove_ca(devx_provision::pki::CA_FRIENDLY_NAME)
        .await?;

    tracing::info!("removed the DevX local CA from the machine trust store");
    ca_status().await
}
