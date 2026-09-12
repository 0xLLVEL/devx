//! The named-pipe server loop.
//!
//! One pipe instance handles one client connection at a time: create with the
//! hardened DACL, connect, serve requests until EOF, repeat. Requests arrive
//! through [`devx_ipc`]'s framing and are dispatched by
//! [`crate::handle`]; the loop itself holds no state, so a restart can never
//! observe a half-applied mutation (the hosts backend is atomic).
//!
//! The server blocks on `ConnectNamedPipe` on a dedicated thread rather than
//! wiring overlapped IO into tokio: the helper serves one connection at a
//! time and has nothing else to do while waiting, so a blocking thread per
//! connection is the simpler, obviously-correct shape.

use std::sync::Arc;

use devx_core::Result;
use devx_ipc::PrivilegedRequest;

use crate::{handle, Backends};

/// Serves the helper pipe forever against `backends`.
///
/// Runs until the process is stopped; the service wrapper (installer, Task 17)
/// owns the lifetime.
#[cfg(windows)]
pub fn serve_blocking(backends: Arc<Backends>) -> Result<()> {
    let sddl = devx_privileged::descriptor::helper_pipe_sddl();
    tracing::info!(pipe = %devx_privileged::pipe_name::HELPER, %sddl, "helper listening");

    loop {
        let mut server = match create_pipe(&sddl) {
            Ok(server) => server,
            Err(err) => {
                tracing::error!(error = %err, "failed to create the helper pipe");
                std::thread::sleep(std::time::Duration::from_secs(1));
                continue;
            }
        };

        match connect_pipe(&mut server) {
            Ok(()) => {}
            // A client that connected between CreateNamedPipeW and
            // ConnectNamedPipe yields this error; the pipe is usable anyway.
            Err(err) if err.code == devx_core::ErrorCode::Io => {
                tracing::debug!(error = %err, "client had already connected");
            }
            Err(err) => {
                tracing::error!(error = %err, "ConnectNamedPipe failed");
                continue;
            }
        }

        // The handle is ours alone now; serve one client to EOF.
        let mut reader = server;
        let mut writer = reader.try_clone().map_err(|err| {
            devx_core::Error::new(
                devx_core::ErrorCode::Io,
                format!("failed to clone the pipe handle: {err}"),
            )
        })?;
        serve_client(backends.as_ref(), &mut reader, &mut writer);
    }
}

/// Off Windows there is nothing to serve; linking is the only requirement.
#[cfg(not(windows))]
pub fn serve_blocking(_backends: Arc<Backends>) -> Result<()> {
    Err(devx_core::Error::privileged(
        "the helper service requires Windows",
    ))
}

/// Reads requests from `reader` and writes answers to `writer` until EOF.
///
/// Split from the connection setup so the protocol half can be exercised by
/// tests with plain duplex streams.
#[cfg(windows)]
fn serve_client<R, W>(backends: &Backends, reader: &mut R, writer: &mut W)
where
    R: std::io::Read,
    W: std::io::Write,
{
    loop {
        let request: Option<PrivilegedRequest> = match devx_ipc::read_frame_sync(reader) {
            Ok(request) => request,
            Err(err) => {
                tracing::warn!(error = %err, "garbage from a client; dropping the connection");
                break;
            }
        };

        let Some(request) = request else {
            break; // Clean EOF.
        };

        tracing::debug!(?request, "helper received a request");
        let response = handle(backends, &request);

        if let Err(err) = devx_ipc::write_frame_sync(writer, &response) {
            tracing::warn!(error = %err, "failed to answer the client");
            break;
        }
    }
}

/// Creates one server-side pipe instance with the hardened DACL.
#[cfg(windows)]
fn create_pipe(sddl: &str) -> Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::io::OwnedHandle;

    use windows::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, NAMED_PIPE_MODE, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let wide: Vec<u16> = devx_privileged::pipe_name::HELPER
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let name = windows::core::PCWSTR::from_raw(wide.as_ptr());

    let security = security_attributes(sddl)?;

    // SAFETY: `wide` is NUL-terminated UTF-16 and `security` outlives the
    // call; the raw handle is wrapped in an owning `File` immediately.
    let handle = unsafe {
        CreateNamedPipeW(
            name,
            PIPE_ACCESS_DUPLEX,
            NAMED_PIPE_MODE(PIPE_TYPE_BYTE.0 | PIPE_READMODE_BYTE.0 | PIPE_WAIT.0),
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            Some(&security),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(devx_core::Error::privileged(
            "CreateNamedPipeW returned an invalid handle",
        ));
    }
    let _ = HANDLE; // type anchor

    Ok(std::fs::File::from(unsafe {
        OwnedHandle::from_raw_handle(handle.0)
    }))
}

/// Builds a `SECURITY_ATTRIBUTES` from an SDDL string.
///
/// The converted descriptor is deliberately never freed: the helper converts
/// one descriptor at startup per pipe instance, and freeing it while a pipe
/// instance may still consult it would be a use-after-free for the sake of a
/// few hundred bytes.
#[cfg(windows)]
fn security_attributes(sddl: &str) -> Result<windows::Win32::Security::SECURITY_ATTRIBUTES> {
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

    let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();

    let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let sddl_ptr = windows::core::PCWSTR::from_raw(wide.as_ptr());
    // SAFETY: `wide` is NUL-terminated UTF-16 and `descriptor` receives an
    // owned LocalAlloc'd pointer, intentionally leaked below.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_ptr,
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|err| {
        devx_core::Error::privileged(format!("invalid security descriptor {sddl:?}: {err}"))
    })?;

    Ok(SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or_default(),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    })
}

/// Blocks until a client connects to the pipe instance.
///
/// `ERROR_PIPE_CONNECTED` means the client connected first — that is success
/// by another name and is folded into `Ok(())`.
#[cfg(windows)]
fn connect_pipe(file: &mut std::fs::File) -> Result<()> {
    use windows::Win32::Foundation::{ERROR_PIPE_CONNECTED, HANDLE, WIN32_ERROR};
    use windows::Win32::System::Pipes::ConnectNamedPipe;

    let handle = std::os::windows::io::AsRawHandle::as_raw_handle(file);
    // SAFETY: the handle is owned by `file` and valid for the call; passing a
    // null OVERLAPPED makes the call block until a client connects.
    let result = unsafe { ConnectNamedPipe(HANDLE(handle as *mut _), None) };
    let _ = WIN32_ERROR(0); // type anchor for feature-gated types

    match result {
        Ok(()) => Ok(()),
        Err(err) if err.code() == ERROR_PIPE_CONNECTED.to_hresult() => Ok(()),
        Err(err) => Err(devx_core::Error::new(
            devx_core::ErrorCode::Io,
            format!("ConnectNamedPipe failed: {err}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nrpt::WindowsNrptBackend;
    use crate::{FileHostsBackend, WindowsCaBackend};

    #[test]
    fn backends_are_object_safe_for_the_server_loop() {
        // The server stores `Arc<Backends>`; prove it still compiles.
        fn assert_object_safe(_: Arc<Backends>) {}
        let backends = Arc::new(Backends {
            hosts: Box::new(FileHostsBackend::at(std::env::temp_dir().join("devx-noop"))),
            ca: Box::new(WindowsCaBackend),
            nrpt: Box::new(WindowsNrptBackend),
        });
        assert_object_safe(backends);
    }
}
