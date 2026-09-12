//! Listening-port enumeration, for conflict detection.
//!
//! Before starting nginx on :80 or MariaDB on :3306, DevX checks whether the
//! port is already taken and, if so, by what. `GetExtendedTcpTable` gives both
//! the listening ports and their owning process ids, so the UI can say "port 80
//! is held by System (PID 4)" instead of just failing to bind.
//!
//! This is a read-only, unprivileged query. Deciding what to do about a
//! conflict (suggest another port) lives in `devx-provision`.

use serde::Serialize;

/// A process listening on a local TCP port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct PortOwner {
    /// The port being listened on.
    pub port: u16,
    /// PID of the owning process.
    pub pid: u32,
    /// Best-effort process image name (e.g. `nginx.exe`), if resolvable.
    pub process_name: Option<String>,
}

/// Lists every TCP port in the `LISTEN` state with its owning process.
///
/// Returns an empty list rather than an error when the table cannot be read, so
/// conflict detection degrades to "assume free" rather than blocking a start.
#[cfg(windows)]
pub fn listening_ports() -> Vec<PortOwner> {
    match unsafe { read_listener_table() } {
        Ok(ports) => ports,
        Err(err) => {
            tracing::warn!(%err, "failed to read the TCP listener table");
            Vec::new()
        }
    }
}

/// Always empty off Windows.
#[cfg(not(windows))]
pub fn listening_ports() -> Vec<PortOwner> {
    Vec::new()
}

/// Whether `port` is currently held by a listener.
pub fn is_port_in_use(port: u16) -> bool {
    listening_ports().iter().any(|owner| owner.port == port)
}

/// Returns the owner of `port`, if any.
pub fn owner_of(port: u16) -> Option<PortOwner> {
    listening_ports()
        .into_iter()
        .find(|owner| owner.port == port)
}

#[cfg(windows)]
unsafe fn read_listener_table() -> Result<Vec<PortOwner>, String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    // First call with a null buffer to learn the required size, then allocate
    // and call again. The table can change between calls, so retry on the
    // "insufficient buffer" error a bounded number of times.
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const NO_ERROR: u32 = 0;

    let mut size: u32 = 0;
    let mut buffer: Vec<u8> = Vec::new();

    for _ in 0..5 {
        let ptr = if buffer.is_empty() {
            None
        } else {
            Some(buffer.as_mut_ptr() as *mut core::ffi::c_void)
        };

        let result = GetExtendedTcpTable(
            ptr,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );

        match result {
            NO_ERROR => return Ok(parse_table(&buffer)),
            ERROR_INSUFFICIENT_BUFFER => {
                buffer = vec![0u8; size as usize];
            }
            other => return Err(format!("GetExtendedTcpTable failed with code {other}")),
        }
    }

    Err("TCP listener table kept changing size".to_owned())
}

/// Parses the `MIB_TCPTABLE_OWNER_PID` byte buffer into port owners.
#[cfg(windows)]
fn parse_table(buffer: &[u8]) -> Vec<PortOwner> {
    use windows::Win32::NetworkManagement::IpHelper::{
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
    };

    if buffer.len() < std::mem::size_of::<u32>() {
        return Vec::new();
    }

    // SAFETY: the buffer was filled by GetExtendedTcpTable as a
    // MIB_TCPTABLE_OWNER_PID: a u32 count followed by that many rows.
    let table = buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
    let count = unsafe { (*table).dwNumEntries } as usize;

    let rows_ptr = unsafe { (*table).table.as_ptr() };
    let mut owners = Vec::with_capacity(count);

    for index in 0..count {
        // SAFETY: `index` is within the entry count reported by the table.
        let row: &MIB_TCPROW_OWNER_PID = unsafe { &*rows_ptr.add(index) };
        // Ports in the table are big-endian; the low 16 bits hold the value.
        let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
        let pid = row.dwOwningPid;

        owners.push(PortOwner {
            port,
            pid,
            process_name: process_name(pid),
        });
    }

    owners
}

/// Best-effort image name for a PID.
#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return None;
    }

    // SAFETY: OpenProcess with a query-only access right; the handle is closed
    // below on every path.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

    let mut name = [0u16; 260];
    // SAFETY: `handle` is valid and `name` is a correctly sized buffer.
    let len = unsafe { GetModuleBaseNameW(handle, None, &mut name) };
    // SAFETY: closing the handle opened above.
    unsafe {
        let _ = CloseHandle(handle);
    }

    if len == 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&name[..len as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bound_port_is_detected_as_in_use() {
        // Bind a listener, then confirm the scanner sees the port.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();

        assert!(
            is_port_in_use(port),
            "port {port} was bound but not reported as in use"
        );

        let owner = owner_of(port).expect("owner");
        assert_eq!(owner.port, port);
        // The owner is this test process.
        assert_eq!(owner.pid, std::process::id());
    }

    #[test]
    fn a_free_port_is_not_reported() {
        // Bind then drop to obtain a very likely-free port number.
        let port = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
            listener.local_addr().expect("addr").port()
        };
        // Small race window, but a just-released ephemeral port is almost
        // certainly free again immediately.
        assert!(!is_port_in_use(port));
    }
}
