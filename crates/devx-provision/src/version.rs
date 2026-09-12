//! Resolved versions and the artifacts that implement them.

use serde::Serialize;

use crate::catalog::ArchiveKind;

/// Release track a version belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseChannel {
    /// Long-term support release, preferred default where upstream defines one.
    Lts,
    /// Current stable release.
    Stable,
    /// Pre-release, only offered when the catalog opts in.
    Prerelease,
}

/// How the SHA-256 of an artifact is obtained.
///
/// Some upstreams publish the hash in their version index (PHP, GitHub release
/// digests); others publish a separate sums file per release (Node). Deferring
/// the second kind until download time avoids one extra request per version just
/// to populate a list the user may never install from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Checksum {
    /// Known now: lowercase hex SHA-256.
    Sha256 {
        /// Lowercase hex digest.
        hex: String,
    },
    /// Published in a `sha256sum`-style file that lists `<hash>  <file name>`.
    Sha256File {
        /// URL of the sums file.
        url: String,
        /// Entry to look for inside it.
        file_name: String,
    },
}

/// A downloadable artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct Artifact {
    /// Direct download URL.
    pub url: String,
    /// File name to save it as.
    pub file_name: String,
    /// Size in bytes, when the upstream reports it.
    ///
    /// Exported to TypeScript as a plain `number`. Specta forbids `u64` by
    /// default because JSON parsing truncates past 2^53; artifact sizes are
    /// bounded by a few hundred megabytes, so the precision loss cannot occur.
    #[specta(type = Option<specta_typescript::Number>)]
    pub size_bytes: Option<u64>,
    /// Archive format.
    pub archive: ArchiveKind,
    /// How to verify the download.
    pub checksum: Checksum,
}

/// A version of a component that DevX can install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct ComponentVersion {
    /// Component this version belongs to.
    pub component_id: String,
    /// Version string as published upstream, e.g. `8.4.25`.
    pub version: String,
    /// Release track.
    pub channel: ReleaseChannel,
    /// Release date as `YYYY-MM-DD`, when known.
    pub released_at: Option<String>,
    /// The artifact implementing this version.
    pub artifact: Artifact,
}

/// Sorts versions newest first.
///
/// Prefers semantic version ordering and falls back to reverse lexicographic
/// comparison, which is correct for the date-stamped release names some projects
/// use (MinIO's `RELEASE.2025-09-07T16-13-09Z`).
pub fn sort_newest_first(versions: &mut [ComponentVersion]) {
    versions.sort_by(|a, b| {
        match (
            parse_loose_semver(&a.version),
            parse_loose_semver(&b.version),
        ) {
            (Some(left), Some(right)) => right.cmp(&left),
            _ => b.version.cmp(&a.version),
        }
    });
}

/// Parses a version that may omit the patch component, e.g. `1.30`.
fn parse_loose_semver(version: &str) -> Option<semver::Version> {
    let trimmed = version.trim_start_matches('v');

    if let Ok(parsed) = semver::Version::parse(trimmed) {
        return Some(parsed);
    }

    let numeric: Vec<&str> = trimmed.split('.').collect();
    match numeric.as_slice() {
        [major, minor] => semver::Version::parse(&format!("{major}.{minor}.0")).ok(),
        [major] => semver::Version::parse(&format!("{major}.0.0")).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn version(v: &str) -> ComponentVersion {
        ComponentVersion {
            component_id: "test".to_owned(),
            version: v.to_owned(),
            channel: ReleaseChannel::Stable,
            released_at: None,
            artifact: Artifact {
                url: "https://example.com/a.zip".to_owned(),
                file_name: "a.zip".to_owned(),
                size_bytes: None,
                archive: ArchiveKind::Zip,
                checksum: Checksum::Sha256 {
                    hex: "a".repeat(64),
                },
            },
        }
    }

    #[test]
    fn sorts_semver_numerically_not_lexicographically() {
        let mut versions = vec![
            version("8.1.33"),
            version("8.4.25"),
            version("8.10.1"),
            version("8.2.9"),
        ];

        sort_newest_first(&mut versions);

        let order: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        // 8.10.1 must beat 8.4.25, which string comparison would get wrong.
        assert_eq!(order, ["8.10.1", "8.4.25", "8.2.9", "8.1.33"]);
    }

    #[test]
    fn sorts_two_component_versions() {
        let mut versions = vec![version("1.30"), version("1.31"), version("1.9")];

        sort_newest_first(&mut versions);

        let order: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(order, ["1.31", "1.30", "1.9"]);
    }

    #[test]
    fn sorts_date_stamped_release_names_reverse_lexicographically() {
        let mut versions = vec![
            version("RELEASE.2025-09-07T16-13-09Z"),
            version("RELEASE.2025-10-15T17-29-55Z"),
            version("RELEASE.2024-01-01T00-00-00Z"),
        ];

        sort_newest_first(&mut versions);

        let order: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(
            order,
            [
                "RELEASE.2025-10-15T17-29-55Z",
                "RELEASE.2025-09-07T16-13-09Z",
                "RELEASE.2024-01-01T00-00-00Z"
            ]
        );
    }

    #[test]
    fn strips_a_leading_v() {
        assert_eq!(
            parse_loose_semver("v26.5.0"),
            Some(semver::Version::new(26, 5, 0))
        );
    }
}
