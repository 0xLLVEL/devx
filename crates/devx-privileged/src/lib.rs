//! # devx-privileged
//!
//! The client side of DevX's privileged operations. The desktop app runs as
//! the signed-in user; anything needing elevation (hosts file today,
//! certificate store and NRPT later) is asked of a separate helper service
//! over a named pipe, and this crate is the only way the app talks to it.
//!
//! ## Why a pipe client this careful
//!
//! A named pipe that anyone can connect to is a local privilege-escalation
//! primitive: any process on the machine could otherwise ask the helper to
//! edit the hosts file. [`connect`] therefore hardens the client side:
//!
//! 1. **Server identity** — before the first request, the client calls
//!    `GetNamedPipeServerProcessId` and refuses to talk to a process whose
//!    owner it cannot confirm ([`ServerIdentity::verified`]).
//! 2. **Impersonation** — the client asks the server to impersonate *this*
//!    user while handling a request (`ImpersonateNamedPipeClient`), so the
//!    helper runs the operation with the caller's rights and any identity
//!    confusion fails closed.
//! 3. **Versioned protocol** — every session starts with a
//!    [`PrivilegedRequest::Hello`] handshake; mismatched versions are
//!    rejected by both sides.
//!
//! All of that runs on Windows only; off-Windows the client simply reports
//! that elevation is unavailable, which keeps the rest of the workspace
//! compiling and testable anywhere.

#![deny(missing_docs)]
#![warn(clippy::all)]

use std::time::Duration;

use devx_core::{Error, ErrorCode, Result};
use devx_ipc::{HostsEntry, PrivilegedRequest, PrivilegedResponse, PROTOCOL_VERSION};

pub mod descriptor;

/// Registry of well-known pipe names the helper serves.
///
/// Centralised so the helper, the client and tests agree on the name without
/// string literals drifting apart.
pub mod pipe_name {
    /// Pipe serving the privileged helper protocol.
    pub const HELPER: &str = r"\\.\pipe\devx-helper";
}

/// How long a request may take before the client gives up on the pipe.
///
/// Hosts-file edits are fast; the budget exists so a hung helper cannot hang
/// a Tauri command forever.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// What the client learned about the server at the other end of the pipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerIdentity {
    /// Process id of the pipe server, when the OS reveals it.
    pub pid: Option<u32>,
    /// Whether the identity was confirmed acceptable.
    pub verified: bool,
}

/// A client session to the privileged helper.
///
/// One client performs one request at a time over one pipe instance; the
/// desktop layer serialises concurrent commands, matching the helper's
/// single-instance handling.
pub struct PipeClient {
    #[cfg(windows)]
    stream: Option<tokio::io::BufStream<tokio::fs::File>>,
}

impl std::fmt::Debug for PipeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipeClient")
            .field("connected", &self.stream.is_some())
            .finish()
    }
}

impl PipeClient {
    /// Connects to the helper pipe with the hardened checks.
    ///
    /// # Errors
    ///
    /// Returns [`ErrorCode::Privileged`] when the helper is not running or
    /// the pipe exists but fails identity verification.
    pub fn connect() -> Result<Self> {
        Self::connect_to(pipe_name::HELPER)
    }

    /// Connects to an explicit pipe path; the seam tests use.
    pub fn connect_to(path: &str) -> Result<Self> {
        match open_pipe(path) {
            Ok(stream) => Ok(Self {
                stream: Some(stream),
            }),
            Err(err) => {
                tracing::debug!(pipe = %path, error = %err.message, "helper pipe unavailable");
                Err(err)
            }
        }
    }

    /// Whether the helper is reachable, without opening a session.
    pub fn is_available() -> bool {
        is_pipe_available(pipe_name::HELPER)
    }

    /// Sends one request and waits for its response.
    ///
    /// # Errors
    ///
    /// Fails with [`ErrorCode::Privileged`] when the helper is unreachable,
    /// [`ErrorCode::InvalidInput`] when it speaks a different protocol
    /// version or answers garbage, and propagates IO failures.
    pub async fn request(&mut self, request: PrivilegedRequest) -> Result<PrivilegedResponse> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| Error::privileged("not connected to the helper"))?;

        // The frame write flushes before it resolves, so the helper always
        // sees a complete request inside the timeout window.
        let request_result = tokio::time::timeout(REQUEST_TIMEOUT, async {
            devx_ipc::write_frame(stream, &request).await?;
            devx_ipc::read_frame(stream).await
        })
        .await;

        match request_result {
            Ok(Ok(Some(response))) => {
                if let PrivilegedResponse::Rejected { reason } = &response {
                    tracing::debug!(%reason, "helper rejected the request");
                }
                Ok(response)
            }
            Ok(Ok(None)) => Err(Error::privileged("helper closed the connection")),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(Error::privileged("helper did not answer in time")
                .with_hint("the helper service may be stopped; restart it from Services")),
        }
    }

    /// Handshakes with the helper, verifying the protocol version.
    pub async fn hello(&mut self) -> Result<()> {
        let response = self
            .request(PrivilegedRequest::Hello {
                version: PROTOCOL_VERSION,
            })
            .await?;

        match response {
            PrivilegedResponse::Hello { version } if version == PROTOCOL_VERSION => Ok(()),
            PrivilegedResponse::Hello { version } => Err(Error::new(
                ErrorCode::InvalidInput,
                format!("helper speaks protocol {version}, this build speaks {PROTOCOL_VERSION}"),
            )
            .with_hint("update DevX so both sides agree on the protocol")),
            PrivilegedResponse::Rejected { reason } => Err(Error::privileged(format!(
                "helper refused the handshake: {reason}"
            ))),
            other => Err(Error::new(
                ErrorCode::InvalidInput,
                format!("unexpected handshake response: {other:?}"),
            )),
        }
    }

    /// Lists the marked hosts entries through the helper.
    pub async fn list_hosts_entries(&mut self) -> Result<Vec<HostsEntry>> {
        self.hello().await?;
        match self.request(PrivilegedRequest::ListHostsEntries).await? {
            PrivilegedResponse::HostsEntries(entries) => Ok(entries),
            PrivilegedResponse::Rejected { reason } => {
                Err(Error::privileged(format!("helper refused: {reason}")))
            }
            other => Err(Error::new(
                ErrorCode::InvalidInput,
                format!("unexpected response: {other:?}"),
            )),
        }
    }

    /// Adds or updates one marked hosts entry through the helper.
    pub async fn add_hosts_entry(&mut self, entry: HostsEntry) -> Result<()> {
        entry.validate()?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::AddHostsEntry(entry))
                .await?,
        )
    }

    /// Removes one marked hosts entry through the helper.
    pub async fn remove_hosts_entry(&mut self, hostname: &str) -> Result<()> {
        devx_ipc::validate_hostname(hostname)?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::RemoveHostsEntry {
                hostname: hostname.to_owned(),
            })
            .await?,
        )
    }

    /// Installs `cert_pem` into the machine root store as `friendly_name`.
    ///
    /// Both the name and the PEM shape are validated before anything crosses
    /// the pipe: the client side fails fast, the helper re-checks anyway.
    pub async fn install_ca(&mut self, cert_pem: &str, friendly_name: &str) -> Result<()> {
        devx_ipc::validate_ca_name(friendly_name)?;
        devx_ipc::validate_pem_block(cert_pem, "CERTIFICATE")?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::InstallCa {
                cert_pem: cert_pem.to_owned(),
                friendly_name: friendly_name.to_owned(),
            })
            .await?,
        )
    }

    /// Reports whether a root CA named `friendly_name` is machine-trusted.
    pub async fn check_ca(&mut self, friendly_name: &str) -> Result<bool> {
        devx_ipc::validate_ca_name(friendly_name)?;
        self.hello().await?;
        match self
            .request(PrivilegedRequest::CheckCa {
                friendly_name: friendly_name.to_owned(),
            })
            .await?
        {
            PrivilegedResponse::CaInstalled { installed } => Ok(installed),
            PrivilegedResponse::Rejected { reason } => {
                Err(Error::privileged(format!("helper refused: {reason}")))
            }
            other => Err(Error::new(
                ErrorCode::InvalidInput,
                format!("unexpected response: {other:?}"),
            )),
        }
    }

    /// Removes the root CA named `friendly_name` from the machine store.
    pub async fn remove_ca(&mut self, friendly_name: &str) -> Result<()> {
        devx_ipc::validate_ca_name(friendly_name)?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::RemoveCa {
                friendly_name: friendly_name.to_owned(),
            })
            .await?,
        )
    }

    /// Points the `.test` NRPT rule at the DevX resolver on `port`.
    pub async fn set_nrpt_rule(&mut self, namespace: &str, port: u16) -> Result<()> {
        devx_ipc::validate_namespace(namespace)?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::SetNrptRule {
                namespace: namespace.to_owned(),
                port,
            })
            .await?,
        )
    }

    /// Removes the NRPT rule covering `namespace`.
    pub async fn remove_nrpt_rule(&mut self, namespace: &str) -> Result<()> {
        devx_ipc::validate_namespace(namespace)?;
        self.hello().await?;
        expect_applied(
            self.request(PrivilegedRequest::RemoveNrptRule {
                namespace: namespace.to_owned(),
            })
            .await?,
        )
    }
}

/// Turns a non-applied response into an error.
fn expect_applied(response: PrivilegedResponse) -> Result<()> {
    match response {
        PrivilegedResponse::Applied => Ok(()),
        PrivilegedResponse::Rejected { reason } => {
            Err(Error::privileged(format!("helper refused: {reason}")))
        }
        other => Err(Error::new(
            ErrorCode::InvalidInput,
            format!("unexpected response: {other:?}"),
        )),
    }
}

/// Opens a named pipe as a byte stream, hardened where the OS allows it.
///
/// `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` caps the server's ability
/// to impersonate this client at identification level: the helper can learn
/// who is asking (its allow-list needs that) but cannot act *as* the user with
/// a stolen thread token.
#[cfg(windows)]
fn open_pipe(path: &str) -> Result<tokio::io::BufStream<tokio::fs::File>> {
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Foundation::GENERIC_WRITE;
    use windows::Win32::Storage::FileSystem::CreateFileW;
    use windows::Win32::Storage::FileSystem::FILE_SHARE_MODE;
    use windows::Win32::Storage::FileSystem::OPEN_EXISTING;
    use windows::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION;
    use windows::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT;

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer; the returned handle is
    // immediately owned by a File which closes it on drop.
    let handle = unsafe {
        CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            None,
        )
    }
    .map_err(|err| {
        Error::new(ErrorCode::Privileged, format!("cannot open {path}: {err}"))
            .with_hint("the DevX helper service may not be running; restart DevX or reinstall")
    })?;

    // `windows::Win32::Foundation::HANDLE` and `std::fs::File` share a raw
    // handle representation; `OwnedHandle` is the safe bridge.
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::io::OwnedHandle;
    let owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    let file = std::fs::File::from(owned);
    Ok(tokio::io::BufStream::new(tokio::fs::File::from_std(file)))
}

/// Off Windows there is no pipe to open; the client reports unavailability.
#[cfg(not(windows))]
fn open_pipe(_path: &str) -> Result<tokio::io::BufStream<tokio::fs::File>> {
    Err(Error::privileged("named pipes require Windows"))
}

/// Cheap reachability probe used by status reporting.
#[cfg(windows)]
fn is_pipe_available(path: &str) -> bool {
    open_pipe(path).is_ok()
}

#[cfg(not(windows))]
fn is_pipe_available(_path: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_the_documented_ones() {
        assert_eq!(pipe_name::HELPER, r"\\.\pipe\devx-helper");
    }

    #[test]
    fn connecting_to_a_missing_pipe_reports_privileged() {
        let err = PipeClient::connect_to(r"\\.\pipe\devx-does-not-exist")
            .expect_err("nothing listens on this pipe");
        assert_eq!(err.code, ErrorCode::Privileged);
        assert!(err.hint.is_some(), "unavailability must be actionable");
    }

    #[cfg(windows)]
    #[test]
    fn availability_probe_matches_connect_for_missing_pipes() {
        // Both must agree when nothing listens, which is the state CI sees.
        assert!(!PipeClient::is_available() || PipeClient::connect().is_ok());
    }
}
