//! `devx use <component> <version>` — PATH shims for the installed runtimes.
//!
//! Writes small `.cmd` wrappers into `data/shims` that forward to a specific
//! installed version's executables. The user (or the terminal page) puts
//! `data/shims` ahead of the system `PATH`, and plain `php` / `composer` /
//! `psql` resolve to the chosen versions — no per-shell config needed.
//!
//! Shims are pure text files, cheap to regenerate, and never run anything at
//! write time, so this module is synchronous and side-effect-light by design.

use std::fs;
use std::path::PathBuf;

use devx_core::{AppPaths, Error, Result};

use crate::catalog::Catalog;
use crate::http::HttpClient;
use crate::install::Installer;

/// Root directory that must sit first on `PATH` for shims to win.
pub fn shims_dir(paths: &AppPaths) -> PathBuf {
    paths.data_dir.join("shims")
}

/// One executable wrapper written (or about to be written) by [`use_version`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShimEntry {
    /// Logical binary name, e.g. `php`.
    pub name: String,
    /// Absolute path of the real executable the shim forwards to.
    pub target: PathBuf,
}

/// Everything [`use_version`] did, so callers can report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UseOutcome {
    /// Component the shims point at.
    pub component_id: String,
    /// Version the shims pin.
    pub version: String,
    /// Shims written, including rewrites of previously pinned versions.
    pub written: Vec<ShimEntry>,
    /// Shims removed because the previously pinned version no longer matches.
    pub removed: Vec<PathBuf>,
}

/// Pins `component_id` at `version` by writing `.cmd` shims into the shims dir.
///
/// Replaces any existing shims for the component's binaries first, so
/// switching versions is idempotent: run it again with a different version and
/// the same shim names now forward there instead.
pub fn use_version(paths: &AppPaths, component_id: &str, version: &str) -> Result<UseOutcome> {
    let catalog = Catalog::embedded()?;
    let component = catalog
        .component(component_id)
        .map_err(|_| Error::not_found(format!("unknown component `{component_id}`")))?;

    let installer = Installer::new(
        paths.clone(),
        HttpClient::new(paths.cache_dir().join("http"))?,
    )?;
    if !installer.is_installed(component_id, version) {
        return Err(Error::not_found(format!(
            "{component_id} {version} is not installed; run `devx install {component_id} {version}` first"
        )));
    }

    let install_dir = installer.install_dir(component_id, version);
    let dir = shims_dir(paths);
    fs::create_dir_all(&dir).map_err(devx_core::Error::from)?;

    let mut written = Vec::new();
    let mut removed = Vec::new();

    // Clear previous shims for this component's binaries so a version switch
    // never leaves a stale forward behind.
    for logical in component.binaries.keys() {
        let shim = dir.join(format!("{logical}.cmd"));
        if shim.exists() {
            if let Err(err) = fs::remove_file(&shim) {
                return Err(Error::from(err));
            }
            if shim_was_removed(&shim) {
                removed.push(shim.clone());
            }
        }
    }

    for (logical, relative) in &component.binaries {
        let target = install_dir.join(relative);
        if !target.exists() {
            return Err(Error::internal(format!(
                "expected `{relative}` inside {component_id} {version} but it is missing; the install may be broken"
            )));
        }
        let shim = dir.join(format!("{logical}.cmd"));
        // `%*` forwards every argument; the target is quoted so paths with
        // spaces survive, and backslashes keep cmd happy.
        let script = format!(
            "@echo off\r\n\"{}\" %*\r\n",
            target.to_string_lossy().replace('/', "\\")
        );
        fs::write(&shim, script).map_err(devx_core::Error::from)?;
        written.push(ShimEntry {
            name: logical.clone(),
            target,
        });
    }

    Ok(UseOutcome {
        component_id: component_id.to_string(),
        version: version.to_string(),
        written,
        removed,
    })
}

/// Whether the shim file actually existed before being removed. Called after a
/// potential removal; cheap existence re-check keeps the accounting honest
/// without juggling flags in the loop above.
fn shim_was_removed(shim: &std::path::Path) -> bool {
    !shim.exists()
}

/// Removes every shim for one component (used by `devx use --unset`).
pub fn unset_version(paths: &AppPaths, component_id: &str) -> Result<Vec<PathBuf>> {
    let catalog = Catalog::embedded()?;
    let component = catalog
        .component(component_id)
        .map_err(|_| Error::not_found(format!("unknown component `{component_id}`")))?;

    let dir = shims_dir(paths);
    let mut removed = Vec::new();
    for logical in component.binaries.keys() {
        let shim = dir.join(format!("{logical}.cmd"));
        if shim.exists() {
            fs::remove_file(&shim).map_err(devx_core::Error::from)?;
            removed.push(shim);
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_component_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = AppPaths::rooted_at(tmp.path());
        let err = use_version(&paths, "definitely-not-real", "1.0.0").unwrap_err();
        assert!(err.to_string().contains("unknown component"));
    }

    #[test]
    fn uninstalled_version_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = AppPaths::rooted_at(tmp.path());
        let err = use_version(&paths, "php", "9.9.9").unwrap_err();
        assert!(err.to_string().contains("not installed"));
    }

    #[test]
    fn unset_removes_only_this_components_shims() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = AppPaths::rooted_at(tmp.path());
        let dir = shims_dir(&paths);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("php.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(dir.join("php-cgi.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(dir.join("composer.cmd"), "@echo off\r\n").unwrap();

        let removed = unset_version(&paths, "php").unwrap();
        assert_eq!(removed.len(), 2);
        assert!(!dir.join("php.cmd").exists());
        assert!(!dir.join("php-cgi.cmd").exists());
        assert!(dir.join("composer.cmd").exists());
    }
}
