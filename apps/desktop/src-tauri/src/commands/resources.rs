//! Dashboard resource commands: disk usage, the port map, and the Port
//! Inspector (§110).

use crate::state::AppState;
use devx_core::{Error, ErrorCode};
use devx_sys::ports::PortOwner;
use tauri::State;

/// Disk use of one managed directory, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct DirUsage {
    /// What the directory holds (`runtimes`, `service data`, `logs`, `backups`).
    pub label: String,
    /// Total size on disk, in bytes.
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
}

/// One claimed port and its owner, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PortEntry {
    /// What listens on the port (`nginx`, `php-pool-8.4.25`, `Mailpit`, …).
    pub owner: String,
    /// The port number.
    pub port: u16,
    /// Whether the service is running right now.
    pub active: bool,
}

/// Recursively sums the size of every file under `path`.
///
/// Unreadable entries are skipped: a locked file in a service data directory
/// must not break the whole usage read.
fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        } else if file_type.is_dir() {
            total += dir_size(&entry.path());
        }
    }
    total
}

/// The disk use of DevX's managed directories, biggest last.
///
/// Only the four directories users can meaningfully shrink are listed;
/// `certs` and `cache` are rounded off as noise.
#[tauri::command]
#[specta::specta]
pub fn disk_usage(state: State<'_, AppState>) -> Result<Vec<DirUsage>, Error> {
    let paths = &state.paths;
    let usages = vec![
        ("runtimes", paths.runtimes_dir()),
        ("service data", paths.service_data_dir()),
        ("logs", paths.logs_dir()),
        ("backups", paths.data_dir.join("backups")),
    ];

    let mut entries: Vec<DirUsage> = usages
        .into_iter()
        .map(|(label, dir)| DirUsage {
            label: label.to_owned(),
            size_bytes: dir_size(&dir),
        })
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.size_bytes));
    Ok(entries)
}

/// The port map: every port DevX claims and who claims it.
///
/// Covers the network ports from configuration (web, DNS), every supervised
/// service with a bound port, and every rendered FastCGI pool — so the user
/// can see, in one glance, which port belongs to what before starting
/// something new.
#[tauri::command]
#[specta::specta]
pub fn port_map(state: State<'_, AppState>) -> Result<Vec<PortEntry>, Error> {
    let mut entries = Vec::new();

    let config = state.with_config(|store| store.config().clone());
    entries.push(PortEntry {
        owner: "Web (HTTP)".to_owned(),
        port: config.network.http_port,
        active: true,
    });
    entries.push(PortEntry {
        owner: "Web (HTTPS)".to_owned(),
        port: config.network.https_port,
        active: true,
    });
    entries.push(PortEntry {
        owner: "DNS resolver".to_owned(),
        port: config.network.dns_port,
        active: state.dns_running(),
    });

    // Supervised services with a bound port (databases, mail, pools, workers).
    let mut service_ports: Vec<(String, u16)> = state
        .services
        .ids()
        .into_iter()
        .filter_map(|id| state.services.port_of(&id).map(|port| (id, port)))
        .collect();
    service_ports.sort_by_key(|(_, port)| *port);
    for (id, port) in service_ports {
        let active = state
            .services
            .get(&id)
            .is_some_and(|supervisor| supervisor.state().is_active());
        entries.push(PortEntry {
            owner: id,
            port,
            active,
        });
    }

    Ok(entries)
}

/// Every TCP port in the `LISTEN` state, with the process holding it (§110).
///
/// This is the whole machine, not DevX's own reservations: `port_map` answers
/// "which ports does DevX claim", this answers "who is listening, right now".
/// The two are deliberately separate commands, so the UI cannot present one as
/// the other.
///
/// Read-only and unprivileged, and it reports a failure rather than an empty
/// list, because "no port is listening" is a claim about the machine that a
/// failed read cannot support.
#[tauri::command]
#[specta::specta]
pub fn listening_ports() -> Result<Vec<PortOwner>, Error> {
    let mut ports = devx_sys::ports::try_listening_ports().map_err(|err| {
        Error::new(
            ErrorCode::Internal,
            format!("Could not read the TCP listener table: {err}"),
        )
    })?;
    ports.sort_by_key(|owner| (owner.port, owner.pid));
    Ok(ports)
}

/// Why `pid` must not be stopped, or `None` when the inspector may try.
///
/// The Port Inspector ends a process DevX did not start, running with the
/// signed-in user's rights and no elevation, so there are PIDs it could reach
/// but must never touch:
///
/// - **PID 0**, the System Idle Process. It is not a program; it is the kernel
///   accounting for an idle CPU, and the row on the listener table belongs to
///   the kernel rather than to anything a user could close.
/// - **PID 4**, `System`. An administrator's `OpenProcess` succeeds here, so
///   the OS would not stop this — terminating it is a kernel-level action that
///   takes the machine down. The guard has to be ours.
/// - **DevX's own PID**. A user closing DevX's listener is asking to quit DevX,
///   which has its own controls, and doing it by terminating the process would
///   cut the supervisor's log mid-write and leave children to the job object
///   instead of a clean stop.
///
/// Kept as a pure function of two numbers so the rules can be tested without a
/// process to kill; the command below is the only caller, and it refuses on
/// anything this returns.
fn stoppable_refusal(pid: u32, current_pid: u32) -> Option<Error> {
    if pid == 0 {
        return Some(
            Error::invalid_input("PID 0 is the System Idle Process, which is not a program.")
                .with_hint("Pick the row of the process you meant to stop."),
        );
    }
    if pid == 4 {
        return Some(
            Error::invalid_input(
                "PID 4 is the Windows System process; ending it would take the machine down.",
            )
            .with_hint("Stop the driver or service that holds the port instead."),
        );
    }
    if pid == current_pid {
        return Some(
            Error::invalid_input(format!("PID {pid} is DevX itself."))
                .with_hint("Quit DevX from its window or tray icon to release this port."),
        );
    }
    None
}

/// Stops the process holding `port`, after the user confirmed it (§110).
///
/// The guards, in order, and what each one is for:
///
/// 1. The guard below rules out three PIDs before anything else runs.
/// 2. The listener table is read *again* here, and the PID has to still hold
///    that port. The PID the user clicked came from a list that is already
///    seconds old, and Windows reuses PIDs the moment a process exits, so
///    without this the command could end an unrelated process that inherited
///    the number. A stale row can then only fail the check.
/// 3. The termination itself is the OS's decision. A process owned by SYSTEM or
///    by another account is refused with "Access is denied", and that refusal
///    is reported as-is: no retry, no elevation, no helper service. The user
///    gets the reason instead of a command that looks like it worked.
#[tauri::command]
#[specta::specta]
pub fn stop_process_on_port(pid: u32, port: u16) -> Result<(), Error> {
    if let Some(refusal) = stoppable_refusal(pid, std::process::id()) {
        return Err(refusal);
    }

    match devx_sys::ports::owner_of(port) {
        Some(owner) if owner.pid == pid => {}
        Some(owner) => {
            return Err(Error::conflict(format!(
                "Port {port} is held by PID {} now, not by PID {pid}.",
                owner.pid
            ))
            .with_hint("Reload the list: the process you picked has exited."));
        }
        None => {
            return Err(
                Error::not_found(format!("Nothing is listening on port {port} any more."))
                    .with_hint("Reload the list to see what is left."),
            );
        }
    }

    devx_sys::process::terminate(pid).map_err(|err| {
        Error::new(ErrorCode::Process, format!("Windows refused to stop PID {pid}: {err}")).with_hint(
            "A process owned by SYSTEM or by another user needs Task Manager run as administrator; DevX does not elevate for this.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_idle_process_is_never_stoppable() {
        let refusal = stoppable_refusal(0, 1234).expect("PID 0 must be refused");
        assert_eq!(refusal.code, ErrorCode::InvalidInput);
        assert!(refusal.message.contains("System Idle Process"));
        assert!(refusal.hint.is_some(), "a refusal says what to do instead");
    }

    #[test]
    fn the_system_process_is_never_stoppable() {
        let refusal = stoppable_refusal(4, 1234).expect("PID 4 must be refused");
        assert_eq!(refusal.code, ErrorCode::InvalidInput);
        assert!(refusal.message.contains("System"));
    }

    #[test]
    fn devx_is_never_stoppable() {
        let refusal = stoppable_refusal(4242, 4242).expect("DevX must be refused");
        assert_eq!(refusal.code, ErrorCode::InvalidInput);
        assert!(refusal.message.contains("DevX itself"));
    }

    #[test]
    fn another_process_is_left_to_the_operating_system() {
        // Nothing here is a judgement about the process: the guard only knows
        // the three PIDs above, and everything else is the OS's decision.
        assert!(stoppable_refusal(8124, 1234).is_none());
        assert!(stoppable_refusal(u32::MAX, 1234).is_none());
    }
}
