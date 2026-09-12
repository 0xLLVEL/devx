use std::path::PathBuf;

fn main() {
    embed_manifest_into_test_binaries();
    tauri_build::build();
}

/// Embeds a Windows application manifest into `cargo test` binaries.
///
/// `tauri-build` embeds the real app manifest as a Windows resource, which the
/// test harness binaries do not receive. Without a Common Controls v6
/// dependency they fail to load with STATUS_ENTRYPOINT_NOT_FOUND. Scoping this
/// to `rustc-link-arg-tests` keeps it away from the shipped executable, which
/// already has its own manifest.
fn embed_manifest_into_test_binaries() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("windows-test-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}
