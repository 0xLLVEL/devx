//! PHP FastCGI pools: how an installed PHP version becomes a serving pool.
//!
//! PHP is deliberately absent from [`crate::service_defs`]: instead of one
//! long-running "PHP service", every *installed PHP version* gets its own
//! FastCGI pool — one supervised `php-cgi` process bound to
//! `127.0.0.1:<port>`, serving a configurable number of FastCGI workers via
//! `PHP_FCGI_CHILDREN`.
//!
//! That shape has two consequences worth calling out:
//!
//! 1. **Versions are isolated.** A site pinned to PHP 8.3 talks to the 8.3
//!    pool and nothing else, so upgrading one project cannot silently change
//!    the runtime of another.
//! 2. **Several versions can run at once.** Each pool listens on its own
//!    port, so 8.3 and 8.4 coexist and Task 9 simply points a site's
//!    `fastcgi_pass` at the pool of its choosing.
//!
//! Like the service definitions, everything here is pure: the module computes
//! what *would* run and renders the files to write; the desktop shell writes
//! them and turns the result into a [`devx_proc::ProcessSpec`]. Nothing here
//! touches the network or spawns a process, so the whole mapping is
//! unit-testable.

use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};
use serde::Serialize;

/// Stable prefix for pool identifiers: `php-pool-8.4.25`.
const POOL_ID_PREFIX: &str = "php-pool-";

/// Default number of FastCGI workers per pool.
///
/// php-cgi serves requests through its children; with no `PHP_FCGI_CHILDREN`
/// a single worker handles one request at a time, which stalls a page that
/// pulls a few assets. Four covers the common case without hoarding memory on
/// a laptop — each child is a full PHP process.
pub const DEFAULT_WORKERS: u32 = 4;

/// Upper bound on workers, validated before anything is rendered.
///
/// Each child is a full PHP process, so a typo like 9000 would exhaust the
/// machine long before it helped anyone.
pub const MAX_WORKERS: u32 = 32;

/// Port the first pool prefers; later pools walk upward from here.
///
/// Deliberately off the defaults the service definitions reserve (nginx 80,
/// MariaDB 3306, …) and out of the ephemeral range, so a pool keeps its port
/// across reboots.
pub const FIRST_POOL_PORT: u16 = 9100;

/// Identifier of the pool serving PHP `version`.
pub fn pool_id(version: &str) -> String {
    format!("{POOL_ID_PREFIX}{version}")
}

/// Extracts the PHP version from a pool id, if it is one.
pub fn version_of_pool(id: &str) -> Option<&str> {
    id.strip_prefix(POOL_ID_PREFIX).filter(|v| !v.is_empty())
}

/// Whether `id` identifies a PHP FastCGI pool.
pub fn is_pool_id(id: &str) -> bool {
    version_of_pool(id).is_some()
}

/// Validates a requested worker count.
///
/// Split out so the bound lives next to [`MAX_WORKERS`] and the planner and
/// the IPC command reuse one rule.
pub fn validate_workers(workers: u32) -> Result<()> {
    if workers == 0 || workers > MAX_WORKERS {
        return Err(Error::invalid_input(format!(
            "PHP workers must be between 1 and {MAX_WORKERS}"
        )));
    }
    Ok(())
}

/// Knobs a pool is planned with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PoolPlanOptions {
    /// Port the pool binds to.
    pub port: u16,
    /// Number of FastCGI workers behind the pool.
    pub workers: u32,
    /// Enabled extension DLL file names, rendered into the pool's `php.ini`.
    pub extensions: Vec<String>,
}

impl PoolPlanOptions {
    /// Defaults: [`DEFAULT_WORKERS`] workers on the given port.
    pub fn new(port: u16) -> Self {
        Self {
            port,
            workers: DEFAULT_WORKERS,
            extensions: Vec::new(),
        }
    }

    /// Overrides the worker count.
    pub fn with_workers(mut self, workers: u32) -> Self {
        self.workers = workers;
        self
    }

    /// Overrides the enabled extensions.
    pub fn with_extensions(mut self, extensions: Vec<String>) -> Self {
        self.extensions = extensions;
        self
    }
}

/// Everything needed to run one pool, produced by [`plan_pool`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhpPoolPlan {
    /// Stable supervisor id: `php-pool-<version>`.
    pub id: String,
    /// The PHP version this pool serves.
    pub version: String,
    /// Absolute path of `php-cgi.exe`.
    pub program: PathBuf,
    /// Launch arguments, with the port and ini path already resolved.
    pub args: Vec<String>,
    /// Extra environment (`PHP_FCGI_CHILDREN` and friends).
    pub env: Vec<(String, String)>,
    /// FastCGI workers behind this pool.
    pub workers: u32,
    /// Port the pool binds to.
    pub port: u16,
    /// Enabled extension DLL file names rendered into `php.ini`.
    pub extensions: Vec<String>,
    /// The rendered `php.ini`, written by the shell before launch.
    pub php_ini: String,
    /// The rendered `pool.conf`; Task 9's nginx sites read `listen` from it.
    pub pool_conf: String,
}

impl PhpPoolPlan {
    /// A UI-facing summary without file contents or paths.
    pub fn summary(&self) -> PhpPoolSummary {
        PhpPoolSummary {
            id: self.id.clone(),
            version: self.version.clone(),
            workers: self.workers,
        }
    }
}

/// Describes one pool for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct PhpPoolSummary {
    /// Pool identifier (`php-pool-8.4.25`).
    pub id: String,
    /// PHP version served by this pool.
    pub version: String,
    /// FastCGI workers configured for the pool.
    pub workers: u32,
}

/// Plans (but does not start or write) the FastCGI pool for PHP `version`.
///
/// The directories follow the same layout the service definitions use, keyed
/// by pool id so two versions never share config or session state:
///
/// * `install_dir` — `runtimes/php/<version>`, where `php-cgi.exe` lives
/// * `config_dir`  — `service-config/<pool id>`, receiving `php.ini`
/// * `data_dir`    — `service-data/<pool id>`, holding sessions
/// * `log_dir`     — the shared logs directory
///
/// # Errors
///
/// Fails when `workers` is outside the validated range or a template fails to
/// render, which would indicate a build defect rather than a user problem.
pub fn plan_pool(
    version: &str,
    install_dir: &Path,
    config_dir: &Path,
    data_dir: &Path,
    log_dir: &Path,
    options: &PoolPlanOptions,
) -> Result<PhpPoolPlan> {
    validate_workers(options.workers)?;

    let values = [
        ("install_dir", slash(install_dir)),
        ("config_dir", slash(config_dir)),
        ("data_dir", slash(data_dir)),
        ("log_dir", slash(log_dir)),
        ("port", options.port.to_string()),
        ("workers", options.workers.to_string()),
        // Referenced by the ini's error_log and the pool conf header.
        ("version", version.to_owned()),
        // Pre-rendered `extension =` lines; the loop lives in Rust because the
        // renderer only handles flat string maps.
        ("extensions", render_extension_lines(&options.extensions)),
    ];

    let php_ini = render(PHP_INI_TEMPLATE, &values)?;
    let pool_conf = render(POOL_CONF_TEMPLATE, &values)?;

    let ini_path = config_dir.join("php.ini");

    Ok(PhpPoolPlan {
        id: pool_id(version),
        version: version.to_owned(),
        program: install_dir.join("php-cgi.exe"),
        args: vec![
            // `-b` binds the FastCGI socket; `-c` selects the php.ini.
            "-b".into(),
            format!("127.0.0.1:{}", options.port),
            "-c".into(),
            slash(&ini_path),
        ],
        env: vec![
            ("PHP_FCGI_CHILDREN".into(), options.workers.to_string()),
            // Recycling children bounds leaks in third-party extensions; a
            // plain number keeps it predictable. 0 would disable recycling.
            ("PHP_FCGI_MAX_REQUESTS".into(), "500".into()),
        ],
        workers: options.workers,
        port: options.port,
        extensions: options.extensions.clone(),
        php_ini,
        pool_conf,
    })
}

/// Reads the `[pool] listen` value out of a rendered `pool.conf`.
///
/// Task 9's site templating needs the FastCGI endpoint of a pool; parsing the
/// written file keeps it the single source of truth for the port.
///
/// # Errors
///
/// Fails when the file is missing or carries no `listen` line, which means
/// the pool has never been started or its files were removed.
pub fn pool_listen_addr(config_dir: &Path) -> Result<String> {
    let path = config_dir.join("pool.conf");
    let body = std::fs::read_to_string(&path).map_err(|err| {
        // A never-started pool reports NotFound, not a generic IO failure:
        // callers branch on this to explain "start the pool first".
        let code = if err.kind() == std::io::ErrorKind::NotFound {
            ErrorCode::NotFound
        } else {
            ErrorCode::Io
        };
        Error::new(code, format!("failed to read {}: {err}", path.display()))
            .with_hint("start the PHP pool once so DevX can render its pool.conf")
    })?;

    body.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("listen = "))
        .map(str::to_owned)
        .ok_or_else(|| {
            Error::config(format!("{} has no listen address", path.display()))
                .with_hint("start the pool once so DevX can regenerate its files")
        })
}

/// Renders the `[PHP]` extension block for the enabled extensions.
///
/// Zend extensions (`opcache`, `xdebug`) must load through `zend_extension`,
/// not `extension`, or PHP refuses to start — the one trap here.
fn render_extension_lines(extensions: &[String]) -> String {
    if extensions.is_empty() {
        return String::new();
    }

    let mut lines = vec!["; Extensions enabled in DevX.".to_owned()];
    for name in extensions {
        let directive = if is_zend_extension(name) {
            "zend_extension"
        } else {
            "extension"
        };
        lines.push(format!("{directive} = {name}"));
    }
    lines.join("\n")
}

/// Whether an extension DLL must load as a Zend extension.
///
/// Names are the DLL file names as discovered in `ext/`; the plain stem is
/// matched so either `opcache` or `php_opcache.dll` classifies the same.
fn is_zend_extension(file_name: &str) -> bool {
    let stem = file_name
        .strip_prefix("php_")
        .and_then(|rest| rest.strip_suffix(".dll"))
        .unwrap_or(file_name);
    matches!(stem, "opcache" | "xdebug")
}

/// Lists the extension DLLs an installed PHP version ships.
///
/// Returns the exact file names (e.g. `php_gd.dll`) because that is what the
/// rendered directive must spell. A version without an `ext/` directory has
/// none; a missing directory is not an error.
///
/// # Errors
///
/// Fails only when the directory exists but cannot be read.
pub fn list_php_extensions(install_dir: &Path) -> Result<Vec<String>> {
    let ext_dir = install_dir.join("ext");
    if !ext_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    let entries = std::fs::read_dir(&ext_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to read {}: {err}", ext_dir.display()),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|err| {
            Error::new(
                ErrorCode::Io,
                format!("failed to read {}: {err}", ext_dir.display()),
            )
        })?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let is_dll = name
            .rsplit('.')
            .next()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"));
        if is_dll && name.to_ascii_lowercase().starts_with("php_") {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

/// Writes the pool's `php.ini` into `config_dir` before launch.
///
/// `pool.conf` is documentation and a machine-readable lookup for Task 9, so
/// it is written alongside. Both go through
/// [`devx_core::fsx::write_atomic`] so a crash never leaves a truncated ini.
pub fn write_pool_files(config_dir: &Path, plan: &PhpPoolPlan) -> Result<()> {
    std::fs::create_dir_all(config_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", config_dir.display()),
        )
    })?;

    devx_core::fsx::write_atomic(config_dir.join("php.ini"), &plan.php_ini)?;
    devx_core::fsx::write_atomic(config_dir.join("pool.conf"), &plan.pool_conf)?;
    Ok(())
}

/// The `php.ini` DevX generates for every pool.
///
/// Deliberately minimal: extensions ship in `ext/` and are enabled per version
/// from the UI (see [`render_extension_lines`]). Error and session paths point
/// into the DevX tree so the Services page shows PHP diagnostics next to the
/// pool log, and mail defaults to Mailpit's SMTP port so `mail()` lands in the
/// local inbox.
const PHP_INI_TEMPLATE: &str = r#"; Generated by DevX for the PHP {{ workers }}-worker FastCGI pool.
; Hand edits are overwritten on the next start; customise via DevX instead.

[PHP]
engine = On
short_open_tag = Off
output_buffering = 4096
zend.enable_gc = On
expose_php = Off
max_execution_time = 60
max_input_time = 60
memory_limit = 256M
error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT
display_errors = Off
display_startup_errors = Off
log_errors = On
error_log = {{ log_dir }}/php-{{ version }}.log
variables_order = "GPCS"
request_order = "GP"
register_argc_argv = Off
post_max_size = 64M
default_charset = "UTF-8"
upload_max_filesize = 64M
max_file_uploads = 20
allow_url_fopen = On
allow_url_include = Off
extension_dir = {{ install_dir }}/ext
{{ extensions }}

[Date]
; No hard-coded timezone: PHP falls back to UTC, and per-site overrides come
; with Task 9's site configuration.

[Session]
session.save_handler = files
session.save_path = "{{ data_dir }}/sessions"
session.use_strict_mode = 1
session.use_only_cookies = 1
session.name = DevXSession
session.gc_maxlifetime = 1440
session.gc_probability = 1
session.gc_divisor = 100
session.cookie_httponly = 1

[mail function]
; Mail goes to Mailpit when it is running; sites can override per site later.
SMTP = 127.0.0.1
smtp_port = 1025
sendmail_from = devx@localhost
"#;

/// The FastCGI pool configuration.
///
/// php-cgi has no native pool file; this documents the pool for diagnostics
/// and gives Task 9's nginx sites a machine-readable `listen` value so the
/// port is written down in exactly one place.
const POOL_CONF_TEMPLATE: &str = r#"# Generated by DevX: FastCGI pool for PHP {{ version }}.
[pool]
listen = 127.0.0.1:{{ port }}
workers = {{ workers }}
php_ini = {{ config_dir }}/php.ini
error_log = {{ log_dir }}/php-{{ version }}.log
"#;

/// Renders a minijinja template against a flat string map.
fn render(template: &str, values: &[(&str, String)]) -> Result<String> {
    let mut env = minijinja::Environment::new();
    env.add_template("t", template)
        .map_err(|err| Error::new(ErrorCode::Config, format!("invalid template: {err}")))?;

    let map: std::collections::BTreeMap<&str, &str> = values
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();

    env.get_template("t")
        .map_err(|err| Error::new(ErrorCode::Config, format!("template error: {err}")))?
        .render(&map)
        .map_err(|err| {
            Error::new(
                ErrorCode::Config,
                format!("failed to render template: {err}"),
            )
        })
}

/// Renders a path with forward slashes, matching the service definitions:
/// PHP parses them correctly on Windows while backslashes need escaping.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const VERSION: &str = "8.4.25";

    fn dirs(root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            root.join("runtimes/php").join(VERSION),
            root.join("service-config").join(pool_id(VERSION)),
            root.join("service-data").join(pool_id(VERSION)),
            root.join("logs"),
        )
    }

    fn plan_at(root: &Path, options: &PoolPlanOptions) -> PhpPoolPlan {
        let (install, config, data, logs) = dirs(root);
        plan_pool(VERSION, &install, &config, &data, &logs, options).expect("plan")
    }

    fn plan(workers: u32) -> PhpPoolPlan {
        plan_at(
            Path::new("C:/devx/data"),
            &PoolPlanOptions::new(9100).with_workers(workers),
        )
    }

    #[test]
    fn pool_ids_round_trip_through_version_of_pool() {
        assert_eq!(pool_id("8.4.25"), "php-pool-8.4.25");
        assert_eq!(version_of_pool("php-pool-8.4.25"), Some("8.4.25"));
        assert!(is_pool_id("php-pool-8.4.25"));
        assert!(!is_pool_id("nginx"));
        assert!(!is_pool_id("php-pool-"), "a bare prefix is not a pool");
    }

    #[test]
    fn worker_bounds_are_enforced() {
        assert!(validate_workers(1).is_ok());
        assert!(validate_workers(MAX_WORKERS).is_ok());
        assert!(validate_workers(0).is_err());
        assert!(validate_workers(MAX_WORKERS + 1).is_err());
    }

    #[test]
    fn plan_targets_php_cgi_with_the_requested_port_and_workers() {
        let plan = plan(DEFAULT_WORKERS);

        assert_eq!(plan.id, "php-pool-8.4.25");
        assert_eq!(plan.version, VERSION);
        assert_eq!(plan.port, 9100);
        assert_eq!(plan.workers, DEFAULT_WORKERS);
        assert_eq!(
            plan.program,
            PathBuf::from("C:/devx/data/runtimes/php/8.4.25/php-cgi.exe")
        );

        // `-b` binds FastCGI; `-c` selects the rendered php.ini.
        assert_eq!(plan.args[0], "-b");
        assert_eq!(plan.args[1], "127.0.0.1:9100");
        assert_eq!(plan.args[2], "-c");
        assert_eq!(
            plan.args[3],
            "C:/devx/data/service-config/php-pool-8.4.25/php.ini"
        );

        // The worker count travels through the environment, the php-cgi way.
        assert!(plan
            .env
            .iter()
            .any(|(k, v)| k == "PHP_FCGI_CHILDREN" && v == "4"));
        assert!(plan
            .env
            .iter()
            .any(|(k, v)| k == "PHP_FCGI_MAX_REQUESTS" && v == "500"));
    }

    #[test]
    fn rendered_files_use_forward_slashes_and_carry_the_context() {
        let plan = plan(DEFAULT_WORKERS);

        assert!(
            plan.php_ini
                .contains("error_log = C:/devx/data/logs/php-8.4.25.log"),
            "{}",
            plan.php_ini
        );
        assert!(
            plan.php_ini.contains(
                "session.save_path = \"C:/devx/data/service-data/php-pool-8.4.25/sessions\""
            ),
            "{}",
            plan.php_ini
        );
        assert!(
            !plan.php_ini.contains('\\'),
            "no backslashes: {}",
            plan.php_ini
        );
        assert!(!plan.pool_conf.contains('\\'));

        assert!(
            plan.pool_conf.contains("listen = 127.0.0.1:9100"),
            "{}",
            plan.pool_conf
        );
        assert!(plan.pool_conf.contains("workers = 4"));
    }

    #[test]
    fn worker_count_flows_into_the_plan() {
        let plan = plan(12);
        assert_eq!(plan.workers, 12);
        assert!(plan
            .env
            .iter()
            .any(|(k, v)| k == "PHP_FCGI_CHILDREN" && v == "12"));
        assert!(plan.pool_conf.contains("workers = 12"));
    }

    #[test]
    fn invalid_workers_are_rejected_before_anything_is_rendered() {
        let (install, config, data, logs) = dirs(Path::new("C:/devx/data"));
        let err = plan_pool(
            VERSION,
            &install,
            &config,
            &data,
            &logs,
            &PoolPlanOptions::new(9100).with_workers(0),
        )
        .expect_err("zero workers must be refused");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn summary_carries_only_the_ui_fields() {
        let plan = plan(DEFAULT_WORKERS);
        let summary = plan.summary();

        assert_eq!(
            summary,
            PhpPoolSummary {
                id: "php-pool-8.4.25".into(),
                version: VERSION.into(),
                workers: DEFAULT_WORKERS,
            }
        );
    }

    #[test]
    fn write_pool_files_creates_both_files() {
        let dir = tempfile::tempdir().expect("temp");
        let plan = plan(DEFAULT_WORKERS);

        write_pool_files(dir.path(), &plan).expect("write");

        let ini = std::fs::read_to_string(dir.path().join("php.ini")).expect("ini");
        let pool = std::fs::read_to_string(dir.path().join("pool.conf")).expect("pool");
        assert_eq!(ini, plan.php_ini);
        assert_eq!(pool, plan.pool_conf);
    }

    #[test]
    fn pool_listen_addr_reads_the_written_conf() {
        let dir = tempfile::tempdir().expect("temp");
        let plan = plan(DEFAULT_WORKERS);
        write_pool_files(dir.path(), &plan).expect("write");

        assert_eq!(
            pool_listen_addr(dir.path()).expect("listen"),
            "127.0.0.1:9100"
        );
    }

    #[test]
    fn pool_listen_addr_reports_a_missing_conf() {
        let dir = tempfile::tempdir().expect("temp");
        let err = pool_listen_addr(dir.path()).expect_err("no file, no address");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn two_versions_plan_into_disjoint_directories_and_ports() {
        let root = Path::new("C:/devx/data");
        let older = plan_at(root, &PoolPlanOptions::new(9100));
        let newer = plan_pool(
            "8.5.0",
            &root.join("runtimes/php/8.5.0"),
            &root.join("service-config/php-pool-8.5.0"),
            &root.join("service-data/php-pool-8.5.0"),
            &root.join("logs"),
            &PoolPlanOptions::new(9101),
        )
        .expect("plan second pool");

        assert_ne!(older.id, newer.id);
        assert_ne!(older.args[1], newer.args[1], "pools must not share a port");
        assert_ne!(older.args[3], newer.args[3], "pools must not share an ini");
    }

    #[test]
    fn zend_extensions_load_through_the_zend_directive() {
        assert!(is_zend_extension("php_opcache.dll"));
        assert!(is_zend_extension("php_xdebug.dll"));
        assert!(is_zend_extension("opcache"));
        assert!(!is_zend_extension("php_gd.dll"));
        assert!(!is_zend_extension("php_intl.dll"));
    }

    #[test]
    fn extension_lines_classify_and_render_each_dll() {
        let lines =
            render_extension_lines(&["php_gd.dll".to_owned(), "php_opcache.dll".to_owned()]);

        assert!(lines.contains("extension = php_gd.dll"), "{lines}");
        assert!(
            lines.contains("zend_extension = php_opcache.dll"),
            "{lines}"
        );
        assert_eq!(render_extension_lines(&[]), "");
    }

    #[test]
    fn enabled_extensions_are_rendered_into_the_ini() {
        let plan = plan_at(
            Path::new("C:/devx/data"),
            &PoolPlanOptions::new(9100)
                .with_extensions(vec!["php_gd.dll".to_owned(), "php_opcache.dll".to_owned()]),
        );

        assert!(
            plan.php_ini
                .contains("extension_dir = C:/devx/data/runtimes/php/8.4.25/ext"),
            "{}",
            plan.php_ini
        );
        assert!(
            plan.php_ini.contains("extension = php_gd.dll"),
            "{}",
            plan.php_ini
        );
        assert!(
            plan.php_ini.contains("zend_extension = php_opcache.dll"),
            "{}",
            plan.php_ini
        );
        assert_eq!(plan.extensions, ["php_gd.dll", "php_opcache.dll"]);
    }

    #[test]
    fn lists_php_extension_dlls_from_the_ext_directory() {
        let dir = tempfile::tempdir().expect("temp");
        let ext = dir.path().join("ext");
        std::fs::create_dir(&ext).expect("ext dir");
        for name in [
            "php_intl.dll",
            "php_gd2.DLL",
            "php_xdebug.dll",
            "readme.txt",
        ] {
            std::fs::write(ext.join(name), b"").expect("file");
        }

        let names = list_php_extensions(dir.path()).expect("list");
        assert_eq!(names, ["php_gd2.DLL", "php_intl.dll", "php_xdebug.dll"]);
    }

    #[test]
    fn a_version_without_an_ext_directory_has_no_extensions() {
        let dir = tempfile::tempdir().expect("temp");
        let names = list_php_extensions(dir.path()).expect("list");
        assert!(names.is_empty());
    }
}
