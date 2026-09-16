//! Ending a process, on the user's explicit request.
//!
//! The Port Inspector (§110) lets a user stop whatever is holding a port. That
//! is the one place in DevX that ends a process DevX did not start, so it is
//! deliberately the smallest possible capability: one PID in, the operating
//! system's answer out, no retry, no escalation, no fallback to a shell
//! (`taskkill`, `wmic`) that would bring its own quoting rules with it.
//!
//! Which PIDs are out of bounds is a policy decision and lives with the
//! command; this module only knows how to ask.

/// Ends `pid`, reporting the operating system's own refusal as it phrased it.
///
/// `TerminateProcess` requires `PROCESS_TERMINATE`, which the signed-in user
/// holds for its own processes and does not hold for a process owned by SYSTEM
/// or by another user's account. That refusal — normally "Access is denied." —
/// is returned verbatim: DevX does not retry it, does not run elevated for it
/// and does not forward it to the privileged helper, because "stop the thing on
/// this port" is not a reason to hand a process id to an elevated service.
///
/// The process is ended, not asked to close: a process that is not DevX's has
/// no agreed-upon way to be asked, and pretending otherwise would be a promise
/// DevX cannot keep.
#[cfg(windows)]
pub fn terminate(pid: u32) -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    // SAFETY: a query-free, single-right handle request for `pid`; the handle is
    // closed on every path below.
    let handle =
        unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.map_err(|err| err.to_string())?;

    // SAFETY: `handle` was opened with exactly `PROCESS_TERMINATE`.
    let result = unsafe { TerminateProcess(handle, 1) };
    // SAFETY: closing the handle opened above.
    unsafe {
        let _ = CloseHandle(handle);
    }

    result.map_err(|err| err.to_string())
}

/// Unsupported off Windows, where a PID is not even unique machine-wide.
#[cfg(not(windows))]
pub fn terminate(_pid: u32) -> Result<(), String> {
    Err("stopping a process by PID is only implemented on Windows".to_owned())
}
