//! Supervises a real Mailpit binary end to end.
//!
//! Ignored by default (downloads Mailpit and binds ports). Run it to prove the
//! supervisor drives a real service:
//!
//! ```powershell
//! cargo test -p devx-proc --test live_mailpit -- --ignored --nocapture
//! ```

#![cfg(windows)]

use std::time::Duration;

use devx_core::AppPaths;
use devx_proc::{HealthCheck, ProcessSpec, ServiceState, Supervisor};
use devx_provision::{Catalog, HttpClient, Installer, Resolver};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads Mailpit and binds a port"]
async fn supervises_a_real_mailpit() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    // Install the real Mailpit.
    let catalog = Catalog::embedded().expect("catalog");
    let mailpit = catalog.component("mailpit").expect("mailpit");
    let http = HttpClient::new(paths.cache_dir().join("http")).expect("http");
    let listing = Resolver::new(http.clone())
        .list_versions(mailpit)
        .await
        .expect("resolve");
    let latest = &listing.versions[0];

    let installer = Installer::new(paths.clone(), http).expect("installer");
    let install_dir = installer
        .install(latest, &mailpit.layout, |_| {})
        .await
        .expect("install mailpit");

    // Supervise it on an unusual port to avoid colliding with anything local.
    let mut spec = ProcessSpec::new("mailpit", install_dir.join("mailpit.exe"), paths.logs_dir());
    spec.args = vec![
        "--smtp".into(),
        "127.0.0.1:11025".into(),
        "--listen".into(),
        "127.0.0.1:18025".into(),
    ];
    spec.health = HealthCheck::TcpPort(18025);
    spec.health_timeout = Duration::from_secs(20);

    let sup = Supervisor::new(spec);
    sup.start().await.expect("mailpit should reach Running");
    assert_eq!(sup.state(), ServiceState::Running);

    // The HTTP UI must answer now that we are Running.
    let body = reqwest::get("http://127.0.0.1:18025/livez")
        .await
        .expect("request mailpit");
    assert!(body.status().is_success(), "mailpit health endpoint failed");

    // Some output should have been captured.
    assert!(!sup.logs().is_empty(), "expected captured Mailpit output");

    sup.stop().await;
    assert_eq!(sup.state(), ServiceState::Stopped);

    // After stopping, the port must be free again.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", 18025u16))
            .await
            .is_err(),
        "port should be released after stop"
    );
}
