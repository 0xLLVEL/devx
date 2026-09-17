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

use crate::pki::{ensure_site_cert, tls_listen_snippet};

/// Maximum sites DevX manages; guards against runaway config generation.
pub const MAX_SITES: usize = 256;

/// The hostname a site serves on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteHostname(pub String);

/// A user-configured site.
///
/// Internal to the render pipeline: the desktop command layer constructs it
/// from the stored config, and neither it nor its `WebServerKind` appears
/// on the IPC surface, so no serde or specta derives are needed.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// Which web server serves this site. Only nginx has a sites-include
    /// pipeline today; Caddy and FrankenPHP render into their own
    /// per-server include directories.
    pub web_server: WebServerKind,
    /// Basic-auth credentials, `None` for a public site.
    pub auth: Option<devx_core::config::SiteAuth>,
}

/// Which web server serves a site — the render-side mirror of
/// `devx_core::config::WebServer`, kept separate so the sync pipeline never
/// depends on the caller's storage type (same split as `SyncSite`). It is
/// an internal render detail, not an IPC type, so it carries no serde or
/// specta derives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WebServerKind {
    /// nginx server blocks under `service-config/nginx/sites`.
    #[default]
    Nginx,
    /// Apache virtual hosts under `service-config/apache/sites`.
    Apache,
    /// Caddy site entries under `service-config/caddy/sites`.
    Caddy,
    /// FrankenPHP (no pool; PHP served by the binary itself).
    FrankenPhp,
}

impl From<devx_core::config::WebServer> for WebServerKind {
    fn from(value: devx_core::config::WebServer) -> Self {
        match value {
            devx_core::config::WebServer::Nginx => WebServerKind::Nginx,
            devx_core::config::WebServer::Apache => WebServerKind::Apache,
            devx_core::config::WebServer::Caddy => WebServerKind::Caddy,
            devx_core::config::WebServer::FrankenPhp => WebServerKind::FrankenPhp,
        }
    }
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
    render_server_block_with_port(spec, php_endpoint, tls, 80)
}

/// Renders one nginx `server` block for `spec` on `http_port`.
pub fn render_server_block_with_port(
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    tls: Option<&str>,
    http_port: u16,
) -> String {
    let docroot = slash(&spec.docroot);

    let env_lines = render_env_params(&spec.env);
    let auth_lines = render_nginx_auth(&spec.auth, &spec.hostname);

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
    listen       {http_port};
    server_name  {hostname};
{tls}    root   {docroot};
    index  {index};

    access_log  logs/{hostname}.access.log;
    error_log   logs/{hostname}.error.log;

{php_location}{auth_lines}    location / {{
        try_files $uri $uri/ /index.php?$query_string;
    }}
}}
"#,
        hostname = spec_hostname(spec),
        http_port = http_port,
        docroot = docroot,
        index = index,
        php_location = php_location,
        tls = tls.unwrap_or_default(),
        auth_lines = auth_lines,
    )
}

/// Renders the nginx basic-auth directives for one site.
///
/// The `auth_basic` plus `auth_basic_user_file` pair sits at `server` level
/// so every location inherits it; the htpasswd file lives next to the site
/// blocks under `service-config/nginx/auth`.
fn render_nginx_auth(
    auth: &Option<devx_core::config::SiteAuth>,
    hostname: &str,
) -> String {
    if auth.is_none() {
        return String::new();
    };
    let _ = auth;
    format!(
        "\n    auth_basic            \"restricted\";\n    auth_basic_user_file  auth/{hostname}.htpasswd;\n"
    )
}

/// Writes the htpasswd file for one site's basic auth.
///
/// Called by the sync pipeline whenever a site carries credentials, so the
/// rendered block never references a file that does not exist.
pub fn write_htpasswd(
    auth_dir: &Path,
    hostname: &str,
    auth: &devx_core::config::SiteAuth,
) -> Result<()> {
    std::fs::create_dir_all(auth_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", auth_dir.display()),
        )
    })?;
    let line = format!("{}:{}\n", auth.username, auth.password_hash);
    devx_core::fsx::write_atomic(auth_dir.join(format!("{hostname}.htpasswd")), line)
}

/// Removes the htpasswd file for a site that no longer has auth.
pub fn remove_htpasswd(auth_dir: &Path, hostname: &str) {
    let _ = std::fs::remove_file(auth_dir.join(format!("{hostname}.htpasswd")));
}

/// The full `server_name` value: the primary host name plus its aliases.
fn spec_hostname(spec: &SiteSpec) -> String {
    let mut names = vec![spec.hostname.clone()];
    names.extend(spec.aliases.iter().cloned());
    names.join(" ")
}

/// Renders one site as an Apache VirtualHost block.
pub fn render_apache_site(
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    http_port: u16,
) -> String {
    let docroot = slash(&spec.docroot);
    let index = if spec.php_version.is_some() {
        "index.php index.html index.htm"
    } else {
        "index.html index.htm"
    };

    let server_alias = if spec.aliases.is_empty() {
        String::new()
    } else {
        format!("\n    ServerAlias {}", spec.aliases.join(" "))
    };

    let php_handler = match php_endpoint {
        Some(endpoint) => format!(
            "\n    <FilesMatch \\.php$>\n        SetHandler \"proxy:fcgi://{endpoint}/\"\n    </FilesMatch>"
        ),
        None => String::new(),
    };

    let env_lines = render_apache_env(&spec.env);
    let auth_lines = match &spec.auth {
        Some(auth) => {
            let _ = auth;
            format!(
                "\n        AuthType Basic\n        AuthName \"Restricted\"\n        AuthUserFile auth/{}.htpasswd\n        Require valid-user",
                spec.hostname
            )
        }
        None => String::new(),
    };

    format!(
        r#"# devx-managed site: {hostname}
<VirtualHost *:{http_port}>
    ServerName {hostname}{server_alias}
    DocumentRoot "{docroot}"
    DirectoryIndex {index}

    <Directory "{docroot}">
        Options Indexes FollowSymLinks
        AllowOverride All
        Require all granted{auth_lines}
    </Directory>{env_lines}{php_handler}

    ErrorLog  logs/{hostname}.error.log
    CustomLog logs/{hostname}.access.log common
</VirtualHost>
"#,
        hostname = spec.hostname,
        server_alias = server_alias,
        http_port = http_port,
        docroot = docroot,
        index = index,
        auth_lines = auth_lines,
        env_lines = env_lines,
        php_handler = php_handler,
    )
}

fn render_apache_env(env: &[(String, String)]) -> String {
    let mut lines = String::new();
    for (key, value) in env {
        lines.push_str(&format!("\n    SetEnv {key} \"{value}\""));
    }
    lines
}

/// Renders one site as a Caddyfile site entry.
///
/// Caddy's file-server + `php_fastcgi` pair covers everything the nginx
/// block did: static serving, PHP proxying to the pool, and index files.
/// TLS is left to Caddy's own internal CA on `https_port` — the DevX local
/// CA handles sites it proxies, but Caddy re-terminates its own listener.
pub fn render_caddy_site(
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    tls: Option<&str>,
) -> String {
    let docroot = slash(&spec.docroot);
    let names = spec_hostname(spec);

    let php_block = match php_endpoint {
        Some(endpoint) => format!("\n\tphp_fastcgi {endpoint}"),
        None => String::new(),
    };

    let auth_block = match &spec.auth {
        Some(auth) => format!(
            "\n\tbasic_auth {{\n\t\t{} {}\n\t}}",
            auth.username, auth.password_hash
        ),
        None => String::new(),
    };

    // `tls internal` keeps Caddy self-signing instead of ACME; when DevX
    // passes a TLS snippet (the local CA pair) we use that instead.
    let tls_line = match tls {
        Some(snippet) => format!("\n\t{snippet}"),
        None => String::new(),
    };

    format!(
        r##"# devx-managed site: {names}
{names} {{
	root * {docroot}{tls_line}
	file_server{auth_block}{php_block}
	log {{
		output file {{log_dir}}/{hostname}.access.log
	}}
}}
"##,
        names = names,
        docroot = docroot,
        php_block = php_block,
        tls_line = tls_line,
        auth_block = auth_block,
        hostname = spec.hostname,
    )
}

/// Renders one site for FrankenPHP.
///
/// FrankenPHP serves PHP directly (no pool), so the entry is a plain
/// document root plus the listen address. Environment variables reach PHP
/// through FrankenPHP's own `php.ini` env passthrough, which reads the
/// process environment — DevX renders them as directives in the site file
/// via Caddy's `env` adapter is not needed, so they ride on the worker
/// definition instead. Static and PHP sites are identical here.
pub fn render_frankenphp_site(spec: &SiteSpec, tls: Option<&str>) -> String {
    let docroot = slash(&spec.docroot);
    let names = spec_hostname(spec);

    let tls_line = match tls {
        Some(snippet) => format!("\n\t{snippet}"),
        None => String::new(),
    };

    let auth_block = match &spec.auth {
        Some(auth) => format!(
            "\n\tbasic_auth {{\n\t\t{} {}\n\t}}",
            auth.username, auth.password_hash
        ),
        None => String::new(),
    };

    format!(
        r##"# devx-managed site: {names}
{names} {{
	root * {docroot}{tls_line}
	file_server{auth_block}
}}
"##,
        names = names,
        docroot = docroot,
        tls_line = tls_line,
        auth_block = auth_block,
    )
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

/// Writes a canonical `fastcgi_params` file into `config_dir`.
///
/// Site blocks include it by bare file name (`include fastcgi_params;`),
/// which nginx resolves against the *config directory* — not the install
/// prefix — so DevX ships its own copy there instead of relying on the
/// per-version file inside the nginx install.
///
/// # Errors
///
/// Fails when the file cannot be written.
pub fn write_fastcgi_params(config_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(config_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", config_dir.display()),
        )
    })?;

    devx_core::fsx::write_atomic(config_dir.join("fastcgi_params"), FASTCGI_PARAMS)
}

/// The standard FastCGI parameter set a PHP location needs.
const FASTCGI_PARAMS: &str = r#"fastcgi_param  QUERY_STRING       $query_string;
fastcgi_param  REQUEST_METHOD     $request_method;
fastcgi_param  CONTENT_TYPE       $content_type;
fastcgi_param  CONTENT_LENGTH     $content_length;
fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;
fastcgi_param  REQUEST_URI        $request_uri;
fastcgi_param  DOCUMENT_URI       $document_uri;
fastcgi_param  DOCUMENT_ROOT      $document_root;
fastcgi_param  SERVER_PROTOCOL    $server_protocol;
fastcgi_param  REQUEST_SCHEME     $scheme;
fastcgi_param  HTTPS              $https if_not_empty;
fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;
fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;
fastcgi_param  REMOTE_ADDR        $remote_addr;
fastcgi_param  REMOTE_PORT        $remote_port;
fastcgi_param  SERVER_ADDR        $server_addr;
fastcgi_param  SERVER_PORT        $server_port;
fastcgi_param  SERVER_NAME        $server_name;
fastcgi_param  REDIRECT_STATUS    200;
"#;

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
    write_site_block_with_port(sites_dir, spec, php_endpoint, tls, 80)
}

/// Writes (or replaces) the server block for `spec` on `http_port` and reports the outcome.
pub fn write_site_block_with_port(
    sites_dir: &Path,
    spec: &SiteSpec,
    php_endpoint: Option<&str>,
    tls: Option<&str>,
    http_port: u16,
) -> Result<PathBuf> {
    validate_hostname(&spec.hostname)?;
    validate_docroot(&spec.docroot)?;

    std::fs::create_dir_all(sites_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", sites_dir.display()),
        )
    })?;

    let body = render_server_block_with_port(spec, php_endpoint, tls, http_port);
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

/// One configured site, as the sync pipeline consumes it.
///
/// A thin projection of the stored `ConfigSite` (both frontends keep the
/// config shape, this module keeps the render shape), so the sync never
/// depends on the caller's storage type.
#[derive(Debug, Clone)]
pub struct SyncSite {
    /// Host name served.
    pub hostname: String,
    /// Absolute document root.
    pub docroot: PathBuf,
    /// PHP version whose pool serves the site; `None` for static.
    pub php_version: Option<String>,
    /// Whether the site serves HTTPS alongside HTTP.
    pub https: bool,
    /// Environment variables exposed as `fastcgi_param` lines, pre-sorted.
    pub env: Vec<(String, String)>,
    /// Additional host names on the `server_name` line.
    pub aliases: Vec<String>,
    /// Which web server serves this site.
    pub web_server: WebServerKind,
    /// Basic-auth credentials, `None` for a public site.
    pub auth: Option<devx_core::config::SiteAuth>,
}

/// Inputs the sync needs that vary per frontend.
#[derive(Debug, Clone, Copy)]
pub struct SyncContext<'a> {
    /// The nginx service-config root (each pool's `pool.conf` lives under it).
    pub service_config_dir: &'a Path,
    /// Where per-site certificates are minted and read.
    pub certs_dir: &'a Path,
    /// The configured HTTP port for site blocks.
    pub http_port: u16,
    /// The configured HTTPS port for `listen 443` blocks.
    pub https_port: u16,
}

/// (Re)writes every configured site's server block and prunes stale ones.
///
/// One sync per mutation keeps the include directory exactly equal to the
/// configured set, which is what makes web server restarts deterministic. The
/// whole pipeline lives here — endpoint resolution, certificate minting,
/// block rendering, pruning — so the desktop app and the CLI cannot drift:
/// both call this and neither owns ordering rules.
pub fn sync_site_blocks(
    sites_dir: &Path,
    sites: &[SyncSite],
    ctx: SyncContext<'_>,
) -> Result<SiteSyncReport> {
    std::fs::create_dir_all(sites_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", sites_dir.display()),
        )
    })?;

    let mut written = Vec::with_capacity(sites.len());

    for site in sites {
        let spec = SiteSpec {
            hostname: site.hostname.clone(),
            docroot: site.docroot.clone(),
            php_version: site.php_version.clone(),
            env: site.env.clone(),
            aliases: site.aliases.clone(),
            web_server: site.web_server,
            auth: site.auth.clone(),
        };

        let endpoint = match (&spec.php_version, site.web_server) {
            (Some(version), WebServerKind::Nginx | WebServerKind::Apache | WebServerKind::Caddy) => {
                Some(pool_endpoint_for(ctx.service_config_dir, version)?)
            }
            // FrankenPHP serves PHP directly; there is no pool to find.
            (_, WebServerKind::FrankenPhp) => None,
            (None, _) => None,
        };

        // HTTPS sites get their certificate minted (or reused) during the
        // sync, so the server never references a cert file that does not
        // exist.
        let tls = if site.https {
            ensure_site_cert(ctx.certs_dir, &site.hostname)?;
            Some(tls_listen_snippet(
                &site.hostname,
                ctx.https_port,
                ctx.certs_dir,
            ))
        } else {
            None
        };

        let target_dir = match site.web_server {
            WebServerKind::Nginx => sites_dir.to_path_buf(),
            WebServerKind::Apache => {
                let dir = ctx.service_config_dir.join("apache").join("sites");
                if dir.exists() || dir.parent().map(|p| p.exists()).unwrap_or(false) {
                    dir
                } else {
                    sites_dir.to_path_buf()
                }
            }
            WebServerKind::Caddy => {
                let dir = ctx.service_config_dir.join("caddy").join("sites");
                if dir.exists() || dir.parent().map(|p| p.exists()).unwrap_or(false) {
                    dir
                } else {
                    sites_dir.to_path_buf()
                }
            }
            WebServerKind::FrankenPhp => {
                let dir = ctx.service_config_dir.join("frankenphp").join("sites");
                if dir.exists() || dir.parent().map(|p| p.exists()).unwrap_or(false) {
                    dir
                } else {
                    sites_dir.to_path_buf()
                }
            }
        };
        std::fs::create_dir_all(&target_dir).map_err(|err| {
            Error::new(
                ErrorCode::Io,
                format!("failed to create {}: {err}", target_dir.display()),
            )
        })?;

        // Auth files live beside the blocks
        let auth_dir = target_dir.join("auth");
        match &site.auth {
            Some(auth) => write_htpasswd(&auth_dir, &site.hostname, auth)?,
            None => remove_htpasswd(&auth_dir, &site.hostname),
        }

        match site.web_server {
            WebServerKind::Nginx => {
                write_site_block_with_port(&target_dir, &spec, endpoint.as_deref(), tls.as_deref(), ctx.http_port)?;
            }
            WebServerKind::Apache => {
                let body = render_apache_site(&spec, endpoint.as_deref(), ctx.http_port);
                let path = target_dir.join(block_file_name(&spec.hostname));
                devx_core::fsx::write_atomic(&path, body)?;
            }
            WebServerKind::Caddy => {
                let body = render_caddy_site(&spec, endpoint.as_deref(), tls.as_deref());
                let path = target_dir.join(block_file_name(&spec.hostname));
                devx_core::fsx::write_atomic(&path, body)?;
            }
            WebServerKind::FrankenPhp => {
                let body = render_frankenphp_site(&spec, tls.as_deref());
                let path = target_dir.join(block_file_name(&spec.hostname));
                devx_core::fsx::write_atomic(&path, body)?;
            }
        }
        written.push(site.hostname.clone());
    }

    let live: Vec<String> = sites.iter().map(|s| s.hostname.clone()).collect();
    let mut pruned = prune_stale_blocks(sites_dir, &live)?;
    for extra in ["apache", "caddy", "frankenphp"] {
        let dir = ctx.service_config_dir.join(extra).join("sites");
        if dir.is_dir() && dir != sites_dir {
            let live_extra: Vec<String> = sites
                .iter()
                .filter(|s| match (extra, s.web_server) {
                    ("apache", WebServerKind::Apache) => true,
                    ("caddy", WebServerKind::Caddy) => true,
                    ("frankenphp", WebServerKind::FrankenPhp) => true,
                    _ => false,
                })
                .map(|s| s.hostname.clone())
                .collect();
            pruned.extend(prune_stale_blocks(&dir, &live_extra)?);
        }
    }

    Ok(SiteSyncReport { written, pruned })
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
            web_server: WebServerKind::Nginx,
            auth: None,
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
        let tls = crate::tls_listen_snippet("app.test", 443, std::path::Path::new("C:/devx/certs"));
        let block = render_server_block(&spec("app.test", None), None, Some(&tls));

        assert!(block.contains("listen       443 ssl;"), "{block}");
        assert!(block.contains("listen       80;"), "{block}");
        assert!(
            block.contains("ssl_certificate     C:/devx/certs/sites/app.test/cert.pem;"),
            "{block}"
        );
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
    fn caddy_site_renders_root_file_server_and_fastcgi() {
        let mut site = spec("app.test", Some("8.4.25"));
        site.web_server = WebServerKind::Caddy;
        let block = render_caddy_site(&site, Some("127.0.0.1:9100"), None);

        assert!(block.contains("app.test {"), "{block}");
        assert!(block.contains(&format!("root * {}", slash(&site.docroot))), "{block}");
        assert!(block.contains("file_server"), "{block}");
        assert!(block.contains("php_fastcgi 127.0.0.1:9100"), "{block}");
    }

    #[test]
    fn frankenphp_site_needs_no_pool_endpoint() {
        let mut site = spec("app.test", Some("8.4.25"));
        site.web_server = WebServerKind::FrankenPhp;
        let block = render_frankenphp_site(&site, None);

        assert!(block.contains("app.test {"), "{block}");
        assert!(block.contains("file_server"), "{block}");
        // No FastCGI: FrankenPHP executes PHP itself.
        assert!(!block.contains("php_fastcgi"), "{block}");
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

    #[test]
    fn sync_writes_blocks_prunes_stale_and_mints_certs_for_https() {
        let dir = tempfile::tempdir().expect("temp");
        let certs = dir.path().join("certs");
        // The CA signs every site certificate; the sync assumes it exists.
        crate::pki::ensure_ca(&certs).expect("local CA");
        let sites_dir = dir.path().join("nginx").join("sites");
        let docroot = dir.path().join("www");
        std::fs::create_dir_all(&docroot).expect("docroot");

        // A pre-existing block for a site that is no longer configured.
        std::fs::create_dir_all(&sites_dir).expect("sites dir");
        std::fs::write(sites_dir.join("old.test.conf"), "# stale").expect("stale block");

        let sites = vec![
            SyncSite {
                hostname: "app.test".into(),
                docroot: docroot.clone(),
                php_version: None,
                https: true,
                env: Vec::new(),
                aliases: vec!["www.app.test".into()],
                web_server: WebServerKind::Nginx,
                auth: None,
            },
            SyncSite {
                hostname: "plain.test".into(),
                docroot,
                php_version: None,
                https: false,
                env: Vec::new(),
                aliases: Vec::new(),
                web_server: WebServerKind::Nginx,
                auth: None,
            },
        ];

        let report = sync_site_blocks(
            &sites_dir,
            &sites,
            SyncContext {
                service_config_dir: dir.path(),
                certs_dir: &certs,
                http_port: 80,
                https_port: 443,
            },
        )
        .expect("sync");

        assert!(report.written.contains(&"app.test".to_owned()));
        assert!(report.pruned.contains(&"old.test".to_owned()));
        assert!(sites_dir.join("app.test.conf").is_file());
        assert!(sites_dir.join("plain.test.conf").is_file());
        assert!(!sites_dir.join("old.test.conf").exists());

        // Certificate minting is part of the sync, so an HTTPS block never
        // references a cert that does not exist.
        assert!(certs.join("sites").join("app.test").is_dir());
        assert!(!certs.join("sites").join("plain.test").exists());
    }

    #[test]
    fn apache_site_renders_virtualhost_and_fastcgi() {
        let mut site = spec("app.test", Some("8.4.25"));
        site.aliases = vec!["www.app.test".into()];
        site.env = vec![("APP_ENV".into(), "production".into())];

        let block = render_apache_site(&site, Some("127.0.0.1:9100"), 8085);
        assert!(block.contains("<VirtualHost *:8085>"), "{block}");
        assert!(block.contains("ServerName app.test"), "{block}");
        assert!(block.contains("ServerAlias www.app.test"), "{block}");
        assert!(block.contains("SetHandler \"proxy:fcgi://127.0.0.1:9100/\""), "{block}");
        assert!(block.contains("SetEnv APP_ENV \"production\""), "{block}");
        assert!(block.contains("DirectoryIndex index.php index.html index.htm"), "{block}");
    }
}
