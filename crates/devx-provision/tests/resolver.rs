//! Resolver behaviour against recorded upstream responses.
//!
//! The fixtures in `tests/fixtures` are trimmed copies of real responses from
//! `windows.php.net`, `nodejs.org` and the GitHub API. Trimmed, not synthesised:
//! they keep the quirks that matter, such as PHP's compiler tag changing between
//! branches (`nts-vc15-x64` on 7.4, `nts-vs17-x64` on 8.4) and Node's `lts`
//! field being either `false` or a codename.

use std::collections::BTreeMap;
use std::time::Duration;

use devx_core::ErrorCode;
use devx_provision::catalog::{Arch, ArchiveKind, Component, ComponentKind, Layout, Source};
use devx_provision::resolver::Endpoints;
use devx_provision::version::{Checksum, ReleaseChannel};
use devx_provision::{HttpClient, Resolver};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const PHP_RELEASES: &str = include_str!("fixtures/php-releases.json");
const NODE_INDEX: &str = include_str!("fixtures/node-index.json");
const GITHUB_REDIS: &str = include_str!("fixtures/github-redis-releases.json");

/// Builds a resolver whose upstreams all point at `server`.
fn resolver_for(server: &MockServer, cache: &tempfile::TempDir) -> Resolver {
    let http = HttpClient::new(cache.path()).expect("http client");

    Resolver::new(http)
        .with_endpoints(Endpoints {
            php_releases_url: format!("{}/downloads/releases/releases.json", server.uri()),
            node_index_url: format!("{}/dist/index.json", server.uri()),
            node_dist_base_url: format!("{}/dist", server.uri()),
            github_api_base_url: server.uri(),
        })
        // Tests must not depend on the developer's ambient token.
        .with_github_token(None)
}

fn component(id: &str, source: Source, archive: ArchiveKind) -> Component {
    Component {
        id: id.to_owned(),
        name: id.to_owned(),
        kind: ComponentKind::Runtime,
        summary: "test component".to_owned(),
        homepage: "https://example.com".to_owned(),
        license: "MIT".to_owned(),
        multi_version: true,
        source,
        archive,
        layout: Layout::default(),
        binaries: BTreeMap::new(),
        caveat: None,
    }
}

fn php_component() -> Component {
    component(
        "php",
        Source::PhpNet {
            thread_safe: false,
            arch: Arch::X64,
        },
        ArchiveKind::Zip,
    )
}

fn node_component() -> Component {
    component(
        "node",
        Source::NodeDist {
            asset: "win-x64-zip".to_owned(),
        },
        ArchiveKind::Zip,
    )
}

fn redis_component() -> Component {
    component(
        "redis",
        Source::GitHubReleases {
            repo: "redis-windows/redis-windows".to_owned(),
            asset_pattern: r"^Redis-[0-9.]+-Windows-x64-cygwin\.zip$".to_owned(),
            checksum_asset_pattern: None,
            include_prereleases: false,
        },
        ArchiveKind::Zip,
    )
}

// --- windows.php.net -------------------------------------------------------

#[tokio::test]
async fn php_versions_are_resolved_with_hashes_across_compiler_tags() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    let listing = resolver_for(&server, &cache)
        .list_versions(&php_component())
        .await
        .expect("resolve php versions");

    let versions: Vec<&str> = listing
        .versions
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(
        versions,
        ["8.4.25", "7.4.33"],
        "both branches resolve despite different compiler tags, newest first"
    );

    let latest = &listing.versions[0];
    assert!(
        latest.artifact.file_name.contains("nts"),
        "DevX runs PHP as FastCGI workers and must pick the non-thread-safe build: {}",
        latest.artifact.file_name
    );
    assert!(latest.artifact.file_name.contains("x64"));
    assert_eq!(
        latest.artifact.url,
        format!(
            "{}/downloads/releases/{}",
            server.uri(),
            latest.artifact.file_name
        )
    );
    assert!(matches!(
        &latest.artifact.checksum,
        Checksum::Sha256 { hex } if hex.len() == 64
    ));
    // Taken from the `mtime` of the recorded fixture.
    assert_eq!(latest.released_at.as_deref(), Some("2026-08-25"));
    assert!(listing.unverifiable.is_empty());
    assert!(!listing.stale);
}

#[tokio::test]
async fn php_thread_safe_build_is_selected_when_requested() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    let mut component = php_component();
    component.source = Source::PhpNet {
        thread_safe: true,
        arch: Arch::X64,
    };

    let listing = resolver_for(&server, &cache)
        .list_versions(&component)
        .await
        .expect("resolve php versions");

    for version in &listing.versions {
        assert!(
            !version.artifact.file_name.contains("nts"),
            "expected a thread-safe build, got {}",
            version.artifact.file_name
        );
    }
}

#[tokio::test]
async fn php_architecture_without_builds_is_reported_as_not_found() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    let mut component = php_component();
    component.source = Source::PhpNet {
        thread_safe: false,
        // windows.php.net publishes no ARM64 builds.
        arch: Arch::Arm64,
    };

    let err = resolver_for(&server, &cache)
        .list_versions(&component)
        .await
        .expect_err("no arm64 builds exist");

    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.hint.is_some(), "the user needs a next step");
}

#[tokio::test]
async fn malformed_upstream_json_is_a_network_error_with_a_hint() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>maintenance</html>"))
        .mount(&server)
        .await;

    let err = resolver_for(&server, &cache)
        .list_versions(&php_component())
        .await
        .expect_err("html is not a manifest");

    assert_eq!(err.code, ErrorCode::Network);
    assert!(
        err.message.contains("could not be parsed"),
        "{}",
        err.message
    );
}

// --- nodejs.org ------------------------------------------------------------

#[tokio::test]
async fn node_versions_carry_lts_channels_and_deferred_checksums() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/dist/index.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(NODE_INDEX))
        .mount(&server)
        .await;

    let listing = resolver_for(&server, &cache)
        .list_versions(&node_component())
        .await
        .expect("resolve node versions");

    let latest = &listing.versions[0];
    assert_eq!(latest.version, "26.5.0");
    assert_eq!(latest.channel, ReleaseChannel::Stable);
    assert_eq!(
        latest.artifact.url,
        format!("{}/dist/v26.5.0/node-v26.5.0-win-x64.zip", server.uri())
    );

    // Hashes live in a per-release sums file, resolved at download time.
    match &latest.artifact.checksum {
        Checksum::Sha256File { url, file_name } => {
            assert_eq!(
                url,
                &format!("{}/dist/v26.5.0/SHASUMS256.txt", server.uri())
            );
            assert_eq!(file_name, "node-v26.5.0-win-x64.zip");
        }
        other => panic!("expected a deferred checksum, got {other:?}"),
    }

    let lts: Vec<&str> = listing
        .versions
        .iter()
        .filter(|v| v.channel == ReleaseChannel::Lts)
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(
        lts,
        ["24.12.0", "22.22.0"],
        "codenamed releases are LTS, `false` ones are not"
    );

    // Ancient releases published no Windows zip and must not be offered.
    assert!(
        !listing.versions.iter().any(|v| v.version == "0.10.48"),
        "versions without a win-x64-zip asset must be filtered out"
    );
}

// --- GitHub releases -------------------------------------------------------

#[tokio::test]
async fn github_releases_resolve_from_asset_digests() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .and(query_param("per_page", "100"))
        .and(header("accept", "application/vnd.github+json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(GITHUB_REDIS))
        .mount(&server)
        .await;

    let listing = resolver_for(&server, &cache)
        .list_versions(&redis_component())
        .await
        .expect("resolve redis versions");

    let versions: Vec<&str> = listing
        .versions
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(versions, ["8.10.1", "8.8.2", "8.6.6", "8.4.6"]);

    let latest = &listing.versions[0];
    assert_eq!(
        latest.artifact.file_name,
        "Redis-8.10.1-Windows-x64-cygwin.zip"
    );
    assert!(latest.artifact.size_bytes.is_some_and(|size| size > 0));
    assert!(matches!(&latest.artifact.checksum, Checksum::Sha256 { .. }));
    assert_eq!(latest.released_at.as_deref(), Some("2026-08-18"));
}

#[tokio::test]
async fn github_releases_without_a_matching_asset_are_not_offered() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_string(GITHUB_REDIS))
        .mount(&server)
        .await;

    let mut component = redis_component();
    component.source = Source::GitHubReleases {
        repo: "redis-windows/redis-windows".to_owned(),
        asset_pattern: r"^does-not-exist\.zip$".to_owned(),
        checksum_asset_pattern: None,
        include_prereleases: false,
    };

    let err = resolver_for(&server, &cache)
        .list_versions(&component)
        .await
        .expect_err("nothing matches the pattern");

    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn releases_without_a_published_checksum_are_withheld_not_offered_unverified() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    // A release whose asset has no digest and no sums file: DevX must refuse to
    // offer it rather than downloading something it cannot verify.
    let body = r#"[
        {"tag_name":"9.0.0","draft":false,"prerelease":false,"published_at":"2026-01-02T03:04:05Z",
         "assets":[{"name":"Redis-9.0.0-Windows-x64-cygwin.zip","browser_download_url":"https://example.com/r.zip","size":10,"digest":null}]},
        {"tag_name":"8.10.1","draft":false,"prerelease":false,"published_at":"2026-08-18T02:20:25Z",
         "assets":[{"name":"Redis-8.10.1-Windows-x64-cygwin.zip","browser_download_url":"https://example.com/r2.zip","size":20,
                    "digest":"sha256:e70eea271f2b8d4bc113fe4a95331beaa2cd4b22c4ed07c93c54e342cb1788db"}]}
    ]"#;

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let listing = resolver_for(&server, &cache)
        .list_versions(&redis_component())
        .await
        .expect("the verifiable release still resolves");

    let versions: Vec<&str> = listing
        .versions
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(versions, ["8.10.1"]);
    assert_eq!(listing.unverifiable, ["9.0.0"]);
}

#[tokio::test]
async fn github_checksum_asset_is_used_when_the_api_reports_no_digest() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    let body = r#"[
        {"tag_name":"v2.11.4","draft":false,"prerelease":false,"published_at":"2026-05-01T00:00:00Z",
         "assets":[
            {"name":"caddy_2.11.4_windows_amd64.zip","browser_download_url":"https://example.com/caddy.zip","size":17559418,"digest":null},
            {"name":"caddy_2.11.4_checksums.txt","browser_download_url":"https://example.com/sums.txt","size":6769,"digest":null}
         ]}
    ]"#;

    Mock::given(method("GET"))
        .and(path("/repos/caddyserver/caddy/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let mut component = redis_component();
    component.id = "caddy".to_owned();
    component.source = Source::GitHubReleases {
        repo: "caddyserver/caddy".to_owned(),
        asset_pattern: r"^caddy_[0-9.]+_windows_amd64\.zip$".to_owned(),
        checksum_asset_pattern: Some(r"^caddy_[0-9.]+_checksums\.txt$".to_owned()),
        include_prereleases: false,
    };

    let listing = resolver_for(&server, &cache)
        .list_versions(&component)
        .await
        .expect("resolve caddy");

    assert_eq!(listing.versions.len(), 1);
    match &listing.versions[0].artifact.checksum {
        Checksum::Sha256File { url, file_name } => {
            assert_eq!(url, "https://example.com/sums.txt");
            assert_eq!(file_name, "caddy_2.11.4_windows_amd64.zip");
        }
        other => panic!("expected the sums file to be used, got {other:?}"),
    }
}

#[tokio::test]
async fn drafts_and_prereleases_are_excluded_by_default() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    let digest = "sha256:e70eea271f2b8d4bc113fe4a95331beaa2cd4b22c4ed07c93c54e342cb1788db";
    let body = format!(
        r#"[
        {{"tag_name":"9.0.0-rc1","draft":false,"prerelease":true,"assets":[{{"name":"Redis-9.0.0-Windows-x64-cygwin.zip","browser_download_url":"https://e/1.zip","size":1,"digest":"{digest}"}}]}},
        {{"tag_name":"9.1.0","draft":true,"prerelease":false,"assets":[{{"name":"Redis-9.1.0-Windows-x64-cygwin.zip","browser_download_url":"https://e/2.zip","size":1,"digest":"{digest}"}}]}},
        {{"tag_name":"8.10.1","draft":false,"prerelease":false,"assets":[{{"name":"Redis-8.10.1-Windows-x64-cygwin.zip","browser_download_url":"https://e/3.zip","size":1,"digest":"{digest}"}}]}}
    ]"#
    );

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let listing = resolver_for(&server, &cache)
        .list_versions(&redis_component())
        .await
        .expect("resolve");

    let versions: Vec<&str> = listing
        .versions
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(versions, ["8.10.1"]);
}

#[tokio::test]
async fn prereleases_are_included_when_the_catalog_opts_in() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    let digest = "sha256:e70eea271f2b8d4bc113fe4a95331beaa2cd4b22c4ed07c93c54e342cb1788db";
    let body = format!(
        r#"[
        {{"tag_name":"9.0.0","draft":false,"prerelease":true,"assets":[{{"name":"Redis-9.0.0-Windows-x64-cygwin.zip","browser_download_url":"https://e/1.zip","size":1,"digest":"{digest}"}}]}}
    ]"#
    );

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let mut component = redis_component();
    component.source = Source::GitHubReleases {
        repo: "redis-windows/redis-windows".to_owned(),
        asset_pattern: r"^Redis-[0-9.]+-Windows-x64-cygwin\.zip$".to_owned(),
        checksum_asset_pattern: None,
        include_prereleases: true,
    };

    let listing = resolver_for(&server, &cache)
        .list_versions(&component)
        .await
        .expect("resolve");

    assert_eq!(listing.versions.len(), 1);
    assert_eq!(listing.versions[0].channel, ReleaseChannel::Prerelease);
}

#[tokio::test]
async fn rate_limited_api_without_a_cache_explains_how_to_fix_it() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/repos/redis-windows/redis-windows/releases"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .set_body_string(r#"{"message":"API rate limit exceeded"}"#),
        )
        .mount(&server)
        .await;

    let err = resolver_for(&server, &cache)
        .list_versions(&redis_component())
        .await
        .expect_err("rate limiting must surface");

    assert_eq!(err.code, ErrorCode::Network);
    assert!(
        err.hint
            .as_deref()
            .is_some_and(|hint| hint.contains("GITHUB_TOKEN")),
        "hint should mention raising the limit: {:?}",
        err.hint
    );
}

// --- pinned ----------------------------------------------------------------

#[tokio::test]
async fn pinned_versions_need_no_network_access() {
    let cache = tempfile::tempdir().expect("cache dir");
    let http = HttpClient::new(cache.path()).expect("http client");
    let catalog = devx_provision::Catalog::embedded().expect("embedded catalog");
    let nginx = catalog.component("nginx").expect("nginx");

    // No mock server at all: a pinned source that touched the network would fail.
    let listing = Resolver::new(http)
        .list_versions(nginx)
        .await
        .expect("resolve pinned versions");

    let versions: Vec<&str> = listing
        .versions
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(versions, ["1.31.5", "1.30.1"]);
    assert_eq!(
        listing.versions[0].artifact.file_name, "nginx-1.31.5.zip",
        "the file name comes from the pinned URL"
    );
    assert!(matches!(
        &listing.versions[0].artifact.checksum,
        Checksum::Sha256 { hex } if hex.len() == 64
    ));
}

// --- caching ---------------------------------------------------------------

#[tokio::test]
async fn repeated_lookups_inside_the_ttl_hit_the_network_once() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"v1\"")
                .set_body_string(PHP_RELEASES),
        )
        .expect(1)
        .mount(&server)
        .await;

    let resolver = resolver_for(&server, &cache);
    let component = php_component();

    resolver.list_versions(&component).await.expect("first");
    resolver.list_versions(&component).await.expect("second");
    resolver.list_versions(&component).await.expect("third");

    // `expect(1)` is asserted when the server drops.
}

#[tokio::test]
async fn expired_cache_is_revalidated_with_a_conditional_request() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(|request: &Request| {
            // The second call must carry the ETag and can then be answered
            // without a body.
            if request
                .headers
                .get("if-none-match")
                .is_some_and(|value| value.to_str().unwrap_or_default() == "\"v1\"")
            {
                ResponseTemplate::new(304)
            } else {
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"v1\"")
                    .set_body_string(PHP_RELEASES)
            }
        })
        .expect(2)
        .mount(&server)
        .await;

    let http = HttpClient::new(cache.path())
        .expect("http client")
        .with_ttl(Duration::ZERO);
    let resolver = Resolver::new(http)
        .with_endpoints(Endpoints {
            php_releases_url: format!("{}/downloads/releases/releases.json", server.uri()),
            ..Endpoints::default()
        })
        .with_github_token(None);

    let first = resolver
        .list_versions(&php_component())
        .await
        .expect("first");
    let second = resolver
        .list_versions(&php_component())
        .await
        .expect("second");

    assert_eq!(first.versions, second.versions);
    assert!(!second.stale, "a 304 means the cache is still valid");
}

/// Builds a resolver against `server` with an always-expired cache.
fn always_revalidating_resolver(
    server: &MockServer,
    cache: &tempfile::TempDir,
    timeout: Duration,
) -> Resolver {
    let http = HttpClient::new(cache.path())
        .expect("http client")
        .with_ttl(Duration::ZERO)
        .with_timeout(timeout);

    Resolver::new(http)
        .with_endpoints(Endpoints {
            php_releases_url: format!("{}/downloads/releases/releases.json", server.uri()),
            ..Endpoints::default()
        })
        .with_github_token(None)
}

#[tokio::test]
async fn upstream_server_error_serves_the_cache_and_marks_it_stale() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    let populated = always_revalidating_resolver(&server, &cache, Duration::from_secs(10))
        .list_versions(&php_component())
        .await
        .expect("populate the cache");
    assert!(!populated.stale);

    // The upstream now fails. Version lists must degrade, not disappear.
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let listing = always_revalidating_resolver(&server, &cache, Duration::from_secs(10))
        .list_versions(&php_component())
        .await
        .expect("a failing upstream must still return cached versions");

    assert!(
        listing.stale,
        "data that could not be revalidated must be flagged stale"
    );
    assert_eq!(listing.versions, populated.versions);
}

#[tokio::test]
async fn a_hanging_upstream_times_out_and_falls_back_to_the_cache() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    always_revalidating_resolver(&server, &cache, Duration::from_secs(10))
        .list_versions(&php_component())
        .await
        .expect("populate the cache");

    // Now the upstream stops answering in time.
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(30))
                .set_body_string(PHP_RELEASES),
        )
        .mount(&server)
        .await;

    let listing = always_revalidating_resolver(&server, &cache, Duration::from_millis(150))
        .list_versions(&php_component())
        .await
        .expect("a timeout must not empty the version list");

    assert!(listing.stale);
    assert!(!listing.versions.is_empty());
}

#[tokio::test]
async fn a_failing_upstream_without_any_cache_reports_the_failure() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let err = always_revalidating_resolver(&server, &cache, Duration::from_secs(5))
        .list_versions(&php_component())
        .await
        .expect_err("with nothing cached there is nothing to show");

    assert_eq!(err.code, ErrorCode::Network);
    assert!(
        err.hint.is_some(),
        "the user needs to know it is a network problem"
    );
}

#[tokio::test]
async fn missing_upstream_document_is_a_not_found_error() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let err = resolver_for(&server, &cache)
        .list_versions(&php_component())
        .await
        .expect_err("404 must not be silently ignored");

    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn corrupt_cache_entries_are_discarded_and_refetched() {
    let server = MockServer::start().await;
    let cache = tempfile::tempdir().expect("cache dir");

    Mock::given(method("GET"))
        .and(path("/downloads/releases/releases.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PHP_RELEASES))
        .mount(&server)
        .await;

    // Simulate a truncated write from an earlier crash.
    std::fs::create_dir_all(cache.path()).expect("cache dir");
    for index in 0..3 {
        std::fs::write(
            cache.path().join(format!("garbage{index}.json")),
            b"{not json",
        )
        .expect("seed garbage");
    }

    let listing = resolver_for(&server, &cache)
        .list_versions(&php_component())
        .await
        .expect("a corrupt cache must not break resolution");

    assert!(!listing.versions.is_empty());
}
