//! Site management: local domains backed by project folders.
//!
//! A *site* is the unit users care about: "my app at `myapp.test` runs PHP
//! 8.4 from this folder". This module turns site specs into nginx `server`
//! blocks and keeps the blocks in sync with what the user configured:
//!
//! * one file per site under the nginx `sites` include directory, so a
//!   single directory listing is the source of truth on disk;
//! * every block routes PHP to the FastCGI pool of the site's chosen
//!   version, read from that pool's rendered `pool.conf`;
//! * a sync removes blocks for sites that no longer exist.
//!
//! Everything is pure computation plus explicit file writes, so the mapping
//! is unit-testable without nginx installed.

use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};
use serde::Serialize;

/// Maximum sites DevX manages; guards against runaway config generation.
pub const MAX_SITES: usize = 256;

/// The hostname a site serves on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SiteHostname(pub String);

/// A user-configured site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SiteSpec {
    /// Host name served, e.g. `myapp.test`. Validated by [`validate_hostname`].
    pub hostname: String,
    /// Absolute path of the project folder nginx serves files from.
    pub docroot: PathBuf,
    /// PHP version whose FastCGI pool serves this site, e.g. `8.4.25`.
    /// `None` for a purely static site.
    pub php_version: Option<String>,
    /// Environment variables exposed to the site's PHP requests, rendered as
    /// `fastcgi_param` lines. Ignored for static sites. Pre-sorted by the
    /// caller so blocks render deterministically.
    pub env: Vec<(String, String)>,
    /// Additional host names the site answers to, appended to `server_name`.
    pub aliases: Vec<String>,
}

/// What sync produced, for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SiteSyncReport {
    /// Blocks (re-)written during the sync.
    pub written: Vec<String>,
    /// Blocks removed because their site no longer exists.
    pub pruned: Vec<String>,
}

/// Validates a site hostname.
///
/// Delegates to the IPC module's rule (single DNS labels and dot-separated
/// FQDNs of letters, digits, hyphens), re-exported here so site code has one
/// obvious place to look.
pub fn validate_hostname(hostname: &str) -> Result<()> {
    devx_ipc::validate_hostname(hostname)
}

/// Validates a docroot.
///
/// Must be absolute and look like a directory path; existence is checked at
/// start time, not validation time, so a site can be created before its
/// folder is cloned.
pub fn validate_docroot(docroot: &Path) -> Result<()> {
    if !docroot.is_absolute() {
        return Err(Error::invalid_input(format!(
            "docroot `{}` must be an absolute path",
            docroot.display()
        ))
        .with_hint("use a full path such as `C:\\projects\\myapp\\public`"));
    }
    Ok(())
}

/// The `fastcgi_pass` endpoint a site should use for `php_version`.
///
/// Reads the pool's rendered `pool.conf` — the single source of truth for
/// pool ports — so site blocks never hardcode ports.
///
/// # Errors
///
/// Fails when the pool has never been started (no `pool.conf`) or its conf
/// is missing a `listen` line; the site cannot route to PHP it cannot find.
pub fn pool_endpoint_for(config_root: &Path, php_version: &str) -> Result<String> {
    let pool_dir = config_root.join(devx_provision_php_pool_id(php_version));
    devx_provision_pool_listen(&pool_dir)
}

/// Validates a full site spec, checking PHP routing reachability too.
pub fn validate_spec(spec: &SiteSpec, config_root: &Path) -> Result<()> {
    validate_hostname(&spec.hostname)?;
    validate_docroot(&spec.docroot)?;

    if let Some(version) = &spec.php_version {
        // Parse the version lightly: a pool id component must be filename-safe.
        if version.is_empty()
            || version
                .chars()
                .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(Error::invalid_input(format!(
                "`{version}` is not a usable PHP version id"
            )));
        }
        pool_endpoint_for(config_root, version)?;
    }

    Ok(())
}

/// Renders one nginx `server` block for `spec`.
///
/// Static sites get a plain `location /`; PHP sites additionally route
/// `\.php$` to the version's FastCGI pool with the standard WordPress-and-
/// friends `PATH_INFO` fallback so front controllers work out of the box.
/// `tls` (from `pki::tls_listen_snippet`) adds the HTTPS `listen` and ssl
/// directives after the plain HTTP ones, so a site can serve both.
pub fn render_server_block(
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    tls: Option<&str>,
) -> String {
    let docroot = slash(&spec.docroot);

    let env_lines = render_env_params(&spec.env);

    let php_location = match php_endpoint {
        Some(endpoint) => format!(
            r#"    location ~ \.php$ {{
        fastcgi_pass   {endpoint};
        fastcgi_index  index.php;
        include        fastcgi_params;{env_lines}
        fastcgi_param  SCRIPT_FILENAME  $document_root$fastcgi_script_name;
        fastcgi_param  PATH_INFO        $fastcgi_path_info;
    }}

"#
        ),
        None => String::new(),
    };

    let index = if spec.php_version.is_some() {
        "index.html index.htm index.php"
    } else {
        "index.html index.htm"
    };

    format!(
        r#"# devx-managed site: {hostname}
server {{
    listen       80;
    server_name  {hostname};
{tls}    root   {docroot};
    index  {index};

    access_log  logs/{hostname}.access.log;
    error_log   logs/{hostname}.error.log;

{php_location}    location / {{
        try_files $uri $uri/ /index.php?$query_string;
    }}
}}
"#,
        hostname = spec_hostname(spec),
        docroot = docroot,
        index = index,
        php_location = php_location,
        tls = tls.unwrap_or_default(),
    )
}

/// The full `server_name` value: the primary host name plus its aliases.
fn spec_hostname(spec: &SiteSpec) -> String {
    let mut names = vec![spec.hostname.clone()];
    names.extend(spec.aliases.iter().cloned());
    names.join(" ")
}

/// Renders the site's environment variables as `fastcgi_param` lines.
///
/// Each line is prefixed with a newline-and-indent so the empty case leaves
/// the block layout untouched. Key shapes and value metacharacters are
/// rejected at config-validation time (`devx_core::config`), so the values
/// here are always safe to quote verbatim.
fn render_env_params(env: &[(String, String)]) -> String {
    let mut lines = String::new();
    for (key, value) in env {
        lines.push_str("\n        fastcgi_param  ");
        lines.push_str(key);
        lines.push_str("  \"");
        lines.push_str(value);
        lines.push_str("\";");
    }
    lines
}

/// The file name of one site's block under the include directory.
fn block_file_name(hostname: &str) -> String {
    format!("{}.conf", hostname.to_ascii_lowercase())
}

/// Writes (or replaces) the server block for `spec` and reports the outcome.
///
/// `tls` carries the pre-rendered TLS directives (`pki::tls_listen_snippet`)
/// for HTTPS sites; `None` keeps the block HTTP-only.
pub fn write_site_block(
    sites_dir: &Path,
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    tls: Option<&str>,
) -> Result<PathBuf> {
    validate_hostname(&spec.hostname)?;
    validate_docroot(&spec.docroot)?;

    std::fs::create_dir_all(sites_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", sites_dir.display()),
        )
    })?;

    let body = render_server_block(spec, php_endpoint, tls);
    let path = sites_dir.join(block_file_name(&spec.hostname));
    devx_core::fsx::write_atomic(&path, body)?;
    Ok(path)
}

/// Removes the block for `hostname`, if present. Idempotent.
pub fn remove_site_block(sites_dir: &Path, hostname: &str) -> Result<()> {
    validate_hostname(hostname)?;
    let path = sites_dir.join(block_file_name(hostname));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::new(
            ErrorCode::Io,
            format!("failed to remove {}: {err}", path.display()),
        )),
    }
}

/// Removes blocks whose hostname is not in `live_hostnames`.
///
/// Called after every config save so a removed site never leaves a stale
/// server block behind.
pub fn prune_stale_blocks(sites_dir: &Path, live_hostnames: &[String]) -> Result<Vec<String>> {
    let mut pruned = Vec::new();

    let Ok(entries) = std::fs::read_dir(sites_dir) else {
        return Ok(pruned);
    };

    for entry in entries.flatten() {
        if !entry
            .file_type()
            .map(|t| t.is_dir().eq(&false))
            .unwrap_or(false)
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(hostname) = name.strip_suffix(".conf") else {
            continue;
        };
        if !live_hostnames
            .iter()
            .any(|h| h.eq_ignore_ascii_case(hostname))
        {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => pruned.push(hostname.to_owned()),
                Err(err) => tracing::warn!(
                    path = %entry.path().display(),
                    %err,
                    "failed to prune a stale site block"
                ),
            }
        }
    }

    Ok(pruned)
}

/// Renders a path with forward slashes for nginx.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Wrapper so the `php_pool` helpers read cleanly at call sites.
fn devx_provision_php_pool_id(version: &str) -> String {
    crate::pool_id(version)
}

/// Wrapper so the `php_pool` helpers read cleanly at call sites.
fn devx_provision_pool_listen(pool_dir: &Path) -> Result<String> {
    crate::pool_listen_addr(pool_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn spec(hostname: &str, php: Option<&str>) -> SiteSpec {
        SiteSpec {
            hostname: hostname.to_owned(),
            docroot: PathBuf::from("C:/projects/myapp/public"),
            php_version: php.map(str::to_owned),
            env: Vec::new(),
            aliases: Vec::new(),
        }
    }

    #[test]
    fn static_sites_render_without_php_routing() {
        let block = render_server_block(&spec("static.test", None), None, None);

        assert!(block.contains("server_name  static.test;"), "{block}");
        assert!(
            block.contains("root   C:/projects/myapp/public;"),
            "{block}"
        );
        assert!(!block.contains("fastcgi_pass"), "{block}");
        assert!(block.contains("index.html index.htm"), "{block}");
        assert!(!block.contains('\\'), "no backslashes: {block}");
    }

    #[test]
    fn tls_directives_land_in_the_listen_block() {
        let tls = crate::tls_listen_snippet("app.test", 443);
        let block = render_server_block(&spec("app.test", None), None, Some(&tls));

        assert!(block.contains("listen       443 ssl;"), "{block}");
        assert!(block.contains("listen       80;"), "{block}");
        assert!(block.contains("ssl_certificate     certs/sites/app.test/cert.pem;"));
    }

    #[test]
    fn php_sites_route_to_the_pool_endpoint() {
        let block = render_server_block(
            &spec("app.test", Some("8.4.25")),
            Some("127.0.0.1:9100"),
            None,
        );

        assert!(block.contains("fastcgi_pass   127.0.0.1:9100;"), "{block}");
        assert!(block.contains("SCRIPT_FILENAME  $document_root$fastcgi_script_name;"));
        assert!(block.contains("index.php"), "{block}");
        assert!(block.contains("try_files $uri $uri/ /index.php?$query_string;"));
    }

    #[test]
    fn site_env_renders_as_fastcgi_params() {
        let mut site = spec("app.test", Some("8.4.25"));
        site.env = vec![
            ("APP_ENV".to_owned(), "local".to_owned()),
            ("DB_HOST".to_owned(), "127.0.0.1".to_owned()),
        ];

        let block = render_server_block(&site, Some("127.0.0.1:9100"), None);
        assert!(
            block.contains("fastcgi_param  APP_ENV  \"local\";"),
            "{block}"
        );
        assert!(
            block.contains("fastcgi_param  DB_HOST  \"127.0.0.1\";"),
            "{block}"
        );
    }

    #[test]
    fn aliases_extend_the_server_name_list() {
        let mut site = spec("app.test", None);
        site.aliases = vec!["app.dev.test".to_owned(), "legacy.test".to_owned()];

        let block = render_server_block(&site, None, None);
        assert!(
            block.contains("server_name  app.test app.dev.test legacy.test;"),
            "{block}"
        );
    }

    #[test]
    fn static_sites_never_render_env_params() {
        let mut site = spec("static.test", None);
        site.env = vec![("APP_ENV".to_owned(), "local".to_owned())];

        let block = render_server_block(&site, None, None);
        assert!(!block.contains("fastcgi_param  APP_ENV"), "{block}");
    }

    #[test]
    fn hostnames_validate_like_the_ipc_rule() {
        assert!(validate_hostname("app.test").is_ok());
        assert!(validate_hostname("*.evil").is_err());
        assert!(validate_hostname("").is_err());
    }

    #[test]
    fn docroots_must_be_absolute() {
        assert!(validate_docroot(Path::new("C:/proj/app")).is_ok());
        assert!(validate_docroot(Path::new("relative/path")).is_err());
    }

    #[test]
    fn write_and_remove_blocks_round_trip() {
        let dir = tempfile::tempdir().expect("temp");
        let sites = dir.path().join("sites");

        let path = write_site_block(&sites, &spec("app.test", None), None, None).expect("write");
        assert_eq!(path, sites.join("app.test.conf"));
        assert!(path.is_file());

        remove_site_block(&sites, "app.test").expect("remove");
        assert!(!path.exists());

        // Removing again is fine.
        remove_site_block(&sites, "app.test").expect("idempotent");
    }

    #[test]
    fn pruning_removes_only_stale_blocks() {
        let dir = tempfile::tempdir().expect("temp");
        let sites = dir.path().join("sites");
        std::fs::create_dir_all(&sites).expect("dir");

        for hostname in ["keep.test", "stale.test"] {
            std::fs::write(sites.join(format!("{hostname}.conf")), "# block\n").expect("seed");
        }
        // A subdirectory must not confuse the pruner.
        std::fs::create_dir_all(sites.join("not-a-site.conf")).expect("dir");

        let pruned = prune_stale_blocks(&sites, &["keep.test".to_owned()]).expect("prune");

        assert_eq!(pruned, vec!["stale.test".to_owned()]);
        assert!(sites.join("keep.test.conf").is_file());
        assert!(!sites.join("stale.test.conf").exists());
        assert!(sites.join("not-a-site.conf").is_dir(), "dirs survive");
    }

    #[test]
    fn pool_endpoint_reads_the_rendered_pool_conf() {
        let dir = tempfile::tempdir().expect("temp");
        let config_root = dir.path().join("service-config");
        let pool_dir = config_root.join("php-pool-8.4.25");
        std::fs::create_dir_all(&pool_dir).expect("dir");

        // No pool.conf yet: the endpoint is unknown and must be refused.
        assert!(pool_endpoint_for(&config_root, "8.4.25").is_err());

        std::fs::write(
            pool_dir.join("pool.conf"),
            "[pool]\nlisten = 127.0.0.1:9100\nworkers = 4\n",
        )
        .expect("seed");

        assert_eq!(
            pool_endpoint_for(&config_root, "8.4.25").expect("endpoint"),
            "127.0.0.1:9100"
        );
    }

    #[test]
    fn full_spec_validation_requires_a_known_pool() {
        let dir = tempfile::tempdir().expect("temp");
        let config_root = dir.path().join("service-config");

        // PHP version with no started pool: refused with a clear error.
        let err = validate_spec(&spec("app.test", Some("8.4.25")), &config_root)
            .expect_err("pool has never started");
        assert_eq!(err.code, ErrorCode::NotFound);

        // Static site: no pool needed.
        assert!(validate_spec(&spec("app.test", None), &config_root).is_ok());
    }
}
