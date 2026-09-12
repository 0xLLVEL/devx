//! Build and runtime metadata about the DevX application itself.

use serde::Serialize;

/// Identifying information about this DevX build.
///
/// Surfaced in the UI footer and by `devx doctor`, and useful in bug reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AppInfo {
    /// Product name.
    pub name: String,
    /// Semantic version of the DevX build.
    pub version: String,
    /// Rust target triple this binary was compiled for.
    pub target: String,
    /// Whether this is a debug build.
    pub debug: bool,
}

impl AppInfo {
    /// Metadata for the currently running build.
    pub fn current() -> Self {
        Self {
            name: "DevX".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            target: TARGET.to_owned(),
            debug: cfg!(debug_assertions),
        }
    }
}

impl Default for AppInfo {
    fn default() -> Self {
        Self::current()
    }
}

/// Target triple, resolved at compile time.
///
/// DevX only ships for 64-bit Windows; the fallback keeps non-Windows
/// development builds (used for editor tooling) compiling.
const TARGET: &str = if cfg!(all(windows, target_arch = "x86_64")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(windows, target_arch = "aarch64")) {
    "aarch64-pc-windows-msvc"
} else {
    "unsupported"
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_app_info_is_populated() {
        let info = AppInfo::current();
        assert_eq!(info.name, "DevX");
        // Version comes from Cargo and must be parseable as `major.minor.patch`.
        let parts: Vec<&str> = info.version.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "unexpected version format: {}",
            info.version
        );
        assert!(parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())));
        assert_ne!(info.target, "unsupported", "DevX targets 64-bit Windows");
    }
}
