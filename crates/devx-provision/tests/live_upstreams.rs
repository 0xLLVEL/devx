//! Version resolution against the real upstreams.
//!
//! Ignored by default: these tests need internet access and would make CI fail
//! whenever an upstream has a bad day. Run them deliberately after editing the
//! catalog or a resolver:
//!
//! ```powershell
//! cargo test -p devx-provision --test live_upstreams -- --ignored --nocapture
//! ```
//!
//! They are the check that the catalog still matches reality: asset patterns
//! still match, hashes are still published, and every component can offer at
//! least one verifiable version.

use devx_provision::catalog::Source;
use devx_provision::version::Checksum;
use devx_provision::{Catalog, HttpClient, Resolver};

/// Resolver using a throwaway cache so runs are independent.
fn live_resolver(cache: &tempfile::TempDir) -> Resolver {
    Resolver::new(HttpClient::new(cache.path()).expect("http client"))
}

#[tokio::test]
#[ignore = "requires internet access"]
async fn every_catalog_component_resolves_at_least_one_verifiable_version() {
    let cache = tempfile::tempdir().expect("cache dir");
    let resolver = live_resolver(&cache);
    let catalog = Catalog::embedded().expect("embedded catalog");

    let mut failures = Vec::new();

    for component in &catalog.components {
        match resolver.list_versions(component).await {
            Ok(listing) => {
                let latest = &listing.versions[0];
                println!(
                    "{:<12} {:<32} {} versions, latest {} ({})",
                    component.id,
                    latest.version,
                    listing.versions.len(),
                    latest.artifact.file_name,
                    match &latest.artifact.checksum {
                        Checksum::Sha256 { .. } => "inline sha256",
                        Checksum::Sha256File { .. } => "sums file",
                    }
                );

                if !listing.unverifiable.is_empty() {
                    println!(
                        "             withheld (no checksum): {}",
                        listing.unverifiable.join(", ")
                    );
                }
            }
            Err(err) => {
                failures.push(format!("{}: {err}", component.id));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "components failed to resolve:\n  {}",
        failures.join("\n  ")
    );
}

#[tokio::test]
#[ignore = "requires internet access"]
async fn pinned_artifact_urls_are_still_downloadable() {
    let catalog = Catalog::embedded().expect("embedded catalog");
    let client = reqwest::Client::builder()
        .user_agent("DevX catalog check")
        .build()
        .expect("client");

    let mut failures = Vec::new();

    for component in &catalog.components {
        let Source::Pinned { versions } = &component.source else {
            continue;
        };

        for version in versions {
            // A HEAD request is enough: this checks the pin has not rotted, not
            // that the bytes still hash correctly (which download-time
            // verification covers).
            match client.head(&version.url).send().await {
                Ok(response) if response.status().is_success() => {
                    println!(
                        "{:<12} {:<32} {}",
                        component.id,
                        version.version,
                        response.status()
                    );
                }
                Ok(response) => failures.push(format!(
                    "{} {}: {} for {}",
                    component.id,
                    version.version,
                    response.status(),
                    version.url
                )),
                Err(err) => failures.push(format!(
                    "{} {}: {err} for {}",
                    component.id, version.version, version.url
                )),
            }
        }
    }

    assert!(
        failures.is_empty(),
        "pinned artifacts are no longer reachable:\n  {}",
        failures.join("\n  ")
    );
}

#[tokio::test]
#[ignore = "requires internet access"]
async fn php_offers_every_supported_branch_with_hashes() {
    let cache = tempfile::tempdir().expect("cache dir");
    let catalog = Catalog::embedded().expect("embedded catalog");
    let php = catalog.component("php").expect("php");

    let listing = live_resolver(&cache)
        .list_versions(php)
        .await
        .expect("resolve php");

    for version in &listing.versions {
        assert!(
            matches!(&version.artifact.checksum, Checksum::Sha256 { hex } if hex.len() == 64),
            "{} has no inline hash",
            version.version
        );
        assert!(
            version.artifact.file_name.contains("nts")
                && version.artifact.file_name.contains("x64"),
            "unexpected artifact {}",
            version.artifact.file_name
        );
    }

    // windows.php.net keeps several branches published at once.
    assert!(
        listing.versions.len() >= 4,
        "expected several PHP branches, got {:?}",
        listing
            .versions
            .iter()
            .map(|v| &v.version)
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
#[ignore = "requires internet access"]
async fn node_lts_releases_are_identified() {
    let cache = tempfile::tempdir().expect("cache dir");
    let catalog = Catalog::embedded().expect("embedded catalog");
    let node = catalog.component("node").expect("node");

    let listing = live_resolver(&cache)
        .list_versions(node)
        .await
        .expect("resolve node");

    let lts_count = listing
        .versions
        .iter()
        .filter(|v| v.channel == devx_provision::ReleaseChannel::Lts)
        .count();

    assert!(lts_count > 0, "no LTS releases were identified");
    println!(
        "node: {} versions, {} marked LTS, latest {}",
        listing.versions.len(),
        lts_count,
        listing.versions[0].version
    );
}
