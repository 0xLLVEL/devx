//! Streaming artifact downloads with progress, resume and retry.
//!
//! Artifacts are large (tens to hundreds of megabytes) and the network is not,
//! so this module streams to disk rather than buffering, reports progress for
//! the UI, resumes interrupted transfers with a `Range` request, and retries
//! transient failures with backoff. Verification and extraction are separate
//! steps (see [`crate::verify`] and [`crate::extract`]); this module only gets
//! the bytes down intact.

use std::path::{Path, PathBuf};
use std::time::Duration;

use devx_core::{Error, ErrorCode, Result};
use futures::StreamExt;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// Progress of an in-flight download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    /// Bytes written to disk so far, including any resumed prefix.
    pub downloaded: u64,
    /// Total size when the server reports one.
    pub total: Option<u64>,
}

impl Progress {
    /// Completion as a fraction in `0.0..=1.0`, when the total is known.
    pub fn fraction(&self) -> Option<f64> {
        self.total
            .and_then(|total| (total > 0).then(|| (self.downloaded as f64 / total as f64).min(1.0)))
    }
}

/// How a download behaves. Separated from the client so tests can shrink it.
#[derive(Debug, Clone)]
pub struct DownloadOptions {
    /// Attempts before giving up, including the first.
    pub max_attempts: u32,
    /// Base backoff between attempts; doubles each retry.
    pub backoff_base: Duration,
    /// Timeout for *establishing* the connection.
    ///
    /// Deliberately not a whole-request timeout: a large artifact over a slow
    /// link legitimately takes minutes, and a request-wide timeout would abort
    /// it mid-body (surfacing as "error decoding response body"). Stalls are
    /// caught by [`Self::read_timeout`] on the body stream instead.
    pub connect_timeout: Duration,
    /// Maximum idle time between received chunks before the attempt is aborted.
    pub read_timeout: Duration,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            backoff_base: Duration::from_millis(500),
            connect_timeout: Duration::from_secs(30),
            read_timeout: Duration::from_secs(60),
        }
    }
}

/// Downloads artifacts to a directory, resuming and retrying as needed.
#[derive(Debug, Clone)]
pub struct Downloader {
    client: reqwest::Client,
    options: DownloadOptions,
}

impl Downloader {
    /// Builds a downloader with default behaviour.
    pub fn new() -> Result<Self> {
        Self::with_options(DownloadOptions::default())
    }

    /// Builds a downloader with explicit options.
    pub fn with_options(options: DownloadOptions) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(format!("DevX/{}", env!("CARGO_PKG_VERSION")))
            // Artifacts are already-compressed archives. Transparent gzip
            // decoding would corrupt the bytes when a CDN serves the file with
            // `Content-Encoding: gzip` on top of a `.zip`, and it makes the
            // downloaded length disagree with `Content-Length`, breaking resume.
            // We want the exact bytes on the wire, so decompression is off.
            .no_gzip()
            .no_brotli()
            .no_deflate()
            // Time out the connection handshake, not the whole transfer.
            .connect_timeout(options.connect_timeout)
            // Abort if the body stalls, so a dead connection is retried rather
            // than hanging forever.
            .read_timeout(options.read_timeout)
            .build()
            .map_err(|err| {
                Error::new(
                    ErrorCode::Network,
                    format!("failed to build HTTP client: {err}"),
                )
            })?;

        Ok(Self { client, options })
    }

    /// Downloads `url` into `dest`, invoking `on_progress` as bytes arrive.
    ///
    /// A partial file from an earlier interrupted run is resumed with a `Range`
    /// request when the server supports it, and discarded and restarted when it
    /// does not. Progress callbacks are throttled by the caller if needed; this
    /// method calls back on every chunk.
    pub async fn download(
        &self,
        url: &str,
        dest: impl AsRef<Path>,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<()> {
        let dest = dest.as_ref();
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|err| {
                Error::new(
                    ErrorCode::Io,
                    format!("failed to create {}: {err}", parent.display()),
                )
            })?;
        }

        let partial = partial_path(dest);
        let mut last_error = None;

        for attempt in 1..=self.options.max_attempts {
            let already_have = tokio::fs::metadata(&partial)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);

            match self
                .attempt(url, &partial, already_have, &mut on_progress)
                .await
            {
                Ok(()) => {
                    // Promote the completed partial to its final name.
                    tokio::fs::rename(&partial, dest).await.map_err(|err| {
                        Error::new(
                            ErrorCode::Io,
                            format!("failed to finalise {}: {err}", dest.display()),
                        )
                    })?;
                    return Ok(());
                }
                Err(err) => {
                    let retryable = err.code == ErrorCode::Network;
                    tracing::warn!(url, attempt, retryable, error = %err, "download attempt failed");
                    last_error = Some(err);

                    if !retryable || attempt == self.options.max_attempts {
                        break;
                    }

                    let backoff = self.options.backoff_base * 2u32.pow(attempt - 1);
                    tokio::time::sleep(backoff).await;
                }
            }
        }

        Err(last_error
            .unwrap_or_else(|| Error::new(ErrorCode::Network, format!("failed to download {url}"))))
    }

    /// One download attempt, appending to `partial` from `resume_from`.
    async fn attempt(
        &self,
        url: &str,
        partial: &Path,
        resume_from: u64,
        on_progress: &mut impl FnMut(Progress),
    ) -> Result<()> {
        // No per-request timeout: connect and read timeouts on the client cover
        // handshake and stalls, while a legitimately long transfer runs to
        // completion.
        let mut request = self.client.get(url);
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }

        let response = request.send().await.map_err(|err| {
            Error::new(
                ErrorCode::Network,
                format!("request to {url} failed: {err}"),
            )
        })?;

        let status = response.status();
        if !status.is_success() {
            let code = if status.is_client_error() {
                // 4xx will not fix itself on retry.
                ErrorCode::Integrity
            } else {
                ErrorCode::Network
            };
            return Err(Error::new(code, format!("{url} returned {status}")));
        }

        // The server honours resume only with 206; a 200 means it ignored the
        // Range header and is sending the whole file, so start over.
        let resuming = resume_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        let base = if resuming { resume_from } else { 0 };

        let total = response
            .content_length()
            .map(|len| base + len)
            .filter(|&total| total > 0);

        let mut file = if resuming {
            let mut file = tokio::fs::OpenOptions::new()
                .append(true)
                .open(partial)
                .await
                .map_err(|err| io_error(err, partial, "reopen partial download"))?;
            file.seek(std::io::SeekFrom::End(0))
                .await
                .map_err(|err| io_error(err, partial, "seek partial download"))?;
            file
        } else {
            tokio::fs::File::create(partial)
                .await
                .map_err(|err| io_error(err, partial, "create partial download"))?
        };

        let mut downloaded = base;
        on_progress(Progress { downloaded, total });

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| {
                Error::new(
                    ErrorCode::Network,
                    format!("stream from {url} broke: {err}"),
                )
            })?;
            file.write_all(&chunk)
                .await
                .map_err(|err| io_error(err, partial, "write download"))?;
            downloaded += chunk.len() as u64;
            on_progress(Progress { downloaded, total });
        }

        file.flush()
            .await
            .map_err(|err| io_error(err, partial, "flush download"))?;

        // A truncated transfer should be retried, not treated as complete.
        if let Some(total) = total {
            if downloaded < total {
                return Err(Error::new(
                    ErrorCode::Network,
                    format!("{url} ended early: {downloaded} of {total} bytes"),
                ));
            }
        }

        Ok(())
    }
}

/// Sidecar path for an in-progress download.
fn partial_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_owned());
    dest.with_file_name(format!("{name}.partial"))
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
    fn fraction_is_none_without_a_total() {
        let progress = Progress {
            downloaded: 10,
            total: None,
        };
        assert_eq!(progress.fraction(), None);
    }

    #[test]
    fn fraction_is_clamped_and_computed() {
        assert_eq!(
            Progress {
                downloaded: 50,
                total: Some(100)
            }
            .fraction(),
            Some(0.5)
        );
        // A server that under-reports content-length must not yield > 1.0.
        assert_eq!(
            Progress {
                downloaded: 120,
                total: Some(100)
            }
            .fraction(),
            Some(1.0)
        );
    }

    #[test]
    fn partial_path_is_a_sibling() {
        let dest = Path::new("C:\\devx\\downloads\\php.zip");
        assert_eq!(
            partial_path(dest),
            Path::new("C:\\devx\\downloads\\php.zip.partial")
        );
    }
}
