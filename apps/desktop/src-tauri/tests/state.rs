//! Startup behaviour of the desktop shell's shared state.
//!
//! In an integration test target so `build.rs` can attach the Windows
//! Common-Controls manifest; see `windows-test-manifest.xml`.

use devx_core::{AppPaths, Config, ConfigHealth, ConfigStore, DnsMode};
use devx_desktop::state::load_config_or_defaults;

#[test]
fn valid_configuration_is_loaded_and_marked_healthy() {
    let dir = tempfile::tempdir().expect("temp dir");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("create dirs");

    std::fs::write(
        paths.config_file(),
        "schema_version = 1\n\n[network]\nhttp_port = 8080\n",
    )
    .expect("seed config");

    let (store, health) = load_config_or_defaults(&paths);

    assert_eq!(health, ConfigHealth::Loaded);
    assert_eq!(store.config().network.http_port, 8080);
}

#[test]
fn invalid_configuration_falls_back_to_defaults_without_touching_the_file() {
    let dir = tempfile::tempdir().expect("temp dir");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("create dirs");

    let broken = "schema_version = 1\n\n[network]\ndomain_suffix = \".test\"\n";
    std::fs::write(paths.config_file(), broken).expect("seed config");

    let (store, health) = load_config_or_defaults(&paths);

    // DevX keeps running on defaults rather than refusing to start.
    assert_eq!(store.config(), &Config::default());
    assert_eq!(store.config().network.dns_mode, DnsMode::Auto);

    // The broken file is preserved so the user can see what they wrote.
    assert_eq!(
        std::fs::read_to_string(paths.config_file()).expect("read"),
        broken,
        "the invalid file must not be overwritten at startup"
    );

    match health {
        ConfigHealth::Invalid { message, hint } => {
            assert!(
                message.contains("single label"),
                "unexpected message: {message}"
            );
            assert!(hint.is_some(), "the user needs to know how to fix it");
        }
        ConfigHealth::Loaded => panic!("a dotted suffix must not be reported as healthy"),
    }
}

#[test]
fn missing_configuration_is_created_from_defaults() {
    let dir = tempfile::tempdir().expect("temp dir");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("create dirs");

    let (store, health) = load_config_or_defaults(&paths);

    assert_eq!(health, ConfigHealth::Loaded);
    assert!(paths.config_file().is_file(), "a default file is written");
    assert_eq!(store.config(), &Config::default());
}

#[test]
fn saving_over_a_broken_file_recovers_it() {
    let dir = tempfile::tempdir().expect("temp dir");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("create dirs");
    std::fs::write(paths.config_file(), "schema_version = 99999\n").expect("seed config");

    let (mut store, health) = load_config_or_defaults(&paths);
    assert!(matches!(health, ConfigHealth::Invalid { .. }));

    store
        .update(|config| config.network.http_port = 8081)
        .expect("saving must repair the file");

    let reloaded = ConfigStore::load(&paths).expect("the repaired file must load");
    assert_eq!(reloaded.config().network.http_port, 8081);
}
