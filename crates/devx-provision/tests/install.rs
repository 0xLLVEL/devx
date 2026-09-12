//! End-to-end install pipeline: download, verify, extract, promote.
//!
//! Artifacts are served by an in-process `wiremock` server, so these tests
//! exercise the real download/verify/extract code without touching the network.

use std::io::Write;
use std::time::Duration;

use devx_core::{AppPaths, ErrorCode};
use devx_provision::catalog::{ArchiveKind, Layout, StripPrefix};
use devx_provision::download::DownloadOptions;
use devx_provision::version::{Artifact, Checksum, ComponentVersion, ReleaseChannel};
use devx_provision::{HttpClient, InstallStage, Installer};
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// Builds a small zip wrapping its entries in one versioned directory.
fn wrapped_zip() -> Vec<u8> {
    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in [
            ("php-8.4.25/php.exe", &b"MZ-php"[..]),
            ("php-8.4.25/php.ini", &b"[PHP]"[..]),
            ("php-8.4.25/ext/php_redis.dll", &b"dll"[..]),
        ] {
            writer.start_file(name, options).expect("start");
            writer.write_all(body).expect("write");
        }
        writer.finish().expect("finish");
    }
    buffer
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        })
}

fn installer(paths: &AppPaths) -> Installer {
    paths.ensure_dirs().expect("dirs");
    let http = HttpClient::new(paths.cache_dir().join("http")).expect("http");
    Installer::new(paths.clone(), http)
        .expect("installer")
        .with_download_options(DownloadOptions {
            max_attempts: 3,
            backoff_base: Duration::from_millis(10),
            connect_timeout: Duration::from_secs(5),
            read_timeout: Duration::from_secs(10),
        })
        .expect("options")
}

fn version(server_uri: &str, hash: &str) -> ComponentVersion {
    ComponentVersion {
        component_id: "php".to_owned(),
        version: "8.4.25".to_owned(),
        channel: ReleaseChannel::Stable,
        released_at: None,
        artifact: Artifact {
            url: format!("{server_uri}/php.zip"),
            file_name: "php.zip".to_owned(),
            size_bytes: None,
            archive: ArchiveKind::Zip,
            checksum: Checksum::Sha256 {
                hex: hash.to_owned(),
            },
        },
    }
}

#[tokio::test]
async fn installs_verifies_and_normalises_layout() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);

    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(&server)
        .await;

    let mut stages = Vec::new();
    let install_dir = installer
        .install(
            &version(&server.uri(), &hash),
            &Layout::default(),
            |stage| stages.push(stage),
        )
        .await
        .expect("install succeeds");

    // The wrapper directory was stripped by the default `Auto` layout.
    assert_eq!(
        std::fs::read(install_dir.join("php.exe")).expect("php.exe"),
        b"MZ-php"
    );
    assert!(install_dir.join("ext").join("php_redis.dll").is_file());
    assert!(installer.is_installed("php", "8.4.25"));

    assert!(stages.contains(&InstallStage::Verifying));
    assert!(stages.contains(&InstallStage::Extracting));
    assert!(stages.last() == Some(&InstallStage::Done));

    // The archive is removed by default.
    let leftover: Vec<_> = std::fs::read_dir(paths.downloads_dir())
        .expect("downloads dir")
        .filter_map(|e| e.ok())
        .collect();
    assert!(leftover.is_empty(), "archive should be cleaned up");
}

#[tokio::test]
async fn a_checksum_mismatch_aborts_and_leaves_nothing_behind() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(wrapped_zip()))
        .mount(&server)
        .await;

    // Advertise the wrong hash.
    let wrong = "a".repeat(64);
    let err = installer
        .install(&version(&server.uri(), &wrong), &Layout::default(), |_| {})
        .await
        .expect_err("mismatch must fail");

    assert_eq!(err.code, ErrorCode::Integrity);
    assert!(!installer.is_installed("php", "8.4.25"));
    assert!(
        !installer.install_dir("php", "8.4.25").exists(),
        "no install directory may remain"
    );

    // Neither the archive nor any staging directory may survive.
    let downloads: Vec<_> = std::fs::read_dir(paths.downloads_dir())
        .expect("downloads")
        .filter_map(|e| e.ok())
        .collect();
    assert!(downloads.is_empty(), "partial download must be cleaned up");
    let staging: Vec<_> = std::fs::read_dir(paths.staging_dir())
        .expect("staging")
        .filter_map(|e| e.ok())
        .collect();
    assert!(staging.is_empty(), "staging must be cleaned up");
}

#[tokio::test]
async fn a_malicious_archive_is_refused_during_extraction() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    // A zip whose entry escapes the destination.
    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer.start_file("../escape.txt", options).expect("start");
        writer.write_all(b"pwned").expect("write");
        writer.finish().expect("finish");
    }
    let hash = sha256_hex(&buffer);

    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(buffer))
        .mount(&server)
        .await;

    let err = installer
        .install(&version(&server.uri(), &hash), &Layout::default(), |_| {})
        .await
        .expect_err("zip slip must be refused");

    assert_eq!(err.code, ErrorCode::Integrity);
    assert!(!installer.is_installed("php", "8.4.25"));
    assert!(!dir.path().join("escape.txt").exists());
}

#[tokio::test]
async fn an_already_installed_version_is_a_no_op() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);

    // Only allow a single fetch; a second install must not download again.
    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .expect(1)
        .mount(&server)
        .await;

    let component = version(&server.uri(), &hash);
    installer
        .install(&component, &Layout::default(), |_| {})
        .await
        .expect("first install");

    let mut stages = Vec::new();
    installer
        .install(&component, &Layout::default(), |stage| stages.push(stage))
        .await
        .expect("second install is a no-op");

    assert_eq!(stages, vec![InstallStage::Done]);
}

#[tokio::test]
async fn a_bare_executable_is_installed_under_its_configured_name() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let body = b"MZ-minio-binary";
    let hash = sha256_hex(body);

    Mock::given(method("GET"))
        .and(path("/minio"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
        .mount(&server)
        .await;

    let component = ComponentVersion {
        component_id: "minio".to_owned(),
        version: "RELEASE.2025-09-07T16-13-09Z".to_owned(),
        channel: ReleaseChannel::Stable,
        released_at: None,
        artifact: Artifact {
            url: format!("{}/minio", server.uri()),
            file_name: "minio".to_owned(),
            size_bytes: None,
            archive: ArchiveKind::Executable,
            checksum: Checksum::Sha256 { hex: hash },
        },
    };
    let layout = Layout {
        strip_prefix: StripPrefix::None,
        executable_name: Some("minio.exe".to_owned()),
    };

    let install_dir = installer
        .install(&component, &layout, |_| {})
        .await
        .expect("install");

    assert_eq!(
        std::fs::read(install_dir.join("minio.exe")).expect("minio.exe"),
        body
    );
}

#[tokio::test]
async fn checksum_is_resolved_from_a_sums_document() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);

    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/SHASUMS256.txt"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(format!("{hash}  php.zip\ndeadbeef  other.zip\n")),
        )
        .mount(&server)
        .await;

    let mut component = version(&server.uri(), &hash);
    component.artifact.checksum = Checksum::Sha256File {
        url: format!("{}/SHASUMS256.txt", server.uri()),
        file_name: "php.zip".to_owned(),
    };

    let mut stages = Vec::new();
    installer
        .install(&component, &Layout::default(), |stage| stages.push(stage))
        .await
        .expect("install with resolved checksum");

    assert!(stages.contains(&InstallStage::ResolvingChecksum));
    assert!(installer.is_installed("php", "8.4.25"));
}

#[tokio::test]
async fn an_interrupted_download_resumes_from_the_partial_file() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);
    let split = zip.len() / 2;

    // Pre-seed a partial download, as if an earlier run was interrupted after
    // `split` bytes. The installer must resume it with a Range request rather
    // than starting over, so the server only ever serves the suffix.
    // Matches the naming scheme in `Installer::install`.
    let partial = paths.downloads_dir().join("php-8.4.25-php.zip.partial");
    std::fs::create_dir_all(paths.downloads_dir()).expect("downloads dir");
    std::fs::write(&partial, &zip[..split]).expect("seed partial");

    let full = zip.clone();
    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(move |request: &Request| {
            let range = request
                .headers
                .get("range")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("bytes="))
                .and_then(|value| value.trim_end_matches('-').parse::<usize>().ok());

            match range {
                Some(from) if from == split => ResponseTemplate::new(206)
                    .insert_header(
                        "content-range",
                        format!("bytes {from}-{}/{}", full.len() - 1, full.len()),
                    )
                    .set_body_bytes(full[from..].to_vec()),
                // Resuming from the wrong offset, or not at all, is a test
                // failure: respond 500 so the assertion below catches it.
                _ => ResponseTemplate::new(500),
            }
        })
        .mount(&server)
        .await;

    installer
        .install(&version(&server.uri(), &hash), &Layout::default(), |_| {})
        .await
        .expect("resume must complete the download from the partial file");

    assert!(installer.is_installed("php", "8.4.25"));
}

#[tokio::test]
async fn uninstall_removes_an_installed_version() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);
    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(&server)
        .await;

    installer
        .install(&version(&server.uri(), &hash), &Layout::default(), |_| {})
        .await
        .expect("install");
    assert!(installer.is_installed("php", "8.4.25"));

    installer.uninstall("php", "8.4.25").expect("uninstall");
    assert!(!installer.is_installed("php", "8.4.25"));
    assert!(!installer.install_dir("php", "8.4.25").exists());
}

#[tokio::test]
async fn keep_archives_retains_the_download() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    let installer = installer(&paths).keep_archives(true);

    let zip = wrapped_zip();
    let hash = sha256_hex(&zip);
    Mock::given(method("GET"))
        .and(path("/php.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(&server)
        .await;

    installer
        .install(&version(&server.uri(), &hash), &Layout::default(), |_| {})
        .await
        .expect("install");

    let archives: Vec<_> = std::fs::read_dir(paths.downloads_dir())
        .expect("downloads")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(archives.len(), 1, "the archive should be retained");
}
