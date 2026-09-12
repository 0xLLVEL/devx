//! Cached HTTP client for version metadata.
//!
//! Version indexes change slowly but are fetched often, so every response is
//! cached on disk with its `ETag` and revalidated with a conditional request.
//! Three properties matter here:
//!
//! * **Cheap repeats.** Within the TTL nothing hits the network at all.
//! * **Cheap revalidation.** After the TTL a `304 Not Modified` costs no body.
//! * **Works offline.** A transport failure serves the cached copy and marks it
//!   stale rather than showing the user an empty list.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devx_core::{fsx, Error, ErrorCode, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How long a cached response is served without revalidation.
pub const DEFAULT_TTL: Duration = Duration::from_secs(60 * 60);

/// Request timeout for metadata calls.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A response, possibly served from cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    /// Response body.
    pub body: String,
    /// Whether the body came from the on-disk cache rather than the network.
    pub from_cache: bool,
    /// Whether the cached body could not be revalidated and may be out of date.
    pub stale: bool,
}

/// On-disk cache entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    /// URL this entry belongs to, stored to make the files self-describing.
    url: String,
    /// `ETag` from the response, when the server sent one.
    #[serde(default)]
    etag: Option<String>,
    /// `Last-Modified` from the response, when the server sent one.
    #[serde(default)]
    last_modified: Option<String>,
    /// Unix seconds at which the entry was last validated.
    fetched_at: u64,
    /// Response body.
    body: String,
}

/// HTTP client with an on-disk revalidating cache.
#[derive(Debug, Clone)]
pub struct HttpClient {
    client: reqwest::Client,
    cache_dir: PathBuf,
    ttl: Duration,
    timeout: Duration,
}

impl HttpClient {
    /// Builds a client that caches under `cache_dir`.
    ///
    /// # Errors
    ///
    /// Fails if the underlying TLS stack cannot be initialised.
    pub fn new(cache_dir: impl Into<PathBuf>) -> Result<Self> {
        let user_agent = format!(
            "DevX/{} (+https://github.com/devx/devx)",
            env!("CARGO_PKG_VERSION")
        );

        let client = reqwest::Client::builder()
            .user_agent(user_agent)
            .build()
            .map_err(|err| {
                Error::new(
                    ErrorCode::Network,
                    format!("failed to create the HTTP client: {err}"),
                )
            })?;

        Ok(Self {
            client,
            cache_dir: cache_dir.into(),
            ttl: DEFAULT_TTL,
            timeout: REQUEST_TIMEOUT,
        })
    }

    /// Overrides how long cached responses are served without revalidation.
    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    /// Overrides the per-request timeout.
    ///
    /// A metadata lookup that hangs must not hang the UI: on timeout the client
    /// falls back to cached data like any other transport failure.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Fetches `url` as text, using and updating the cache.
    pub async fn get_text(&self, url: &str) -> Result<CachedResponse> {
        self.get_text_with_headers(url, &[]).await
    }

    /// Fetches `url` as text with extra request headers.
    pub async fn get_text_with_headers(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<CachedResponse> {
        let entry_path = self.entry_path(url);
        let cached = read_entry(&entry_path);

        if let Some(entry) = &cached {
            if self.is_fresh(entry) {
                tracing::debug!(url, "serving fresh cached response");
                return Ok(CachedResponse {
                    body: entry.body.clone(),
                    from_cache: true,
                    stale: false,
                });
            }
        }

        let mut request = self.client.get(url).timeout(self.timeout);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(entry) = &cached {
            if let Some(etag) = &entry.etag {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if let Some(last_modified) = &entry.last_modified {
                request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
            }
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(err) => return self.offline_fallback(url, cached, &err.to_string()),
        };

        let status = response.status();

        if status == reqwest::StatusCode::NOT_MODIFIED {
            if let Some(mut entry) = cached {
                tracing::debug!(url, "cached response revalidated");
                entry.fetched_at = now_unix();
                let _ = write_entry(&entry_path, &entry);
                return Ok(CachedResponse {
                    body: entry.body,
                    from_cache: true,
                    stale: false,
                });
            }

            // 304 without a cache entry means our conditional headers were
            // wrong; treat it as a failure rather than returning nothing.
            return Err(Error::new(
                ErrorCode::Network,
                format!("{url} returned 304 but no cached copy exists"),
            ));
        }

        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::not_found(format!("{url} returned 404")));
        }

        if status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            let rate_limited = response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.trim() == "0")
                .unwrap_or(false)
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS;

            let message = format!("{url} returned {status}");
            if rate_limited {
                return self.offline_fallback_or(
                    url,
                    cached,
                    Error::new(ErrorCode::Network, message).with_hint(
                        "the upstream API rate limit was reached; DevX will retry later, \
                         or set GITHUB_TOKEN to raise the limit",
                    ),
                );
            }
            return self.offline_fallback_or(url, cached, Error::new(ErrorCode::Network, message));
        }

        if status.is_server_error() {
            return self.offline_fallback(url, cached, &format!("server returned {status}"));
        }

        if !status.is_success() {
            return Err(Error::new(
                ErrorCode::Network,
                format!("{url} returned {status}"),
            ));
        }

        let etag = header_string(response.headers(), reqwest::header::ETAG);
        let last_modified = header_string(response.headers(), reqwest::header::LAST_MODIFIED);

        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => return self.offline_fallback(url, cached, &err.to_string()),
        };

        let entry = CacheEntry {
            url: url.to_owned(),
            etag,
            last_modified,
            fetched_at: now_unix(),
            body,
        };

        if let Err(err) = write_entry(&entry_path, &entry) {
            // A broken cache must not break the fetch.
            tracing::warn!(url, error = %err, "failed to write the HTTP cache entry");
        }

        Ok(CachedResponse {
            body: entry.body,
            from_cache: false,
            stale: false,
        })
    }

    /// Serves a stale cached copy, or reports the network failure.
    fn offline_fallback(
        &self,
        url: &str,
        cached: Option<CacheEntry>,
        reason: &str,
    ) -> Result<CachedResponse> {
        self.offline_fallback_or(
            url,
            cached,
            Error::new(
                ErrorCode::Network,
                format!("failed to fetch {url}: {reason}"),
            )
            .with_hint(
                "check your internet connection; DevX will use cached version data when available",
            ),
        )
    }

    /// Serves a stale cached copy, or returns `error`.
    fn offline_fallback_or(
        &self,
        url: &str,
        cached: Option<CacheEntry>,
        error: Error,
    ) -> Result<CachedResponse> {
        match cached {
            Some(entry) => {
                tracing::warn!(url, error = %error, "serving stale cached response");
                Ok(CachedResponse {
                    body: entry.body,
                    from_cache: true,
                    stale: true,
                })
            }
            None => Err(error),
        }
    }

    /// Whether `entry` may be served without revalidation.
    fn is_fresh(&self, entry: &CacheEntry) -> bool {
        now_unix().saturating_sub(entry.fetched_at) < self.ttl.as_secs()
    }

    /// Cache file for `url`.
    ///
    /// Hashing the URL keeps the file name short and free of characters Windows
    /// forbids, while staying stable across runs.
    fn entry_path(&self, url: &str) -> PathBuf {
        let digest = Sha256::digest(url.as_bytes());
        self.cache_dir.join(format!("{:x}.json", digest))
    }
}

/// Reads a cache entry, treating any problem as a cache miss.
fn read_entry(path: &Path) -> Option<CacheEntry> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(entry) => Some(entry),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "discarding corrupt cache entry");
            let _ = std::fs::remove_file(path);
            None
        }
    }
}

/// Writes a cache entry atomically.
fn write_entry(path: &Path, entry: &CacheEntry) -> Result<()> {
    let json = serde_json::to_string(entry)
        .map_err(|err| Error::internal(format!("failed to encode cache entry: {err}")))?;
    fsx::write_atomic(path, json)
}

/// Extracts a header as an owned string.
fn header_string(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Current time in Unix seconds, saturating at the epoch.
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_paths_are_stable_and_distinct() {
        let client = HttpClient::new("C:\\cache").expect("client");

        let first = client.entry_path("https://example.com/a.json");
        let second = client.entry_path("https://example.com/b.json");

        assert_eq!(first, client.entry_path("https://example.com/a.json"));
        assert_ne!(first, second);
        assert!(first.to_string_lossy().ends_with(".json"));
    }

    #[test]
    fn freshness_respects_the_ttl() {
        let client = HttpClient::new("C:\\cache")
            .expect("client")
            .with_ttl(Duration::from_secs(100));

        let fresh = CacheEntry {
            url: "https://example.com".to_owned(),
            etag: None,
            last_modified: None,
            fetched_at: now_unix(),
            body: String::new(),
        };
        assert!(client.is_fresh(&fresh));

        let stale = CacheEntry {
            fetched_at: now_unix() - 101,
            ..fresh
        };
        assert!(!client.is_fresh(&stale));
    }
}
