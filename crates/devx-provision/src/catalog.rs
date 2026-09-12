//! The component catalog: what DevX can install and where it comes from.
//!
//! A catalog is data, not code. It ships embedded in the binary so a fresh
//! install works offline, and can be replaced at runtime by a signed remote copy
//! so new component versions do not require a DevX release.
//!
//! Each component names a *source strategy* rather than a fixed URL, because the
//! upstreams publish version metadata in incompatible ways: PHP has a JSON
//! manifest with hashes, Node has a version index plus separate checksum files,
//! GitHub projects have the releases API, and a few vendors publish nothing
//! machine-readable at all and must be pinned by hand.

use std::collections::BTreeMap;

use devx_core::{Error, Result};
use serde::{Deserialize, Serialize};

/// Catalog shipped with this build.
const EMBEDDED_CATALOG: &str = include_str!("../../../catalog/catalog.json");

/// Catalog schema version understood by this build.
pub const CATALOG_SCHEMA_VERSION: u32 = 1;

/// What a component is for, used for grouping in the UI.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ComponentKind {
    /// Language runtime such as PHP or Node.
    Runtime,
    /// HTTP server or reverse proxy.
    WebServer,
    /// Relational database.
    Database,
    /// Key-value cache.
    Cache,
    /// Mail catcher.
    Mail,
    /// Object storage.
    Storage,
    /// Search engine.
    Search,
    /// Developer tool such as Composer.
    Tool,
    /// Tunnelling client used for sharing sites.
    Tunnel,
}

/// CPU architecture of an artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Arch {
    /// 64-bit x86.
    X64,
    /// 64-bit ARM.
    Arm64,
}

impl Arch {
    /// Suffix used by `windows.php.net` variant keys.
    pub fn php_suffix(self) -> &'static str {
        match self {
            Self::X64 => "x64",
            Self::Arm64 => "arm64",
        }
    }
}

/// Archive format of a downloaded artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveKind {
    /// A `.zip` archive.
    Zip,
    /// A gzip-compressed tarball.
    TarGz,
    /// A single executable, downloaded as-is.
    Executable,
}

/// How leading directories in an archive map onto the install directory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StripPrefix {
    /// Drop a single wrapper directory when the archive has exactly one.
    ///
    /// The default, because most Windows archives wrap their contents in one
    /// versioned directory (`node-v26.5.0-win-x64/…`, `nginx-1.31.5/…`) while
    /// others (PHP, Caddy) put files at the root. Detecting this beats encoding
    /// a per-component guess that silently breaks when an upstream changes its
    /// packaging.
    #[default]
    Auto,
    /// Extract exactly as packaged.
    None,
    /// Always drop this many leading components.
    Components(u8),
}

/// How an extracted archive maps onto the installation directory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    /// Wrapper-directory handling.
    #[serde(default)]
    pub strip_prefix: StripPrefix,

    /// File name to give a bare executable download.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_name: Option<String>,
}

/// Where version metadata and artifacts come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Source {
    /// `windows.php.net/downloads/releases/releases.json`.
    ///
    /// Publishes the latest patch of every supported branch together with a
    /// SHA-256 for each artifact.
    PhpNet {
        /// Select the thread-safe (`ts`) or non-thread-safe (`nts`) build.
        ///
        /// DevX runs PHP as FastCGI worker processes, which do not need thread
        /// safety; NTS is both faster and the upstream recommendation.
        thread_safe: bool,
        /// Target architecture.
        arch: Arch,
    },

    /// `nodejs.org/dist/index.json`, with checksums in each release's
    /// `SHASUMS256.txt`.
    NodeDist {
        /// Asset identifier as listed in the index, e.g. `win-x64-zip`.
        asset: String,
    },

    /// The GitHub releases API for a repository.
    ///
    /// Renamed explicitly because `rename_all = "snake_case"` would turn
    /// `GitHubReleases` into `git_hub_releases`.
    #[serde(rename = "github_releases")]
    GitHubReleases {
        /// `owner/name`.
        repo: String,
        /// Regular expression matched against release asset names.
        asset_pattern: String,
        /// Regular expression matching a `sha256sum`-style asset in the same
        /// release.
        ///
        /// Used when the API reports no `digest` for the artifact, which is the
        /// case for releases published before GitHub started recording them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checksum_asset_pattern: Option<String>,
        /// Whether pre-release tags are offered.
        #[serde(default)]
        include_prereleases: bool,
    },

    /// Versions listed explicitly in the catalog.
    ///
    /// For vendors that publish no machine-readable index. The catalog must
    /// carry the SHA-256, because there is nowhere else to get it.
    Pinned {
        /// Available versions, newest first.
        versions: Vec<PinnedVersion>,
    },
}

/// A hand-pinned version and its artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedVersion {
    /// Version string, e.g. `17.6.1`.
    pub version: String,
    /// Direct download URL.
    pub url: String,
    /// Lowercase hex SHA-256 of the artifact.
    pub sha256: String,
    /// Artifact size in bytes, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// A single installable component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Component {
    /// Stable identifier used in paths and configuration, e.g. `php`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Grouping for the UI.
    pub kind: ComponentKind,
    /// One-line description.
    pub summary: String,
    /// Project homepage.
    pub homepage: String,
    /// SPDX licence identifier, or a short description.
    pub license: String,
    /// Whether several versions may be installed side by side.
    #[serde(default)]
    pub multi_version: bool,
    /// Where versions and artifacts come from.
    pub source: Source,
    /// Archive format.
    pub archive: ArchiveKind,
    /// Post-extraction layout adjustments.
    #[serde(default)]
    pub layout: Layout,
    /// Logical name to relative executable path, e.g. `php` → `php.exe`.
    #[serde(default)]
    pub binaries: BTreeMap<String, String>,
    /// Caveat shown in the UI before installing.
    ///
    /// Used where the artifact is not an official upstream build, which the user
    /// deserves to know before it runs on their machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caveat: Option<String>,
}

/// What the UI needs to know about a component.
///
/// Deliberately separate from [`Component`]: the frontend has no business
/// knowing asset patterns, repository names or pinned URLs, and keeping the
/// catalog schema out of the IPC contract means `#[serde(default)]` on the
/// on-disk format does not leak into the generated TypeScript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct ComponentSummary {
    /// Stable identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Grouping for the UI.
    pub kind: ComponentKind,
    /// One-line description.
    pub summary: String,
    /// Project homepage.
    pub homepage: String,
    /// Licence identifier.
    pub license: String,
    /// Whether several versions may coexist.
    pub multi_version: bool,
    /// Caveat to show before installing, when there is one.
    pub caveat: Option<String>,
    /// Whether versions come from a fixed list rather than a live upstream.
    ///
    /// Pinned components cannot offer versions newer than the DevX catalog, so
    /// the UI can explain why the list looks short.
    pub pinned: bool,
}

impl From<&Component> for ComponentSummary {
    fn from(component: &Component) -> Self {
        Self {
            id: component.id.clone(),
            name: component.name.clone(),
            kind: component.kind,
            summary: component.summary.clone(),
            homepage: component.homepage.clone(),
            license: component.license.clone(),
            multi_version: component.multi_version,
            caveat: component.caveat.clone(),
            pinned: matches!(component.source, Source::Pinned { .. }),
        }
    }
}

/// A set of installable components.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    /// Schema version of this document.
    pub schema_version: u32,
    /// Date the catalog was last edited, `YYYY-MM-DD`.
    pub updated_at: String,
    /// Components, in display order.
    pub components: Vec<Component>,
}

impl Catalog {
    /// Parses the catalog embedded in this build.
    ///
    /// # Panics
    ///
    /// Never at runtime: a malformed embedded catalog fails the
    /// `embedded_catalog_is_valid` test instead.
    pub fn embedded() -> Result<Self> {
        Self::from_json(EMBEDDED_CATALOG)
    }

    /// Parses and validates a catalog document.
    pub fn from_json(json: &str) -> Result<Self> {
        let catalog: Self = serde_json::from_str(json)
            .map_err(|err| Error::config(format!("catalog is not valid JSON: {err}")))?;

        catalog.validate()?;
        Ok(catalog)
    }

    /// Checks invariants the schema alone cannot express.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CATALOG_SCHEMA_VERSION {
            return Err(Error::config(format!(
                "catalog schema version {} is not supported (expected {CATALOG_SCHEMA_VERSION})",
                self.schema_version
            ))
            .with_hint("update DevX to use this catalog"));
        }

        if self.components.is_empty() {
            return Err(Error::config("catalog lists no components"));
        }

        let mut seen = BTreeMap::new();
        for component in &self.components {
            if component.id.is_empty() {
                return Err(Error::config(
                    "catalog contains a component with an empty id",
                ));
            }

            if seen.insert(component.id.clone(), ()).is_some() {
                return Err(Error::config(format!(
                    "catalog defines component `{}` more than once",
                    component.id
                )));
            }

            component.validate()?;
        }

        Ok(())
    }

    /// Looks up a component by identifier.
    pub fn component(&self, id: &str) -> Result<&Component> {
        self.components
            .iter()
            .find(|component| component.id == id)
            .ok_or_else(|| Error::not_found(format!("unknown component `{id}`")))
    }
}

impl Component {
    /// Checks that the source configuration is usable.
    pub fn validate(&self) -> Result<()> {
        match &self.source {
            Source::GitHubReleases {
                repo,
                asset_pattern,
                checksum_asset_pattern,
                ..
            } => {
                if repo.split('/').count() != 2 {
                    return Err(Error::config(format!(
                        "component `{}` has repo `{repo}`, expected `owner/name`",
                        self.id
                    )));
                }
                for (label, pattern) in [
                    ("asset pattern", Some(asset_pattern)),
                    ("checksum asset pattern", checksum_asset_pattern.as_ref()),
                ] {
                    if let Some(pattern) = pattern {
                        regex::Regex::new(pattern).map_err(|err| {
                            Error::config(format!(
                                "component `{}` has an invalid {label}: {err}",
                                self.id
                            ))
                        })?;
                    }
                }
            }
            Source::Pinned { versions } => {
                if versions.is_empty() {
                    return Err(Error::config(format!(
                        "component `{}` is pinned but lists no versions",
                        self.id
                    )));
                }
                for version in versions {
                    if !is_sha256_hex(&version.sha256) {
                        return Err(Error::config(format!(
                            "component `{}` version `{}` has an invalid sha256",
                            self.id, version.version
                        )));
                    }
                    if !version.url.starts_with("https://") {
                        return Err(Error::config(format!(
                            "component `{}` version `{}` must be downloaded over https",
                            self.id, version.version
                        )));
                    }
                }
            }
            Source::NodeDist { asset } => {
                if asset.is_empty() {
                    return Err(Error::config(format!(
                        "component `{}` has an empty node asset id",
                        self.id
                    )));
                }
            }
            Source::PhpNet { .. } => {}
        }

        if matches!(self.archive, ArchiveKind::Executable) && self.layout.executable_name.is_none()
        {
            return Err(Error::config(format!(
                "component `{}` downloads a bare executable but has no layout.executable_name",
                self.id
            )));
        }

        Ok(())
    }
}

/// Whether `value` is a 64-character lowercase hex digest.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn embedded_catalog_is_valid() {
        let catalog = Catalog::embedded().expect("the embedded catalog must parse and validate");

        assert_eq!(catalog.schema_version, CATALOG_SCHEMA_VERSION);
        assert!(
            catalog.components.len() >= 10,
            "expected the full v1 component set, found {}",
            catalog.components.len()
        );
    }

    #[test]
    fn embedded_catalog_covers_every_planned_component() {
        let catalog = Catalog::embedded().expect("parse");

        // MySQL is deliberately absent: see `mysql_is_intentionally_absent`.
        for id in [
            "php",
            "node",
            "nginx",
            "caddy",
            "mariadb",
            "postgresql",
            "redis",
            "mailpit",
            "minio",
            "meilisearch",
            "composer",
            "cloudflared",
        ] {
            catalog
                .component(id)
                .unwrap_or_else(|err| panic!("catalog is missing `{id}`: {err}"));
        }
    }

    #[test]
    fn mysql_is_intentionally_absent() {
        // Oracle publishes no SHA-256 for the MySQL Windows ZIP (only MD5, on an
        // HTML page that blocks direct fetches), so DevX cannot verify the
        // download. Shipping it anyway would mean either trusting an unverified
        // 300 MB binary or weakening the integrity rule for one component.
        // MariaDB speaks the same wire protocol and is offered instead.
        let catalog = Catalog::embedded().expect("parse");

        assert!(
            catalog.component("mysql").is_err(),
            "MySQL must stay out of the catalog until its integrity story is resolved"
        );
        assert!(
            catalog.component("mariadb").is_ok(),
            "the MySQL-compatible alternative must be present"
        );
    }

    #[test]
    fn strip_prefix_defaults_to_auto_and_round_trips() {
        assert_eq!(StripPrefix::default(), StripPrefix::Auto);

        for (json, expected) in [
            ("\"auto\"", StripPrefix::Auto),
            ("\"none\"", StripPrefix::None),
            ("{\"components\":2}", StripPrefix::Components(2)),
        ] {
            let parsed: StripPrefix = serde_json::from_str(json).expect("parse strip prefix");
            assert_eq!(parsed, expected, "for {json}");
            let encoded = serde_json::to_string(&parsed).expect("encode");
            assert_eq!(encoded, json);
        }
    }

    #[test]
    fn php_extracts_at_the_root_while_node_strips_its_wrapper() {
        let catalog = Catalog::embedded().expect("parse");

        // The PHP zip puts php.exe at the root, so stripping would break it.
        assert_eq!(
            catalog.component("php").expect("php").layout.strip_prefix,
            StripPrefix::None
        );
        // Node wraps everything in node-vX-win-x64/, detected automatically.
        assert_eq!(
            catalog.component("node").expect("node").layout.strip_prefix,
            StripPrefix::Auto
        );
    }

    #[test]
    fn every_pinned_artifact_uses_a_verified_hash() {
        let catalog = Catalog::embedded().expect("parse");

        for component in &catalog.components {
            if let Source::Pinned { versions } = &component.source {
                for version in versions {
                    assert!(
                        is_sha256_hex(&version.sha256),
                        "{} {} has an unusable hash",
                        component.id,
                        version.version
                    );
                }
            }
        }
    }

    #[test]
    fn unofficial_builds_carry_a_caveat() {
        let catalog = Catalog::embedded().expect("parse");
        let redis = catalog.component("redis").expect("redis");

        assert!(
            redis.caveat.is_some(),
            "Redis has no official Windows build, so the user must be told"
        );
    }

    #[test]
    fn unknown_component_is_a_not_found_error() {
        let catalog = Catalog::embedded().expect("parse");

        let err = catalog.component("cobol").expect_err("must not exist");
        assert_eq!(err.code, devx_core::ErrorCode::NotFound);
    }

    #[test]
    fn duplicate_component_ids_are_rejected() {
        let json = r#"{
            "schema_version": 1,
            "updated_at": "2026-09-11",
            "components": [
                {"id":"php","name":"PHP","kind":"runtime","summary":"s","homepage":"https://php.net","license":"PHP-3.01","source":{"type":"php_net","thread_safe":false,"arch":"x64"},"archive":"zip"},
                {"id":"php","name":"PHP again","kind":"runtime","summary":"s","homepage":"https://php.net","license":"PHP-3.01","source":{"type":"php_net","thread_safe":false,"arch":"x64"},"archive":"zip"}
            ]
        }"#;

        let err = Catalog::from_json(json).expect_err("duplicates must be rejected");
        assert!(err.message.contains("more than once"), "{}", err.message);
    }

    #[test]
    fn unsupported_schema_version_is_rejected() {
        let json = r#"{"schema_version": 99, "updated_at": "2026-09-11", "components": []}"#;

        let err = Catalog::from_json(json).expect_err("must be rejected");
        assert!(err.message.contains("schema version"), "{}", err.message);
    }

    #[test]
    fn pinned_versions_require_a_valid_hash_and_https() {
        let bad_hash = r#"{
            "schema_version": 1,
            "updated_at": "2026-09-11",
            "components": [
                {"id":"pg","name":"PG","kind":"database","summary":"s","homepage":"https://p.org","license":"PostgreSQL","archive":"zip",
                 "source":{"type":"pinned","versions":[{"version":"1.0","url":"https://x/y.zip","sha256":"nope"}]}}
            ]
        }"#;
        let err = Catalog::from_json(bad_hash).expect_err("short hash must be rejected");
        assert!(err.message.contains("invalid sha256"), "{}", err.message);

        let insecure = bad_hash.replace(
            "\"sha256\":\"nope\"",
            &format!("\"sha256\":\"{}\"", "a".repeat(64)),
        );
        let insecure = insecure.replace("https://x/y.zip", "http://x/y.zip");
        let err = Catalog::from_json(&insecure).expect_err("http must be rejected");
        assert!(err.message.contains("https"), "{}", err.message);
    }

    #[test]
    fn invalid_asset_pattern_is_rejected() {
        let json = r#"{
            "schema_version": 1,
            "updated_at": "2026-09-11",
            "components": [
                {"id":"x","name":"X","kind":"tool","summary":"s","homepage":"https://x","license":"MIT","archive":"zip",
                 "source":{"type":"github_releases","repo":"o/n","asset_pattern":"[unclosed"}}
            ]
        }"#;

        let err = Catalog::from_json(json).expect_err("bad regex must be rejected");
        assert!(err.message.contains("asset pattern"), "{}", err.message);
    }

    #[test]
    fn malformed_repo_is_rejected() {
        let json = r#"{
            "schema_version": 1,
            "updated_at": "2026-09-11",
            "components": [
                {"id":"x","name":"X","kind":"tool","summary":"s","homepage":"https://x","license":"MIT","archive":"zip",
                 "source":{"type":"github_releases","repo":"just-a-name","asset_pattern":".*"}}
            ]
        }"#;

        let err = Catalog::from_json(json).expect_err("must be rejected");
        assert!(err.message.contains("owner/name"), "{}", err.message);
    }

    #[test]
    fn bare_executable_requires_a_file_name() {
        let json = r#"{
            "schema_version": 1,
            "updated_at": "2026-09-11",
            "components": [
                {"id":"x","name":"X","kind":"tool","summary":"s","homepage":"https://x","license":"MIT","archive":"executable",
                 "source":{"type":"pinned","versions":[{"version":"1","url":"https://x/y.exe","sha256":"REPLACE"}]}}
            ]
        }"#
        .replace("REPLACE", &"b".repeat(64));

        let err = Catalog::from_json(&json).expect_err("must be rejected");
        assert!(err.message.contains("executable_name"), "{}", err.message);
    }

    #[test]
    fn sha256_hex_validation() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(is_sha256_hex(
            "cdbb85b45f38f282f05764ca08648b5f92db99c75b2fb3848eb4a559f6553b48"
        ));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&"A".repeat(64)), "uppercase is rejected");
        assert!(!is_sha256_hex("zz"));
    }
}
