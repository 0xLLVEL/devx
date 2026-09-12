//! End-to-end install against real upstreams.
//!
//! Ignored by default (downloads real, multi-megabyte artifacts). Run it to
//! prove the whole pipeline works against production servers:
//!
//! ```powershell
//! cargo test -p devx-provision --test live_install -- --ignored --nocapture
//! ```

use std::process::Command;

use devx_core::AppPaths;
use devx_provision::{Catalog, HttpClient, Installer, Resolver};

/// Installs the latest PHP and runs `php -v` from the installed tree.
#[tokio::test]
#[ignore = "downloads a real artifact"]
async fn installs_real_php_and_runs_it() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    let catalog = Catalog::embedded().expect("catalog");
    let php = catalog.component("php").expect("php");

    let http = HttpClient::new(paths.cache_dir().join("http")).expect("http");
    let listing = Resolver::new(http.clone())
        .list_versions(php)
        .await
        .expect("resolve php versions");
    let latest = &listing.versions[0];
    println!("installing PHP {}", latest.version);

    let installer = Installer::new(paths.clone(), http).expect("installer");
    let install_dir = installer
        .install(latest, &php.layout, |stage| {
            println!("  {stage:?}");
        })
        .await
        .expect("install PHP");

    // The catalog maps `php` to `php.exe` at the root of the extracted tree.
    let php_exe = install_dir.join("php.exe");
    assert!(
        php_exe.is_file(),
        "php.exe missing at {}",
        php_exe.display()
    );

    let output = Command::new(&php_exe)
        .arg("-v")
        .output()
        .expect("run php -v");
    let stdout = String::from_utf8_lossy(&output.stdout);
    println!("php -v:\n{stdout}");

    assert!(output.status.success(), "php -v exited with failure");
    assert!(
        stdout.contains(&latest.version),
        "php -v output should mention {}, got: {stdout}",
        latest.version
    );

    assert!(installer.is_installed("php", &latest.version));
}

/// Installs Node LTS and runs `node -v`.
#[tokio::test]
#[ignore = "downloads a real artifact"]
async fn installs_real_node_lts_and_runs_it() {
    use devx_provision::ReleaseChannel;

    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    let catalog = Catalog::embedded().expect("catalog");
    let node = catalog.component("node").expect("node");

    let http = HttpClient::new(paths.cache_dir().join("http")).expect("http");
    let listing = Resolver::new(http.clone())
        .list_versions(node)
        .await
        .expect("resolve node versions");

    // Prefer an LTS release, matching the recommended default.
    let target = listing
        .versions
        .iter()
        .find(|v| v.channel == ReleaseChannel::Lts)
        .unwrap_or(&listing.versions[0]);
    println!("installing Node {}", target.version);

    let installer = Installer::new(paths, http).expect("installer");
    let install_dir = installer
        .install(target, &node.layout, |stage| println!("  {stage:?}"))
        .await
        .expect("install node");

    // Node's zip wraps everything in node-vX-win-x64/, stripped by Auto layout.
    let node_exe = install_dir.join("node.exe");
    assert!(
        node_exe.is_file(),
        "node.exe missing at {}",
        node_exe.display()
    );

    let output = Command::new(&node_exe)
        .arg("-v")
        .output()
        .expect("run node -v");
    let stdout = String::from_utf8_lossy(&output.stdout);
    println!("node -v: {stdout}");

    assert!(output.status.success());
    assert!(stdout.trim().contains(&target.version));
}
