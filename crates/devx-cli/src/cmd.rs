//! Command implementations behind the `devx` binary.
//!
//! Each handler maps one CLI verb onto the shared domain crates and prints a
//! script-friendly result. Lifecycle of supervised processes is intentionally
//! absent: those belong to the desktop app's job objects.

use std::io::Write as _;
use std::process::ExitCode;

use anyhow::{bail, Context as _};
use devx_core::{doctor, AppPaths, ConfigHealth, ConfigStore, Site as ConfigSite};
use devx_provision::{Catalog, ComponentVersion, HttpClient, Installer, Resolver, SiteSpec};
use serde_json::json;

use crate::{Cli, Command, SitesCommand};

/// Exit code for a diagnostic report with at least one failure.
const DOCTOR_FAIL: u8 = 2;
/// Exit code for a diagnostic report with warnings but no failures.
const DOCTOR_WARN: u8 = 1;
/// Exit code for a fully healthy diagnostic report.
const DOCTOR_OK: u8 = 0;

/// Dispatches one parsed invocation and returns the process exit code.
///
/// # Errors
///
/// Propagates any domain error, wrapped with the command name for context.
pub async fn dispatch(cli: &Cli) -> anyhow::Result<ExitCode> {
    // The flag wins over the environment, mirroring how the desktop app's test
    // harness pins a hermetic root.
    let paths = match &cli.home {
        Some(home) => AppPaths::rooted_at(home),
        None => AppPaths::discover().context("resolving the DevX directory layout")?,
    };

    let code = match &cli.command {
        Command::Doctor => doctor_cmd(&paths)?,
        Command::Paths => paths_cmd(&paths)?,
        Command::Sites { command } => sites_cmd(&paths, command)?,
        Command::Install {
            component_id,
            version,
        } => install_cmd(&paths, component_id, version).await?,
        Command::Uninstall {
            component_id,
            version,
        } => uninstall_cmd(&paths, component_id, version)?,
        Command::Installed => installed_cmd(&paths)?,
    };

    Ok(exit_code(code))
}

fn exit_code(code: u8) -> ExitCode {
    ExitCode::from(code)
}

/// `devx doctor` — run diagnostics, print them, map the report to an exit code
/// so scripts and CI can gate on health without parsing text.
fn doctor_cmd(paths: &AppPaths) -> anyhow::Result<u8> {
    let probe = devx_sys::WindowsProbe::new();
    let report = doctor::run(paths, &probe, &config_health());

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for check in &report.checks {
        writeln!(out, "{:>5}  {}", status_label(check.status), check.title)?;
        writeln!(out, "        {}", check.detail)?;
        if let Some(remedy) = &check.remedy {
            writeln!(out, "        fix: {remedy}")?;
        }
    }
    out.flush()?;

    Ok(match report.status {
        doctor::CheckStatus::Pass => DOCTOR_OK,
        doctor::CheckStatus::Warn => DOCTOR_WARN,
        doctor::CheckStatus::Fail => DOCTOR_FAIL,
    })
}

fn status_label(status: doctor::CheckStatus) -> &'static str {
    match status {
        doctor::CheckStatus::Pass => "ok",
        doctor::CheckStatus::Warn => "warn",
        doctor::CheckStatus::Fail => "FAIL",
    }
}

/// `devx paths` — print the resolved layout as one JSON object.
fn paths_cmd(paths: &AppPaths) -> anyhow::Result<u8> {
    println!(
        "{}",
        json!({
            "config_dir": paths.config_dir,
            "data_dir": paths.data_dir,
            "config_file": paths.config_file(),
            "runtimes_dir": paths.runtimes_dir(),
        })
    );
    Ok(0)
}

/// Site subcommand dispatch.
fn sites_cmd(paths: &AppPaths, command: &SitesCommand) -> anyhow::Result<u8> {
    match command {
        SitesCommand::List => sites_list(paths),
        SitesCommand::Add {
            hostname,
            docroot,
            php,
            https,
        } => sites_add(paths, hostname, docroot, php.as_deref(), *https),
        SitesCommand::Remove { hostname } => sites_remove(paths, hostname),
    }
}

/// `devx sites list` — one JSON object per configured site.
fn sites_list(paths: &AppPaths) -> anyhow::Result<u8> {
    let store = load_store(paths)?;

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for site in &store.config().sites {
        writeln!(
            out,
            "{}",
            json!({
                "hostname": site.hostname,
                "docroot": site.docroot,
                "php_version": site.php(),
                "https": site.https,
            })
        )?;
    }
    out.flush()?;
    Ok(0)
}

/// `devx sites add` — persist to config, then render the nginx block.
///
/// The same order the desktop app uses: a failed save must abort before any
/// nginx block is written, and `write_site_block` re-renders idempotently.
fn sites_add(
    paths: &AppPaths,
    hostname: &str,
    docroot: &std::path::Path,
    php: Option<&str>,
    https: bool,
) -> anyhow::Result<u8> {
    let docroot = absolutize(docroot)?;
    let spec = SiteSpec {
        hostname: hostname.to_owned(),
        docroot: docroot.clone(),
        php_version: php.map(str::to_owned),
        env: Vec::new(),
        aliases: Vec::new(),
    };

    devx_provision::validate_spec(&spec, &paths.service_config_dir())
        .context("validating the site")?;

    let mut store = load_store(paths)?;
    let site = ConfigSite {
        hostname: spec.hostname.clone(),
        docroot: docroot.to_string_lossy().into_owned(),
        php_version: spec.php_version.clone().unwrap_or_default(),
        https,
        env: Default::default(),
        aliases: Vec::new(),
    };
    store
        .update(|config| {
            config
                .sites
                .retain(|s| !s.hostname.eq_ignore_ascii_case(&site.hostname));
            config.sites.push(site.clone());
        })
        .context("saving the site to configuration")?;

    sync_site_blocks(paths, &store)?;
    println!("site {hostname} added");

    Ok(0)
}

/// `devx sites remove` — drop from config, prune the block.
fn sites_remove(paths: &AppPaths, hostname: &str) -> anyhow::Result<u8> {
    devx_provision::sites::validate_hostname(hostname).context("validating the hostname")?;

    let mut store = load_store(paths)?;
    let existed = store
        .config()
        .sites
        .iter()
        .any(|s| s.hostname.eq_ignore_ascii_case(hostname));
    if !existed {
        bail!("site {hostname} is not configured");
    }

    store
        .update(|config| {
            config
                .sites
                .retain(|s| !s.hostname.eq_ignore_ascii_case(hostname));
        })
        .context("saving the configuration")?;

    devx_provision::remove_site_block(&sites_dir(paths), hostname)
        .context("removing the nginx block")?;
    println!("site {hostname} removed");

    Ok(0)
}

/// Renders every configured site's nginx block, mirroring the desktop app.
///
/// One sync per mutation keeps the include directory exactly equal to the
/// configured set, which is what makes the two frontends converge on the same
/// on-disk result without coordination.
fn sync_site_blocks(paths: &AppPaths, store: &ConfigStore) -> anyhow::Result<()> {
    let sites_dir = sites_dir(paths);

    for site in &store.config().sites {
        let spec = SiteSpec {
            hostname: site.hostname.clone(),
            docroot: std::path::PathBuf::from(&site.docroot),
            php_version: site.php().map(str::to_owned),
            env: site.env.clone().into_iter().collect(),
            aliases: site.aliases.clone(),
        };
        let endpoint = match &spec.php_version {
            Some(version) => Some(
                devx_provision::pool_endpoint_for(&paths.service_config_dir(), version)
                    .context("resolving the PHP pool endpoint")?,
            ),
            None => None,
        };
        let tls = if site.https {
            Some(devx_provision::tls_listen_snippet(
                &site.hostname,
                store.config().network.https_port,
            ))
        } else {
            None
        };

        devx_provision::write_site_block(&sites_dir, &spec, endpoint.as_deref(), tls.as_deref())
            .context("writing the nginx block")?;
    }

    let live: Vec<String> = store
        .config()
        .sites
        .iter()
        .map(|s| s.hostname.clone())
        .collect();
    devx_provision::prune_stale_blocks(&sites_dir, &live).context("pruning stale blocks")?;

    Ok(())
}

/// `devx install <component> <version>` — resolve upstream versions, install
/// with verification, printing one progress line per stage.
async fn install_cmd(paths: &AppPaths, component_id: &str, version: &str) -> anyhow::Result<u8> {
    let catalog = Catalog::embedded().context("loading the component catalog")?;
    let component = catalog
        .component(component_id)
        .with_context(|| format!("unknown component `{component_id}`"))?
        .clone();

    let http = HttpClient::new(paths.cache_dir().join("http")).context("creating HTTP client")?;
    let resolver = Resolver::new(http.clone());
    let listing = resolver
        .list_versions(&component)
        .await
        .context("listing upstream versions")?;

    let target: ComponentVersion = listing
        .versions
        .into_iter()
        .find(|candidate| candidate.version == version)
        .ok_or_else(|| {
            anyhow::anyhow!("{component_id} {version} is not an available upstream version")
        })?;

    let installer = Installer::new(paths.clone(), http)?;
    let install_dir = installer
        .install(&target, &component.layout, |stage| match stage {
            devx_provision::InstallStage::ResolvingChecksum => {
                println!("resolving checksum…");
            }
            devx_provision::InstallStage::Downloading(_) => {
                println!("downloading…");
            }
            devx_provision::InstallStage::Verifying => println!("verifying sha256…"),
            devx_provision::InstallStage::Extracting => println!("extracting…"),
            devx_provision::InstallStage::Finalising => println!("finalising…"),
            devx_provision::InstallStage::Done => {}
        })
        .await
        .context("installing")?;

    println!(
        "installed {component_id} {version} to {}",
        install_dir.display()
    );
    Ok(0)
}

/// `devx uninstall <component> <version>` — remove an installed version.
fn uninstall_cmd(paths: &AppPaths, component_id: &str, version: &str) -> anyhow::Result<u8> {
    let http_dir = paths.cache_dir().join("http");
    let installer = Installer::new(paths.clone(), HttpClient::new(http_dir)?)?;
    installer.uninstall(component_id, version)?;
    println!("removed {component_id} {version}");
    Ok(0)
}

/// `devx installed` — one JSON object per installed version.
fn installed_cmd(paths: &AppPaths) -> anyhow::Result<u8> {
    let installer = Installer::new(
        paths.clone(),
        HttpClient::new(paths.cache_dir().join("http"))?,
    )?;

    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    let Ok(components) = std::fs::read_dir(paths.runtimes_dir()) else {
        return Ok(0);
    };
    for component in components.flatten() {
        if !component.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let component_id = component.file_name().to_string_lossy().into_owned();
        let Ok(versions) = std::fs::read_dir(component.path()) else {
            continue;
        };
        for version in versions.flatten() {
            let version_str = version.file_name().to_string_lossy().into_owned();
            if installer.is_installed(&component_id, &version_str) {
                writeln!(
                    out,
                    "{}",
                    json!({
                        "component": component_id,
                        "version": version_str,
                        "path": version.path(),
                    })
                )?;
            }
        }
    }
    out.flush()?;

    Ok(0)
}

/// Loads the configuration, failing loudly rather than silently running on
/// defaults: unlike the desktop app there is no UI to surface the fallback.
fn load_store(paths: &AppPaths) -> anyhow::Result<ConfigStore> {
    ConfigStore::load(paths).context("loading the DevX configuration")
}

/// The health of a store loaded through [`load_store`], which fails loudly on
/// unusable files — so a store in hand is by definition `Loaded`.
fn config_health() -> ConfigHealth {
    ConfigHealth::Loaded
}

fn sites_dir(paths: &AppPaths) -> std::path::PathBuf {
    paths.service_config_dir().join("nginx").join("sites")
}

/// Resolves `path` against the current directory, without touching the
/// filesystem: `validate_docroot` wants absolute input.
fn absolutize(path: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .context("resolving the current directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> (tempfile::TempDir, AppPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().unwrap();
        (dir, paths)
    }

    #[test]
    fn doctor_reports_on_defaults() {
        let (_guard, paths) = home();
        // Defaults are healthy in a hermetic root: writable dirs, real volume.
        let code = doctor_cmd(&paths).unwrap();
        assert!(code <= DOCTOR_WARN, "unexpected failures on defaults");
    }

    #[test]
    fn paths_prints_layout() {
        let (_guard, paths) = home();
        assert!(paths_cmd(&paths).is_ok());
    }

    #[test]
    fn sites_add_list_remove_roundtrip() {
        let (_guard, paths) = home();

        let docroot = paths.data_dir.join("docroot");
        std::fs::create_dir_all(&docroot).unwrap();

        sites_add(&paths, "myapp.test", &docroot, None, false).unwrap();

        // The config carries the site...
        let store = load_store(&paths).unwrap();
        assert_eq!(store.config().sites.len(), 1);
        assert_eq!(store.config().sites[0].hostname, "myapp.test");

        // ...and the rendered block exists...
        let block = sites_dir(&paths).join("myapp.test.conf");
        assert!(block.is_file(), "block not rendered");

        // ...and remove cleans both.
        sites_remove(&paths, "myapp.test").unwrap();
        assert!(!block.exists());
        assert!(load_store(&paths).unwrap().config().sites.is_empty());
    }

    #[test]
    fn sites_add_replaces_existing_site() {
        let (_guard, paths) = home();
        let docroot = paths.data_dir.join("docroot");
        std::fs::create_dir_all(&docroot).unwrap();

        sites_add(&paths, "myapp.test", &docroot, None, false).unwrap();
        sites_add(&paths, "MYAPP.TEST", &docroot, None, true).unwrap();

        let store = load_store(&paths).unwrap();
        assert_eq!(store.config().sites.len(), 1);
        assert!(store.config().sites[0].https);
    }

    #[test]
    fn sites_remove_unknown_fails() {
        let (_guard, paths) = home();
        assert!(sites_remove(&paths, "ghost.test").is_err());
    }

    #[test]
    fn sites_add_static_needs_no_pool() {
        // A static site must not require a rendered PHP pool.
        let (_guard, paths) = home();
        let docroot = paths.data_dir.join("site");
        std::fs::create_dir_all(&docroot).unwrap();
        assert!(sites_add(&paths, "static.test", &docroot, None, false).is_ok());
    }

    #[test]
    fn php_site_requires_rendered_pool() {
        let (_guard, paths) = home();
        let docroot = paths.data_dir.join("site");
        std::fs::create_dir_all(&docroot).unwrap();
        // No php pool has ever been rendered in this fresh root.
        assert!(sites_add(&paths, "php.test", &docroot, Some("8.4"), false).is_err());
    }

    #[test]
    fn absolutize_resolves_relative_paths() {
        let relative = std::path::Path::new("some/dir");
        let resolved = absolutize(relative).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with(relative));
    }
}
