//! Turning a catalog entry into a list of installable versions.
//!
//! Dispatch is a `match` on [`Source`] rather than a `dyn` trait: the set of
//! upstream shapes is closed and defined by the catalog schema, and async trait
//! objects would require an extra dependency to express something no caller
//! needs. Each source has its own function so it can be tested in isolation.

use std::collections::HashMap;

use devx_core::{Error, ErrorCode, Result};
use serde::Deserialize;

use crate::catalog::{is_sha256_hex, Component, Source};
use crate::http::{CachedResponse, HttpClient};
use crate::version::{sort_newest_first, Artifact, Checksum, ComponentVersion, ReleaseChannel};

/// Upstream endpoints, overridable so tests can point at a local server.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// PHP for Windows release manifest.
    pub php_releases_url: String,
    /// Node.js distribution index.
    pub node_index_url: String,
    /// Base URL of the Node.js distribution tree, used for artifact links.
    pub node_dist_base_url: String,
    /// GitHub API base URL.
    pub github_api_base_url: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            php_releases_url: "https://windows.php.net/downloads/releases/releases.json".to_owned(),
            node_index_url: "https://nodejs.org/dist/index.json".to_owned(),
            node_dist_base_url: "https://nodejs.org/dist".to_owned(),
            github_api_base_url: "https://api.github.com".to_owned(),
        }
    }
}

/// Result of listing versions, including whether the data was stale.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct VersionListing {
    /// Versions, newest first.
    pub versions: Vec<ComponentVersion>,
    /// Whether the underlying metadata came from a stale cache.
    pub stale: bool,
    /// Versions that were skipped because no checksum is published for them.
    pub unverifiable: Vec<String>,
}

/// Resolves component versions from their upstreams.
#[derive(Debug, Clone)]
pub struct Resolver {
    http: HttpClient,
    endpoints: Endpoints,
    github_token: Option<String>,
}

impl Resolver {
    /// Builds a resolver using `http` for all requests.
    pub fn new(http: HttpClient) -> Self {
        Self {
            http,
            endpoints: Endpoints::default(),
            // A token is optional. Without one the GitHub API allows 60
            // requests per hour per IP, which the response cache keeps us well
            // inside for normal use.
            github_token: std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty()),
        }
    }

    /// Overrides upstream endpoints.
    pub fn with_endpoints(mut self, endpoints: Endpoints) -> Self {
        self.endpoints = endpoints;
        self
    }

    /// Sets the GitHub token used for API requests.
    pub fn with_github_token(mut self, token: Option<String>) -> Self {
        self.github_token = token.filter(|t| !t.is_empty());
        self
    }

    /// Lists the versions of `component` that DevX can install.
    pub async fn list_versions(&self, component: &Component) -> Result<VersionListing> {
        let mut listing = match &component.source {
            Source::PhpNet { thread_safe, arch } => {
                self.list_php(component, *thread_safe, arch.php_suffix())
                    .await?
            }
            Source::NodeDist { asset } => self.list_node(component, asset).await?,
            Source::GitHubReleases {
                repo,
                asset_pattern,
                checksum_asset_pattern,
                include_prereleases,
            } => {
                self.list_github(
                    component,
                    repo,
                    asset_pattern,
                    checksum_asset_pattern.as_deref(),
                    *include_prereleases,
                )
                .await?
            }
            Source::Pinned { versions } => VersionListing {
                versions: versions
                    .iter()
                    .map(|pinned| ComponentVersion {
                        component_id: component.id.clone(),
                        version: pinned.version.clone(),
                        channel: ReleaseChannel::Stable,
                        released_at: None,
                        artifact: Artifact {
                            url: pinned.url.clone(),
                            file_name: file_name_from_url(&pinned.url),
                            size_bytes: pinned.size_bytes,
                            archive: component.archive,
                            checksum: Checksum::Sha256 {
                                hex: pinned.sha256.clone(),
                            },
                        },
                    })
                    .collect(),
                stale: false,
                unverifiable: Vec::new(),
            },
        };

        sort_newest_first(&mut listing.versions);

        if listing.versions.is_empty() {
            return Err(Error::not_found(format!(
                "no installable versions found for `{}`",
                component.id
            ))
            .with_hint("the upstream may have changed its packaging; check for a DevX update"));
        }

        Ok(listing)
    }

    // --- windows.php.net ---------------------------------------------------

    /// Lists PHP versions from `releases.json`.
    ///
    /// The manifest holds the latest patch of every supported branch, with a
    /// SHA-256 per artifact. Variant keys embed the compiler that built them
    /// (`nts-vs17-x64` on 8.4, `nts-vc15-x64` on 7.4), so the compiler tag is
    /// matched loosely rather than hardcoded.
    async fn list_php(
        &self,
        component: &Component,
        thread_safe: bool,
        arch_suffix: &str,
    ) -> Result<VersionListing> {
        let response = self.http.get_text(&self.endpoints.php_releases_url).await?;
        let manifest: HashMap<String, PhpBranch> = parse_json(&response.body, "PHP releases.json")?;

        let wanted_prefix = if thread_safe { "ts-" } else { "nts-" };
        let wanted_suffix = format!("-{arch_suffix}");

        let mut versions = Vec::new();
        let mut unverifiable = Vec::new();

        for (branch, entry) in manifest {
            let Some(version) = entry.version.clone() else {
                tracing::debug!(branch, "PHP branch has no version field; skipping");
                continue;
            };

            let variant = entry
                .variants
                .iter()
                .find(|(key, _)| key.starts_with(wanted_prefix) && key.ends_with(&wanted_suffix));

            let Some((variant_key, variant)) = variant else {
                tracing::debug!(
                    branch,
                    %version,
                    "no {wanted_prefix}*{wanted_suffix} build published; skipping"
                );
                continue;
            };

            let Some(zip) = &variant.zip else {
                tracing::debug!(branch, %version, %variant_key, "variant has no zip");
                continue;
            };

            if !is_sha256_hex(&zip.sha256) {
                unverifiable.push(version.clone());
                continue;
            }

            let url = join_url(base_url_of(&self.endpoints.php_releases_url), &zip.path);

            versions.push(ComponentVersion {
                component_id: component.id.clone(),
                version,
                channel: ReleaseChannel::Stable,
                released_at: variant.mtime.as_deref().and_then(date_part),
                artifact: Artifact {
                    url,
                    file_name: zip.path.clone(),
                    size_bytes: None,
                    archive: component.archive,
                    checksum: Checksum::Sha256 {
                        hex: zip.sha256.clone(),
                    },
                },
            });
        }

        Ok(VersionListing {
            versions,
            stale: response.stale,
            unverifiable,
        })
    }

    // --- nodejs.org -------------------------------------------------------

    /// Lists Node versions from `index.json`.
    ///
    /// Checksums live in a per-release `SHASUMS256.txt`, so they are recorded as
    /// a deferred [`Checksum::Sha256File`] instead of fetching hundreds of files.
    async fn list_node(&self, component: &Component, asset: &str) -> Result<VersionListing> {
        let response = self.http.get_text(&self.endpoints.node_index_url).await?;
        let index: Vec<NodeRelease> = parse_json(&response.body, "Node index.json")?;

        let versions = index
            .into_iter()
            .filter(|release| release.files.iter().any(|file| file == asset))
            .map(|release| {
                let file_name = node_file_name(&release.version, asset);
                let base = format!(
                    "{}/{}",
                    self.endpoints.node_dist_base_url.trim_end_matches('/'),
                    release.version
                );

                ComponentVersion {
                    component_id: component.id.clone(),
                    version: release.version.trim_start_matches('v').to_owned(),
                    channel: if release.lts.is_named() {
                        ReleaseChannel::Lts
                    } else {
                        ReleaseChannel::Stable
                    },
                    released_at: Some(release.date.clone()),
                    artifact: Artifact {
                        url: format!("{base}/{file_name}"),
                        file_name: file_name.clone(),
                        size_bytes: None,
                        archive: component.archive,
                        checksum: Checksum::Sha256File {
                            url: format!("{base}/SHASUMS256.txt"),
                            file_name,
                        },
                    },
                }
            })
            .collect();

        Ok(VersionListing {
            versions,
            stale: response.stale,
            unverifiable: Vec::new(),
        })
    }

    // --- GitHub releases --------------------------------------------------

    /// Lists versions from a repository's releases.
    ///
    /// A release is only offered when its artifact has a verifiable hash: either
    /// the API reports a `digest`, or the release ships a matching sums file.
    /// Anything else is reported through [`VersionListing::unverifiable`] rather
    /// than silently offered as an unverified download.
    async fn list_github(
        &self,
        component: &Component,
        repo: &str,
        asset_pattern: &str,
        checksum_asset_pattern: Option<&str>,
        include_prereleases: bool,
    ) -> Result<VersionListing> {
        let asset_regex = regex::Regex::new(asset_pattern)
            .map_err(|err| Error::config(format!("invalid asset pattern: {err}")))?;
        let checksum_regex = match checksum_asset_pattern {
            Some(pattern) => Some(
                regex::Regex::new(pattern)
                    .map_err(|err| Error::config(format!("invalid checksum pattern: {err}")))?,
            ),
            None => None,
        };

        let url = format!(
            "{}/repos/{repo}/releases?per_page=100",
            self.endpoints.github_api_base_url.trim_end_matches('/')
        );

        let response = self.fetch_github(&url).await?;
        let releases: Vec<GitHubRelease> = parse_json(&response.body, "GitHub releases")?;

        let mut versions = Vec::new();
        let mut unverifiable = Vec::new();

        for release in releases {
            if release.draft || (release.prerelease && !include_prereleases) {
                continue;
            }

            let Some(asset) = release
                .assets
                .iter()
                .find(|asset| asset_regex.is_match(&asset.name))
            else {
                tracing::debug!(repo, tag = %release.tag_name, "no matching asset");
                continue;
            };

            let checksum = match digest_to_sha256(asset.digest.as_deref()) {
                Some(hex) => Checksum::Sha256 { hex },
                None => {
                    let sums_asset = checksum_regex.as_ref().and_then(|regex| {
                        release
                            .assets
                            .iter()
                            .find(|candidate| regex.is_match(&candidate.name))
                    });

                    match sums_asset {
                        Some(sums) => Checksum::Sha256File {
                            url: sums.browser_download_url.clone(),
                            file_name: asset.name.clone(),
                        },
                        None => {
                            tracing::debug!(
                                repo,
                                tag = %release.tag_name,
                                "release has no published checksum; not offering it"
                            );
                            unverifiable.push(release.tag_name.clone());
                            continue;
                        }
                    }
                }
            };

            versions.push(ComponentVersion {
                component_id: component.id.clone(),
                version: release.tag_name.trim_start_matches('v').to_owned(),
                channel: if release.prerelease {
                    ReleaseChannel::Prerelease
                } else {
                    ReleaseChannel::Stable
                },
                released_at: release.published_at.as_deref().and_then(date_part),
                artifact: Artifact {
                    url: asset.browser_download_url.clone(),
                    file_name: asset.name.clone(),
                    size_bytes: Some(asset.size),
                    archive: component.archive,
                    checksum,
                },
            });
        }

        Ok(VersionListing {
            versions,
            stale: response.stale,
            unverifiable,
        })
    }

    /// Performs a GitHub API request with the documented headers.
    async fn fetch_github(&self, url: &str) -> Result<CachedResponse> {
        let mut headers: Vec<(&str, &str)> = vec![
            ("accept", "application/vnd.github+json"),
            ("x-github-api-version", "2022-11-28"),
        ];

        let authorization;
        if let Some(token) = &self.github_token {
            authorization = format!("Bearer {token}");
            headers.push(("authorization", &authorization));
        }

        self.http.get_text_with_headers(url, &headers).await
    }
}

/// Extracts the hex digest from GitHub's `sha256:<hex>` form.
fn digest_to_sha256(digest: Option<&str>) -> Option<String> {
    let value = digest?.strip_prefix("sha256:")?.to_ascii_lowercase();
    is_sha256_hex(&value).then_some(value)
}

/// Node artifact file name for a version and asset id, e.g. `win-x64-zip`.
fn node_file_name(version: &str, asset: &str) -> String {
    match asset.rsplit_once('-') {
        Some((platform, extension)) => format!("node-{version}-{platform}.{extension}"),
        None => format!("node-{version}-{asset}"),
    }
}

/// Directory portion of a URL, without the trailing file name.
fn base_url_of(url: &str) -> &str {
    match url.rfind('/') {
        Some(index) => &url[..index],
        None => url,
    }
}

/// Joins a base URL and a relative path.
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Takes the `YYYY-MM-DD` prefix of a timestamp.
fn date_part(timestamp: &str) -> Option<String> {
    let date = timestamp.get(..10)?;
    let looks_like_date = date.len() == 10
        && date.as_bytes()[4] == b'-'
        && date.as_bytes()[7] == b'-'
        && date
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());

    looks_like_date.then(|| date.to_owned())
}

/// Deserializes JSON, reporting the upstream by name on failure.
fn parse_json<T: serde::de::DeserializeOwned>(body: &str, what: &str) -> Result<T> {
    serde_json::from_str(body).map_err(|err| {
        Error::new(
            ErrorCode::Network,
            format!("{what} could not be parsed: {err}"),
        )
        .with_hint("the upstream format may have changed; check for a DevX update")
    })
}

/// File name at the end of a URL.
fn file_name_from_url(url: &str) -> String {
    url.rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download")
        .to_owned()
}

// --- upstream response shapes ---------------------------------------------

/// One branch entry in `releases.json`.
#[derive(Debug, Deserialize)]
struct PhpBranch {
    #[serde(default)]
    version: Option<String>,
    /// Build variants, keyed like `nts-vs17-x64`. Non-variant keys such as
    /// `source` and `test_pack` deserialize here too and are ignored by the
    /// prefix/suffix match.
    #[serde(flatten)]
    variants: HashMap<String, PhpVariant>,
}

/// A single PHP build variant.
#[derive(Debug, Deserialize)]
struct PhpVariant {
    #[serde(default)]
    zip: Option<PhpArtifact>,
    #[serde(default)]
    mtime: Option<String>,
}

/// A PHP artifact with its hash.
#[derive(Debug, Deserialize)]
struct PhpArtifact {
    path: String,
    sha256: String,
}

/// One entry in the Node distribution index.
#[derive(Debug, Deserialize)]
struct NodeRelease {
    version: String,
    date: String,
    files: Vec<String>,
    lts: NodeLts,
}

/// Node's `lts` field: `false` for non-LTS, otherwise the codename.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NodeLts {
    /// `false`. The payload is unused; the variant exists so the untagged
    /// deserializer accepts a boolean instead of failing.
    No(#[allow(dead_code)] bool),
    /// `"Jod"`, `"Iron"`, and so on.
    Named(String),
}

impl NodeLts {
    fn is_named(&self) -> bool {
        matches!(self, Self::Named(name) if !name.is_empty())
    }
}

/// A GitHub release.
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

/// A GitHub release asset.
#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    /// `sha256:<hex>`, absent on releases published before GitHub recorded it.
    #[serde(default)]
    digest: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn node_file_names_follow_the_dist_layout() {
        assert_eq!(
            node_file_name("v26.5.0", "win-x64-zip"),
            "node-v26.5.0-win-x64.zip"
        );
        assert_eq!(
            node_file_name("v24.9.0", "win-arm64-zip"),
            "node-v24.9.0-win-arm64.zip"
        );
    }

    #[test]
    fn php_artifact_urls_are_built_from_the_manifest_location() {
        let base = base_url_of("https://windows.php.net/downloads/releases/releases.json");
        assert_eq!(base, "https://windows.php.net/downloads/releases");
        assert_eq!(
            join_url(base, "php-8.4.25-nts-Win32-vs17-x64.zip"),
            "https://windows.php.net/downloads/releases/php-8.4.25-nts-Win32-vs17-x64.zip"
        );
    }

    #[test]
    fn github_digests_are_normalised_and_validated() {
        let hex = "e70eea271f2b8d4bc113fe4a95331beaa2cd4b22c4ed07c93c54e342cb1788db";

        assert_eq!(
            digest_to_sha256(Some(&format!("sha256:{hex}"))),
            Some(hex.to_owned())
        );
        assert_eq!(
            digest_to_sha256(Some(&format!("SHA256:{}", hex.to_uppercase()))),
            None,
            "an unexpected prefix case must not be trusted"
        );
        assert_eq!(digest_to_sha256(Some("md5:abc")), None);
        assert_eq!(digest_to_sha256(Some("sha256:short")), None);
        assert_eq!(digest_to_sha256(None), None);
    }

    #[test]
    fn date_prefixes_are_extracted_and_junk_rejected() {
        assert_eq!(
            date_part("2026-08-18T02:20:25Z"),
            Some("2026-08-18".to_owned())
        );
        assert_eq!(
            date_part("2024-07-10T21:09:08+00:00"),
            Some("2024-07-10".to_owned())
        );
        assert_eq!(date_part("not-a-date"), None);
        assert_eq!(date_part("2026"), None);
    }

    #[test]
    fn url_file_names_are_extracted() {
        assert_eq!(
            file_name_from_url("https://nginx.org/download/nginx-1.31.5.zip"),
            "nginx-1.31.5.zip"
        );
        assert_eq!(
            file_name_from_url(
                "https://dl.min.io/server/minio/release/windows-amd64/archive/minio.RELEASE.2025-09-07T16-13-09Z"
            ),
            "minio.RELEASE.2025-09-07T16-13-09Z"
        );
    }
}
