//! Dashboard resource commands: disk usage and the port map.

use crate::state::AppState;
use devx_core::Error;
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
