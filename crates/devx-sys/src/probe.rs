//! Concrete [`SystemProbe`] backed by the Windows API and registry.

use std::path::Path;

use devx_core::SystemProbe;

/// Registry client identifier of the Evergreen WebView2 Runtime.
///
/// Published by Microsoft as the supported way to detect the runtime; the GUID
/// is stable across versions.
#[cfg(windows)]
const WEBVIEW2_CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// Reads platform facts from the live system.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsProbe;

impl WindowsProbe {
    /// Creates a probe.
    pub fn new() -> Self {
        Self
    }
}

impl SystemProbe for WindowsProbe {
    fn webview2_version(&self) -> Option<String> {
        webview2_version()
    }

    fn available_space(&self, path: &Path) -> Option<u64> {
        available_space(path)
    }

    fn is_writable(&self, path: &Path) -> bool {
        devx_core::fsx::is_writable(path)
    }
}

/// Detects the installed Evergreen WebView2 Runtime version.
///
/// Checks the per-machine (64-bit and 32-bit views) and per-user registry
/// locations in the order Microsoft documents. A `pv` of `0.0.0.0` means the
/// runtime was uninstalled but left its key behind, so it is treated as absent.
#[cfg(windows)]
pub fn webview2_version() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let candidates = [
        (
            HKEY_LOCAL_MACHINE,
            format!(
                "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{WEBVIEW2_CLIENT_GUID}"
            ),
        ),
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{WEBVIEW2_CLIENT_GUID}"),
        ),
        (
            HKEY_CURRENT_USER,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{WEBVIEW2_CLIENT_GUID}"),
        ),
    ];

    for (hive, subkey) in candidates {
        let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(&subkey, KEY_READ) else {
            continue;
        };

        let Ok(version) = key.get_value::<String, _>("pv") else {
            continue;
        };

        let version = version.trim().to_owned();
        if version.is_empty() || version == "0.0.0.0" {
            continue;
        }

        tracing::debug!(%subkey, %version, "detected WebView2 runtime");
        return Some(version);
    }

    None
}

/// Always `None` off Windows; keeps editor tooling on other platforms working.
#[cfg(not(windows))]
pub fn webview2_version() -> Option<String> {
    None
}

/// Returns the bytes available to this user on the volume holding `path`.
///
/// `path` need not exist: the nearest existing ancestor is queried instead,
/// which matters because DevX asks about its data directory before creating it.
#[cfg(windows)]
pub fn available_space(path: &Path) -> Option<u64> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let existing = nearest_existing_ancestor(path)?;

    let mut wide: Vec<u16> = existing.as_os_str().encode_wide().collect();
    wide.push(0);

    let mut available: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call,
    // and `available` is a valid writable u64.
    let result =
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) };

    match result {
        Ok(()) => Some(available),
        Err(err) => {
            tracing::debug!(path = %existing.display(), %err, "GetDiskFreeSpaceExW failed");
            None
        }
    }
}

/// Always `None` off Windows.
#[cfg(not(windows))]
pub fn available_space(_path: &Path) -> Option<u64> {
    None
}

/// Walks up from `path` until a directory that exists is found.
#[cfg(windows)]
fn nearest_existing_ancestor(path: &Path) -> Option<std::path::PathBuf> {
    let mut candidate = path;
    loop {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        candidate = candidate.parent()?;
    }
}

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_space_for_an_existing_directory() {
        let dir = tempfile::tempdir().expect("temp dir");

        let available = available_space(dir.path());

        assert!(
            available.is_some_and(|bytes| bytes > 0),
            "a real volume should report free space, got {available:?}"
        );
    }

    #[test]
    fn reports_space_for_a_path_that_does_not_exist_yet() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("not").join("created").join("yet");

        let available = available_space(&missing);

        assert!(
            available.is_some_and(|bytes| bytes > 0),
            "should fall back to the nearest existing ancestor, got {available:?}"
        );
    }

    #[test]
    fn unknown_volume_reports_nothing() {
        // A drive letter that is almost certainly unmapped.
        let available = available_space(Path::new("Q:\\devx-does-not-exist"));

        assert_eq!(available, None);
    }

    #[test]
    fn probe_implements_the_core_trait() {
        let probe = WindowsProbe::new();
        let dir = tempfile::tempdir().expect("temp dir");

        assert!(probe.is_writable(dir.path()));
        assert!(probe.available_space(dir.path()).is_some());
        // WebView2 may legitimately be absent on a build agent, so only assert
        // the shape of the answer.
        if let Some(version) = probe.webview2_version() {
            assert!(
                version.split('.').count() >= 2,
                "unexpected version format: {version}"
            );
        }
    }
}
