//! Environment diagnostics.
//!
//! The checks are expressed against the [`SystemProbe`] trait so the decision
//! logic (what counts as "too little disk space") is unit-testable without
//! touching the real machine. Platform probing lives in `devx-sys`.

use serde::Serialize;

use crate::paths::AppPaths;

/// Free space below which provisioning is likely to fail, in bytes.
///
/// A PHP build plus a database plus nginx is comfortably under 2 GiB, but
/// extraction needs room for both the archive and the staged copy.
pub const LOW_DISK_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Outcome of a single diagnostic check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// Nothing to do.
    Pass,
    /// Works, but something will bite the user later.
    Warn,
    /// DevX cannot function until this is resolved.
    Fail,
}

/// A single diagnostic result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct Check {
    /// Stable identifier, used by the UI to attach a repair action.
    pub id: String,
    /// Short human-readable name.
    pub title: String,
    /// Outcome.
    pub status: CheckStatus,
    /// What was actually observed.
    pub detail: String,
    /// How to fix it, when the status is not `Pass`.
    pub remedy: Option<String>,
}

impl Check {
    fn new(
        id: &str,
        title: &str,
        status: CheckStatus,
        detail: impl Into<String>,
        remedy: Option<&str>,
    ) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            status,
            detail: detail.into(),
            remedy: remedy.map(str::to_owned),
        }
    }
}

/// Full diagnostic report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct DoctorReport {
    /// Worst status across all checks.
    pub status: CheckStatus,
    /// Individual results, in display order.
    pub checks: Vec<Check>,
}

impl DoctorReport {
    fn from_checks(checks: Vec<Check>) -> Self {
        let status = checks
            .iter()
            .map(|check| check.status)
            .max_by_key(|status| match status {
                CheckStatus::Pass => 0,
                CheckStatus::Warn => 1,
                CheckStatus::Fail => 2,
            })
            .unwrap_or(CheckStatus::Pass);

        Self { status, checks }
    }
}

/// Whether the configuration file loaded cleanly at startup.
///
/// A broken config must not stop DevX from starting: the app falls back to
/// defaults in memory, leaves the file untouched, and reports the problem here
/// so the user can fix it instead of guessing why nothing launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigHealth {
    /// Loaded and validated.
    Loaded,
    /// Present but unusable; DevX is running on defaults.
    Invalid {
        /// What went wrong.
        message: String,
        /// How to fix it, when known.
        hint: Option<String>,
    },
}

/// Platform facts the diagnostics need.
///
/// Implemented for real by `devx-sys`, and by fakes in tests.
pub trait SystemProbe {
    /// Installed WebView2 runtime version, if any.
    fn webview2_version(&self) -> Option<String>;

    /// Free bytes available to this user on the volume containing `path`.
    ///
    /// Returns `None` when the volume cannot be queried, which is itself
    /// reportable.
    fn available_space(&self, path: &std::path::Path) -> Option<u64>;

    /// Whether DevX can create files under `path`, creating it if needed.
    fn is_writable(&self, path: &std::path::Path) -> bool;
}

/// Runs every diagnostic check against `probe`.
pub fn run(paths: &AppPaths, probe: &dyn SystemProbe, config: &ConfigHealth) -> DoctorReport {
    let checks = vec![
        check_webview2(probe),
        check_config(paths, config),
        check_writable("config", &paths.config_dir, probe),
        check_writable("data", &paths.data_dir, probe),
        check_disk_space(paths, probe),
    ];

    DoctorReport::from_checks(checks)
}

fn check_config(paths: &AppPaths, health: &ConfigHealth) -> Check {
    match health {
        ConfigHealth::Loaded => Check::new(
            "config",
            "Configuration file",
            CheckStatus::Pass,
            paths.config_file().display().to_string(),
            None,
        ),
        ConfigHealth::Invalid { message, hint } => Check::new(
            "config",
            "Configuration file",
            CheckStatus::Fail,
            format!("{}: {message}", paths.config_file().display()),
            Some(hint.as_deref().unwrap_or(
                "Fix the file, or delete it to regenerate defaults. DevX is running on defaults until then.",
            )),
        ),
    }
}

fn check_webview2(probe: &dyn SystemProbe) -> Check {
    match probe.webview2_version() {
        Some(version) => Check::new(
            "webview2",
            "WebView2 runtime",
            CheckStatus::Pass,
            format!("version {version}"),
            None,
        ),
        None => Check::new(
            "webview2",
            "WebView2 runtime",
            CheckStatus::Fail,
            "not detected",
            Some("Install the Microsoft Edge WebView2 Runtime; DevX cannot render its UI without it."),
        ),
    }
}

fn check_writable(label: &str, dir: &std::path::Path, probe: &dyn SystemProbe) -> Check {
    let id = format!("writable-{label}");
    if probe.is_writable(dir) {
        Check::new(
            &id,
            &format!("Writable {label} directory"),
            CheckStatus::Pass,
            dir.display().to_string(),
            None,
        )
    } else {
        Check::new(
            &id,
            &format!("Writable {label} directory"),
            CheckStatus::Fail,
            format!("cannot write to {}", dir.display()),
            Some("Check folder permissions, or point DEVX_HOME at a location you own."),
        )
    }
}

fn check_disk_space(paths: &AppPaths, probe: &dyn SystemProbe) -> Check {
    match probe.available_space(&paths.data_dir) {
        Some(available) if available >= LOW_DISK_THRESHOLD_BYTES => Check::new(
            "disk-space",
            "Free disk space",
            CheckStatus::Pass,
            format!("{} available", format_bytes(available)),
            None,
        ),
        Some(available) => Check::new(
            "disk-space",
            "Free disk space",
            CheckStatus::Warn,
            format!(
                "only {} available on the volume holding {}",
                format_bytes(available),
                paths.data_dir.display()
            ),
            Some("Free up space before installing runtimes; extraction needs room for the archive and the extracted copy."),
        ),
        None => Check::new(
            "disk-space",
            "Free disk space",
            CheckStatus::Warn,
            format!("could not query the volume for {}", paths.data_dir.display()),
            Some("Verify that the configured data directory is on a local drive."),
        ),
    }
}

/// Formats a byte count using binary units.
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;

    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::path::{Path, PathBuf};

    struct FakeProbe {
        webview2: Option<String>,
        space: Option<u64>,
        unwritable: Vec<PathBuf>,
    }

    impl FakeProbe {
        fn healthy() -> Self {
            Self {
                webview2: Some("120.0.2210.91".to_owned()),
                space: Some(50 * 1024 * 1024 * 1024),
                unwritable: Vec::new(),
            }
        }
    }

    impl SystemProbe for FakeProbe {
        fn webview2_version(&self) -> Option<String> {
            self.webview2.clone()
        }

        fn available_space(&self, _path: &Path) -> Option<u64> {
            self.space
        }

        fn is_writable(&self, path: &Path) -> bool {
            !self.unwritable.iter().any(|denied| denied == path)
        }
    }

    fn paths() -> AppPaths {
        AppPaths::rooted_at(Path::new("C:\\devx-test"))
    }

    fn find<'a>(report: &'a DoctorReport, id: &str) -> &'a Check {
        report
            .checks
            .iter()
            .find(|check| check.id == id)
            .unwrap_or_else(|| panic!("missing check {id}"))
    }

    #[test]
    fn healthy_environment_passes_everything() {
        let report = run(&paths(), &FakeProbe::healthy(), &ConfigHealth::Loaded);

        assert_eq!(report.status, CheckStatus::Pass);
        assert!(report
            .checks
            .iter()
            .all(|check| check.status == CheckStatus::Pass));
        assert!(report.checks.iter().all(|check| check.remedy.is_none()));
    }

    #[test]
    fn missing_webview2_fails_the_report() {
        let probe = FakeProbe {
            webview2: None,
            ..FakeProbe::healthy()
        };

        let report = run(&paths(), &probe, &ConfigHealth::Loaded);

        assert_eq!(report.status, CheckStatus::Fail);
        let check = find(&report, "webview2");
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(
            check.remedy.is_some(),
            "a failure must tell the user what to do"
        );
    }

    #[test]
    fn low_disk_space_warns_but_does_not_fail() {
        let probe = FakeProbe {
            space: Some(LOW_DISK_THRESHOLD_BYTES - 1),
            ..FakeProbe::healthy()
        };

        let report = run(&paths(), &probe, &ConfigHealth::Loaded);

        assert_eq!(report.status, CheckStatus::Warn);
        assert_eq!(find(&report, "disk-space").status, CheckStatus::Warn);
    }

    #[test]
    fn unqueryable_volume_warns() {
        let probe = FakeProbe {
            space: None,
            ..FakeProbe::healthy()
        };

        let report = run(&paths(), &probe, &ConfigHealth::Loaded);

        assert_eq!(find(&report, "disk-space").status, CheckStatus::Warn);
    }

    #[test]
    fn unwritable_data_directory_fails() {
        let paths = paths();
        let probe = FakeProbe {
            unwritable: vec![paths.data_dir.clone()],
            ..FakeProbe::healthy()
        };

        let report = run(&paths, &probe, &ConfigHealth::Loaded);

        assert_eq!(report.status, CheckStatus::Fail);
        assert_eq!(find(&report, "writable-data").status, CheckStatus::Fail);
        assert_eq!(find(&report, "writable-config").status, CheckStatus::Pass);
    }

    #[test]
    fn worst_status_wins_over_a_mix() {
        let paths = paths();
        let probe = FakeProbe {
            webview2: None,
            space: Some(LOW_DISK_THRESHOLD_BYTES - 1),
            unwritable: vec![],
        };

        let report = run(&paths, &probe, &ConfigHealth::Loaded);

        assert_eq!(report.status, CheckStatus::Fail);
    }

    #[test]
    fn broken_configuration_fails_the_report_but_is_reported_not_hidden() {
        let health = ConfigHealth::Invalid {
            message: "network.domain_suffix must be a single label without dots".to_owned(),
            hint: Some("use `test`, not `.test`".to_owned()),
        };

        let report = run(&paths(), &FakeProbe::healthy(), &health);

        assert_eq!(report.status, CheckStatus::Fail);
        let check = find(&report, "config");
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(
            check.detail.contains("single label"),
            "the underlying reason must reach the user: {}",
            check.detail
        );
        assert_eq!(check.remedy.as_deref(), Some("use `test`, not `.test`"));
    }

    #[test]
    fn loaded_configuration_passes() {
        let report = run(&paths(), &FakeProbe::healthy(), &ConfigHealth::Loaded);

        assert_eq!(find(&report, "config").status, CheckStatus::Pass);
    }

    #[test]
    fn byte_formatting_is_readable() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KiB");
        assert_eq!(format_bytes(1536), "1.5 KiB");
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.0 GiB");
    }
}
