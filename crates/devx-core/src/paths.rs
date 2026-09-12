//! Filesystem layout for DevX.
//!
//! Two roots, following Windows conventions:
//!
//! * **config** (`%APPDATA%\DevX`) holds small, user-owned, roamable files.
//! * **data** (`%LOCALAPPDATA%\DevX`) holds everything large or machine-specific:
//!   downloaded runtimes, database data directories, logs and caches. These must
//!   never roam to another machine.
//!
//! Both roots can be overridden by environment variables, which makes tests
//! hermetic and enables portable installations:
//!
//! | Variable | Effect |
//! | --- | --- |
//! | `DEVX_HOME` | Sets both roots to `<value>\config` and `<value>\data` |
//! | `DEVX_CONFIG_DIR` | Overrides the config root |
//! | `DEVX_DATA_DIR` | Overrides the data root |

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{Error, Result};

/// Directory name appended to the platform config and data roots.
const APP_DIR_NAME: &str = "DevX";

/// Environment variable that relocates both roots under one directory.
pub const ENV_HOME: &str = "DEVX_HOME";
/// Environment variable that overrides the config root.
pub const ENV_CONFIG_DIR: &str = "DEVX_CONFIG_DIR";
/// Environment variable that overrides the data root.
pub const ENV_DATA_DIR: &str = "DEVX_DATA_DIR";

/// Resolved locations DevX reads from and writes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AppPaths {
    /// Root for user configuration.
    pub config_dir: PathBuf,
    /// Root for runtimes, service data, logs and caches.
    pub data_dir: PathBuf,
}

impl AppPaths {
    /// Resolves paths from the environment, falling back to Windows defaults.
    ///
    /// # Errors
    ///
    /// Returns an error when neither the overrides nor the platform directories
    /// can be determined, which in practice means a broken user profile.
    pub fn discover() -> Result<Self> {
        let from_env = |key: &str| std::env::var_os(key).map(PathBuf::from);

        if let Some(home) = from_env(ENV_HOME) {
            return Ok(Self {
                config_dir: from_env(ENV_CONFIG_DIR).unwrap_or_else(|| home.join("config")),
                data_dir: from_env(ENV_DATA_DIR).unwrap_or_else(|| home.join("data")),
            });
        }

        let base = directories::BaseDirs::new().ok_or_else(|| {
            Error::config("could not determine the Windows user directories")
                .with_hint("set DEVX_HOME to choose the location manually")
        })?;

        Ok(Self {
            config_dir: from_env(ENV_CONFIG_DIR)
                .unwrap_or_else(|| base.config_dir().join(APP_DIR_NAME)),
            data_dir: from_env(ENV_DATA_DIR)
                .unwrap_or_else(|| base.data_local_dir().join(APP_DIR_NAME)),
        })
    }

    /// Builds a layout rooted at `root`, used by tests and portable installs.
    pub fn rooted_at(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        Self {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
        }
    }

    /// The main configuration file.
    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    /// Installed component versions, one directory per component and version.
    pub fn runtimes_dir(&self) -> PathBuf {
        self.data_dir.join("runtimes")
    }

    /// Generated configuration for supervised services (nginx.conf, php.ini…).
    pub fn service_config_dir(&self) -> PathBuf {
        self.data_dir.join("service-config")
    }

    /// Persistent service state such as database data directories.
    pub fn service_data_dir(&self) -> PathBuf {
        self.data_dir.join("service-data")
    }

    /// Rotated log files for DevX itself and every supervised process.
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    /// HTTP response cache for catalog and version metadata.
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    /// Downloaded archives awaiting verification and extraction.
    pub fn downloads_dir(&self) -> PathBuf {
        self.data_dir.join("downloads")
    }

    /// Scratch space for staged installs; safe to delete when DevX is stopped.
    pub fn staging_dir(&self) -> PathBuf {
        self.data_dir.join("staging")
    }

    /// Local certificate authority and issued site certificates.
    pub fn certs_dir(&self) -> PathBuf {
        self.data_dir.join("certs")
    }

    /// Every directory DevX expects to exist at startup.
    pub fn managed_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.config_dir.clone(),
            self.data_dir.clone(),
            self.runtimes_dir(),
            self.service_config_dir(),
            self.service_data_dir(),
            self.logs_dir(),
            self.cache_dir(),
            self.downloads_dir(),
            self.staging_dir(),
            self.certs_dir(),
        ]
    }

    /// Creates every managed directory.
    ///
    /// # Errors
    ///
    /// Returns the first directory that could not be created, including the path
    /// in the message so the failure is actionable.
    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in self.managed_dirs() {
            std::fs::create_dir_all(&dir).map_err(|err| {
                Error::new(
                    crate::ErrorCode::Io,
                    format!("failed to create {}: {err}", dir.display()),
                )
                .with_hint("check that the drive exists and DevX may write to it")
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn rooted_layout_keeps_config_and_data_separate() {
        let paths = AppPaths::rooted_at(Path::new("C:\\devx-test"));

        assert_eq!(paths.config_dir, PathBuf::from("C:\\devx-test\\config"));
        assert_eq!(paths.data_dir, PathBuf::from("C:\\devx-test\\data"));
        assert_eq!(
            paths.config_file(),
            PathBuf::from("C:\\devx-test\\config\\config.toml")
        );
        assert_eq!(
            paths.runtimes_dir(),
            PathBuf::from("C:\\devx-test\\data\\runtimes")
        );
    }

    #[test]
    fn ensure_dirs_creates_every_managed_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());

        paths.ensure_dirs().expect("create directories");

        for managed in paths.managed_dirs() {
            assert!(managed.is_dir(), "{} was not created", managed.display());
        }
    }

    #[test]
    fn ensure_dirs_is_idempotent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());

        paths.ensure_dirs().expect("first run");
        paths.ensure_dirs().expect("second run must not fail");
    }

    #[test]
    fn managed_dirs_are_all_under_a_root() {
        let paths = AppPaths::rooted_at(Path::new("C:\\devx-test"));

        for dir in paths.managed_dirs() {
            assert!(
                dir.starts_with(&paths.config_dir) || dir.starts_with(&paths.data_dir),
                "{} escapes both roots",
                dir.display()
            );
        }
    }
}
