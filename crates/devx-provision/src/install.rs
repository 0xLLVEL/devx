//! Atomic component installation: download, verify, extract, promote.
//!
//! An installed version lives at `runtimes/<component>/<version>/`. The pipeline
//! guarantees that directory only ever appears fully formed: work happens in a
//! staging directory that is renamed into place as the last step, and any
//! failure removes all partial state. A half-installed runtime is worse than a
//! missing one, because the supervisor would try to run it.

use std::path::{Path, PathBuf};

use devx_core::{AppPaths, Error, ErrorCode, Result};

use crate::catalog::Layout;
use crate::download::{DownloadOptions, Downloader, Progress};
use crate::http::HttpClient;
use crate::verify::{parse_sums_document, verify_sha256};
use crate::version::{Checksum, ComponentVersion};

/// Stage an install is currently in, reported to the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum InstallStage {
    /// Resolving the artifact's checksum, when it is published separately.
    ResolvingChecksum,
    /// Downloading, with byte progress.
    Downloading(Progress),
    /// Verifying the SHA-256.
    Verifying,
    /// Extracting the archive.
    Extracting,
    /// Promoting the staged directory into place.
    Finalising,
    /// Done.
    Done,
}

/// Installs and removes component versions.
pub struct Installer {
    paths: AppPaths,
    http: HttpClient,
    downloader: Downloader,
    keep_archives: bool,
}

impl Installer {
    /// Builds an installer writing under `paths`.
    pub fn new(paths: AppPaths, http: HttpClient) -> Result<Self> {
        Ok(Self {
            paths,
            http,
            downloader: Downloader::new()?,
            keep_archives: false,
        })
    }

    /// Sets download retry behaviour.
    pub fn with_download_options(mut self, options: DownloadOptions) -> Result<Self> {
        self.downloader = Downloader::with_options(options)?;
        Ok(self)
    }

    /// Keeps the downloaded archive after a successful install.
    pub fn keep_archives(mut self, keep: bool) -> Self {
        self.keep_archives = keep;
        self
    }

    /// Directory a version is installed at, whether or not it exists yet.
    pub fn install_dir(&self, component_id: &str, version: &str) -> PathBuf {
        self.paths
            .runtimes_dir()
            .join(component_id)
            .join(sanitize(version))
    }

    /// Whether a version is installed.
    pub fn is_installed(&self, component_id: &str, version: &str) -> bool {
        // A `.ok` marker is written last, so its presence means the directory is
        // complete rather than a leftover from an interrupted run.
        self.install_dir(component_id, version)
            .join(".devx-ok")
            .is_file()
    }

    /// Installs `version` with the given `layout`, reporting progress.
    ///
    /// The `layout` comes from the component's catalog entry and decides how the
    /// archive maps onto the install directory.
    ///
    /// Idempotent: an already-installed version returns immediately. On any
    /// failure the staging directory and partial download are removed, leaving
    /// no trace.
    pub async fn install(
        &self,
        version: &ComponentVersion,
        layout: &Layout,
        mut on_stage: impl FnMut(InstallStage),
    ) -> Result<PathBuf> {
        let install_dir = self.install_dir(&version.component_id, &version.version);

        if self.is_installed(&version.component_id, &version.version) {
            on_stage(InstallStage::Done);
            return Ok(install_dir);
        }

        // A stale directory without the marker is the debris of an earlier
        // failure; clear it before starting.
        if install_dir.exists() {
            remove_dir_best_effort(&install_dir);
        }

        let expected_hash = self.resolve_hash(version, &mut on_stage).await?;

        let downloads = self.paths.downloads_dir();
        let archive = downloads.join(format!(
            "{}-{}-{}",
            version.component_id,
            sanitize(&version.version),
            version.artifact.file_name
        ));

        self.downloader
            .download(&version.artifact.url, &archive, |progress| {
                on_stage(InstallStage::Downloading(progress));
            })
            .await?;

        // From here, clean up the archive on any failure path too.
        let result = self
            .verify_and_extract(
                version,
                layout,
                &archive,
                &install_dir,
                expected_hash,
                &mut on_stage,
            )
            .await;

        if result.is_err() || !self.keep_archives {
            let _ = std::fs::remove_file(&archive);
        }

        result.map(|()| install_dir)
    }

    /// Verifies the archive, extracts to staging, and promotes it.
    async fn verify_and_extract(
        &self,
        version: &ComponentVersion,
        layout: &Layout,
        archive: &Path,
        install_dir: &Path,
        expected_hash: String,
        on_stage: &mut impl FnMut(InstallStage),
    ) -> Result<()> {
        on_stage(InstallStage::Verifying);
        verify_sha256(archive, &expected_hash).await?;

        on_stage(InstallStage::Extracting);
        let staging = self.staging_dir(&version.component_id, &version.version);
        remove_dir_best_effort(&staging);
        std::fs::create_dir_all(&staging)
            .map_err(|err| io_error(err, &staging, "create staging directory"))?;

        // Extraction runs on a blocking thread: it is CPU- and IO-bound and the
        // zip crate is synchronous.
        let extract_result = {
            let archive = archive.to_path_buf();
            let staging = staging.clone();
            let archive_kind = version.artifact.archive;
            let layout = layout.clone();
            tokio::task::spawn_blocking(move || {
                crate::extract::extract(
                    &archive,
                    &staging,
                    archive_kind,
                    layout.strip_prefix,
                    layout.executable_name.as_deref(),
                )
            })
            .await
            .map_err(|err| Error::internal(format!("extraction task panicked: {err}")))?
        };

        if let Err(err) = extract_result {
            remove_dir_best_effort(&staging);
            return Err(err);
        }

        on_stage(InstallStage::Finalising);
        self.promote(&staging, install_dir)?;

        on_stage(InstallStage::Done);
        Ok(())
    }

    /// Resolves the artifact's expected hash, fetching a sums file if needed.
    async fn resolve_hash(
        &self,
        version: &ComponentVersion,
        on_stage: &mut impl FnMut(InstallStage),
    ) -> Result<String> {
        match &version.artifact.checksum {
            Checksum::Sha256 { hex } => Ok(hex.clone()),
            Checksum::Sha256File { url, file_name } => {
                on_stage(InstallStage::ResolvingChecksum);
                let response = self.http.get_text(url).await?;
                parse_sums_document(&response.body, file_name)
            }
        }
    }

    /// Atomically replaces `install_dir` with `staging` and marks it complete.
    fn promote(&self, staging: &Path, install_dir: &Path) -> Result<()> {
        if let Some(parent) = install_dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_error(err, parent, "create component directory"))?;
        }

        // A leftover target would make rename fail on Windows.
        if install_dir.exists() {
            remove_dir_best_effort(install_dir);
        }

        std::fs::rename(staging, install_dir).map_err(|err| {
            remove_dir_best_effort(staging);
            io_error(err, install_dir, "promote staged install")
        })?;

        // The marker is the last thing written, so `is_installed` is only true
        // once every file is in place.
        let marker = install_dir.join(".devx-ok");
        std::fs::write(&marker, b"ok").map_err(|err| {
            remove_dir_best_effort(install_dir);
            io_error(err, &marker, "write completion marker")
        })?;

        Ok(())
    }

    /// Removes an installed version.
    pub fn uninstall(&self, component_id: &str, version: &str) -> Result<()> {
        let install_dir = self.install_dir(component_id, version);
        if !install_dir.exists() {
            return Err(Error::not_found(format!(
                "{component_id} {version} is not installed"
            )));
        }
        std::fs::remove_dir_all(&install_dir)
            .map_err(|err| io_error(err, &install_dir, "remove installed version"))
    }

    /// Staging directory for an install in progress.
    fn staging_dir(&self, component_id: &str, version: &str) -> PathBuf {
        self.paths.staging_dir().join(format!(
            "{component_id}-{}-{}",
            sanitize(version),
            std::process::id()
        ))
    }
}

/// Best-effort recursive removal, used on cleanup paths where failure is logged
/// but not propagated.
fn remove_dir_best_effort(path: &Path) {
    if path.exists() {
        if let Err(err) = std::fs::remove_dir_all(path) {
            tracing::warn!(path = %path.display(), error = %err, "failed to clean up directory");
        }
    }
}

/// Makes a version string safe as a single path component.
///
/// MinIO versions such as `RELEASE.2025-09-07T16-13-09Z` contain `:` in their
/// original form; the catalog already uses the safe form, but this defends
/// against anything with a path separator or colon slipping through.
fn sanitize(version: &str) -> String {
    version
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

/// Wraps an IO error with context.
fn io_error(err: std::io::Error, path: &Path, action: &str) -> Error {
    Error::new(
        ErrorCode::Io,
        format!("failed to {action} at {}: {err}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_forbidden_characters() {
        assert_eq!(sanitize("8.4.25"), "8.4.25");
        assert_eq!(
            sanitize("RELEASE.2025-09-07T16:13:09Z"),
            "RELEASE.2025-09-07T16_13_09Z"
        );
        assert_eq!(sanitize("../evil"), ".._evil");
    }

    #[test]
    fn install_dir_is_under_the_runtimes_root() {
        let paths = AppPaths::rooted_at(Path::new("C:\\devx-test"));
        let http = HttpClient::new(paths.cache_dir()).expect("http");
        let installer = Installer::new(paths.clone(), http).expect("installer");

        let dir = installer.install_dir("php", "8.4.25");
        assert_eq!(dir, paths.runtimes_dir().join("php").join("8.4.25"));
    }

    #[test]
    fn not_installed_without_the_completion_marker() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());
        let http = HttpClient::new(paths.cache_dir()).expect("http");
        let installer = Installer::new(paths.clone(), http).expect("installer");

        // A directory that exists but lacks the marker counts as not installed.
        let install_dir = installer.install_dir("php", "8.4.25");
        std::fs::create_dir_all(&install_dir).expect("create");
        assert!(!installer.is_installed("php", "8.4.25"));

        std::fs::write(install_dir.join(".devx-ok"), b"ok").expect("marker");
        assert!(installer.is_installed("php", "8.4.25"));
    }

    #[test]
    fn uninstalling_a_missing_version_is_not_found() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());
        let http = HttpClient::new(paths.cache_dir()).expect("http");
        let installer = Installer::new(paths, http).expect("installer");

        let err = installer.uninstall("php", "8.4.25").expect_err("must fail");
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
