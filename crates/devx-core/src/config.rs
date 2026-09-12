//! User configuration: schema, validation, migration and durable persistence.
//!
//! The on-disk format is TOML with an explicit `schema_version`. Every field has
//! a default, so a partially written or hand-edited file still loads. Unknown
//! keys are ignored rather than rejected, because a config written by a newer
//! DevX must not brick an older one that the user rolled back to.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{fsx, paths::AppPaths, Error, Result};

/// Schema version written by this build.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Default remote catalog describing available component versions.
pub const DEFAULT_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/devx/devx/main/catalog/catalog.json";

/// How local domains are resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DnsMode {
    /// Prefer the bundled resolver with an NRPT rule, fall back to the hosts
    /// file when port 53 is unavailable.
    Auto,
    /// Always use the bundled resolver plus an NRPT rule.
    Resolver,
    /// Always write one hosts-file entry per site. No wildcard subdomains.
    HostsFile,
}

/// UI colour scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    /// Follow the Windows setting.
    System,
    /// Always light.
    Light,
    /// Always dark.
    Dark,
}

/// Application-wide preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct General {
    /// UI colour scheme.
    pub theme: Theme,
    /// Launch DevX when the user signs in.
    pub start_with_windows: bool,
    /// Closing the window hides it to the tray instead of exiting.
    pub close_to_tray: bool,
    /// Start services that were running when DevX last exited.
    pub restore_services_on_start: bool,
    /// Send a Windows notification when a service fails.
    pub notify_on_failure: bool,
}

impl Default for General {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            start_with_windows: false,
            close_to_tray: true,
            restore_services_on_start: true,
            notify_on_failure: true,
        }
    }
}

/// Networking and local domain settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Network {
    /// Suffix for local sites, without a leading dot. `test` is reserved by
    /// RFC 6761 for exactly this purpose and never resolves publicly.
    pub domain_suffix: String,
    /// Port the local web server listens on for HTTP.
    pub http_port: u16,
    /// Port the local web server listens on for HTTPS.
    pub https_port: u16,
    /// Port the bundled DNS resolver binds to.
    pub dns_port: u16,
    /// Strategy used to resolve local domains.
    pub dns_mode: DnsMode,
}

impl Default for Network {
    fn default() -> Self {
        Self {
            domain_suffix: "test".to_owned(),
            http_port: 80,
            https_port: 443,
            dns_port: 53,
            dns_mode: DnsMode::Auto,
        }
    }
}

/// Component download and installation behaviour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Provisioning {
    /// Catalog describing components, versions and artifact hashes.
    pub catalog_url: String,
    /// Keep downloaded archives after a successful install.
    pub keep_archives: bool,
    /// Maximum simultaneous downloads.
    pub max_concurrent_downloads: u8,
    /// Refresh version metadata automatically on startup.
    pub auto_refresh_catalog: bool,
}

impl Default for Provisioning {
    fn default() -> Self {
        Self {
            catalog_url: DEFAULT_CATALOG_URL.to_owned(),
            keep_archives: false,
            max_concurrent_downloads: 2,
            auto_refresh_catalog: true,
        }
    }
}

/// One user-configured site.
///
/// Stored in `config.toml` under `[[sites]]`; rendered into nginx server
/// blocks by `devx-provision::sites` whenever the configuration changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Site {
    /// Host name served, e.g. `myapp.test`.
    pub hostname: String,
    /// Absolute path of the folder nginx serves.
    pub docroot: String,
    /// PHP version whose pool serves the site, empty for a static site.
    pub php_version: String,
    /// Serve the site over HTTPS with the local CA's certificate.
    #[serde(default)]
    pub https: bool,
    /// Environment variables passed to the site's PHP requests, rendered as
    /// `fastcgi_param` lines in the site's nginx block. Static sites ignore
    /// them.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Additional host names the site answers to, rendered into the nginx
    /// `server_name` list. Subdomain wildcards are covered by the resolver.
    #[serde(default)]
    pub aliases: Vec<String>,
}

impl Site {
    /// The PHP version as an `Option`, empty meaning static.
    pub fn php(&self) -> Option<&str> {
        match self.php_version.as_str() {
            "" => None,
            version => Some(version),
        }
    }
}

/// Bounds on per-site environment variables.
pub const MAX_SITE_ENV_VARS: usize = 64;
/// Longest single environment value accepted.
pub const MAX_SITE_ENV_VALUE: usize = 4096;

/// Worker counts for PHP FastCGI pools, keyed by PHP version.
///
/// A pool is created per installed PHP version; this map remembers the
/// worker count each pool was started with so the Services page and the next
/// start agree. A version missing from the map uses the default worker
/// count, so uninstalling PHP or resetting settings needs no cleanup here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PhpPools(
    /// Pool worker counts keyed by PHP version.
    pub std::collections::BTreeMap<String, u32>,
);

impl PhpPools {
    /// The worker count for `version`, when one was stored.
    pub fn get(&self, version: &str) -> Option<u32> {
        self.0.get(version).copied()
    }

    /// Records the worker count for `version`.
    pub fn insert(&mut self, version: impl Into<String>, workers: u32) {
        self.0.insert(version.into(), workers);
    }
}

/// Enabled PHP extensions, keyed by PHP version.
///
/// Entries are the exact DLL file names found in the version's `ext/`
/// directory (e.g. `php_gd.dll`), because that is what the rendered
/// `extension =` directive must spell. A version missing from the map has no
/// extensions enabled, so uninstalling PHP or resetting settings needs no
/// cleanup here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PhpExtensions(
    /// Enabled extension DLL names keyed by PHP version.
    pub std::collections::BTreeMap<String, Vec<String>>,
);

impl PhpExtensions {
    /// The enabled extensions for `version`, empty when none.
    pub fn get(&self, version: &str) -> &[String] {
        self.0.get(version).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Enables `extension` for `version`; idempotent.
    pub fn enable(&mut self, version: &str, extension: impl Into<String>) {
        let entry = self.0.entry(version.to_owned()).or_default();
        let extension = extension.into();
        if !entry.contains(&extension) {
            entry.push(extension);
        }
    }

    /// Disables `extension` for `version`; removing the last one leaves an
    /// empty entry, which is harmless.
    pub fn disable(&mut self, version: &str, extension: &str) {
        if let Some(extensions) = self.0.get_mut(version) {
            extensions.retain(|name| name != extension);
        }
    }
}

/// One user-configured supervised worker process.
///
/// Stored under `[[workers]]`. Either `program` (a path or a name on `PATH`)
/// or `php_version` (runs that installed version's `php.exe`) must be set —
/// never both — and `instances` identical copies run side by side, each its
/// own supervised process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Worker {
    /// Unique short name, also used to build the service id.
    pub name: String,
    /// Executable to run, when not using a DevX-managed PHP version.
    pub program: Option<String>,
    /// PHP version whose `php.exe` runs the worker, when using one.
    pub php_version: Option<String>,
    /// Arguments passed to the program.
    pub args: Vec<String>,
    /// Absolute path the process runs in.
    pub working_dir: String,
    /// How many copies to run.
    pub instances: u32,
}

/// Bounds on worker names and instance counts.
pub const MAX_WORKERS: usize = 64;
/// Maximum instances per worker.
pub const MAX_INSTANCES: u32 = 8;

/// One user-configured scheduled task, run by Windows every N minutes.
///
/// Stored under `[[cron]]`. The shape mirrors [`Worker`] minus instances —
/// a scheduled run is a one-shot command, not a supervised process — with
/// `every_minutes` driving the Windows task's `/SC MINUTE /MO` interval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CronJob {
    /// Unique short name, prefixed `DevX` in the Windows task list.
    pub name: String,
    /// Executable to run, when not using a DevX-managed PHP version.
    pub program: Option<String>,
    /// PHP version whose `php.exe` runs the task, when using one.
    pub php_version: Option<String>,
    /// Arguments passed to the program.
    pub args: Vec<String>,
    /// Absolute path the task runs in.
    pub working_dir: String,
    /// Minutes between runs, 1..=10080 (a week).
    pub every_minutes: u32,
}

/// Maximum scheduled tasks.
pub const MAX_CRON_JOBS: usize = 64;
/// Maximum minutes between runs: one week.
pub const MAX_CRON_MINUTES: u32 = 7 * 24 * 60;

/// Complete DevX configuration.
///
/// Deliberately has no `#[serde(default)]`: every field is required on the wire
/// so the generated TypeScript type has no optional properties. Robustness for
/// partial or hand-edited files comes from [`merge_over_defaults`], which fills
/// gaps before deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Config {
    /// Version of this document's schema.
    pub schema_version: u32,
    /// Application-wide preferences.
    pub general: General,
    /// Networking and local domain settings.
    pub network: Network,
    /// Component download and installation behaviour.
    pub provisioning: Provisioning,
    /// FastCGI worker counts per installed PHP version.
    pub php_pools: PhpPools,
    /// Enabled PHP extensions per installed PHP version.
    pub php_extensions: PhpExtensions,
    /// User-configured local sites.
    pub sites: Vec<Site>,
    /// User-configured supervised worker processes.
    pub workers: Vec<Worker>,
    /// User-configured scheduled tasks.
    pub cron: Vec<CronJob>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            general: General::default(),
            network: Network::default(),
            provisioning: Provisioning::default(),
            php_pools: PhpPools::default(),
            php_extensions: PhpExtensions::default(),
            sites: Vec::new(),
            workers: Vec::new(),
            cron: Vec::new(),
        }
    }
}

impl Config {
    /// Checks invariants that the type system cannot express.
    ///
    /// Called before every save so an invalid configuration never reaches disk,
    /// and after every load so a hand-edited file fails loudly.
    pub fn validate(&self) -> Result<()> {
        validate_domain_suffix(&self.network.domain_suffix)?;

        for (label, port) in [
            ("network.http_port", self.network.http_port),
            ("network.https_port", self.network.https_port),
            ("network.dns_port", self.network.dns_port),
        ] {
            if port == 0 {
                return Err(Error::invalid_input(format!("{label} must not be 0")));
            }
        }

        if self.network.http_port == self.network.https_port {
            return Err(Error::invalid_input(
                "network.http_port and network.https_port must differ",
            ));
        }

        if !(1..=8).contains(&self.provisioning.max_concurrent_downloads) {
            return Err(Error::invalid_input(
                "provisioning.max_concurrent_downloads must be between 1 and 8",
            ));
        }

        if !self.provisioning.catalog_url.starts_with("https://") {
            return Err(
                Error::invalid_input("provisioning.catalog_url must use https")
                    .with_hint("component hashes come from this URL, so it must be authenticated"),
            );
        }

        for (version, workers) in &self.php_pools.0 {
            if *workers == 0 || *workers > 32 {
                return Err(Error::invalid_input(format!(
                    "php_pools.\"{version}\" must be between 1 and 32 workers"
                )));
            }
        }

        let mut hostnames = std::collections::BTreeSet::new();
        for site in &self.sites {
            if !hostnames.insert(site.hostname.to_ascii_lowercase()) {
                return Err(Error::invalid_input(format!(
                    "duplicate site hostname `{}`",
                    site.hostname
                )));
            }
            validate_hostname(&site.aliases)?;
            for alias in &site.aliases {
                if !hostnames.insert(alias.to_ascii_lowercase()) {
                    return Err(Error::invalid_input(format!(
                        "duplicate host name `{alias}`"
                    )));
                }
            }
            validate_site_env(&site.env)?;
        }
        if self.sites.len() > 256 {
            return Err(Error::invalid_input("at most 256 sites are supported"));
        }

        let mut cron_names = std::collections::BTreeSet::new();
        for job in &self.cron {
            if !cron_names.insert(job.name.to_ascii_lowercase()) {
                return Err(Error::invalid_input(format!(
                    "duplicate cron job name `{}`",
                    job.name
                )));
            }
            validate_cron(job)?;
        }
        if self.cron.len() > MAX_CRON_JOBS {
            return Err(Error::invalid_input(format!(
                "at most {MAX_CRON_JOBS} cron jobs are supported"
            )));
        }

        let mut names = std::collections::BTreeSet::new();
        for worker in &self.workers {
            if !names.insert(worker.name.to_ascii_lowercase()) {
                return Err(Error::invalid_input(format!(
                    "duplicate worker name `{}`",
                    worker.name
                )));
            }
            validate_worker(worker)?;
        }
        if self.workers.len() > MAX_WORKERS {
            return Err(Error::invalid_input(format!(
                "at most {MAX_WORKERS} workers are supported"
            )));
        }

        Ok(())
    }
}

/// Validates site alias host names: each must be a dot-separated host name,
/// and no alias may repeat any other alias or site host name.
fn validate_hostname(aliases: &[String]) -> Result<()> {
    for alias in aliases {
        let valid = !alias.is_empty()
            && alias.len() <= 253
            && alias.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            });
        if !valid {
            return Err(Error::invalid_input(format!(
                "`{alias}` is not a usable host name alias (lowercase letters, digits, hyphens, dot-separated)"
            )));
        }
    }
    Ok(())
}

/// Validates one cron job definition.
fn validate_cron(job: &CronJob) -> Result<()> {
    let valid_name = !job.name.is_empty()
        && job.name.len() <= 63
        && job
            .name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !job.name.starts_with('-')
        && !job.name.ends_with('-');
    if !valid_name {
        return Err(Error::invalid_input(format!(
            "cron job name `{}` must be a single lowercase DNS label (letters, digits, hyphens)",
            job.name
        )));
    }

    match (job.program.as_deref(), job.php_version.as_deref()) {
        (Some(program), None) if !program.trim().is_empty() => {}
        (None, Some(version)) if !version.trim().is_empty() => {}
        (Some(_), Some(_)) => {
            return Err(Error::invalid_input(format!(
                "cron job `{}` must set either program or php_version, not both",
                job.name
            )));
        }
        _ => {
            return Err(Error::invalid_input(format!(
                "cron job `{}` must set program or php_version",
                job.name
            )));
        }
    }

    if job.working_dir.trim().is_empty() || !Path::new(&job.working_dir).is_absolute() {
        return Err(Error::invalid_input(format!(
            "cron job `{}` must set an absolute working_dir",
            job.name
        )));
    }
    if job.args.len() > 64 {
        return Err(Error::invalid_input(format!(
            "cron job `{}` has too many arguments ({} > 64)",
            job.name,
            job.args.len()
        )));
    }
    if !(1..=MAX_CRON_MINUTES).contains(&job.every_minutes) {
        return Err(Error::invalid_input(format!(
            "cron job `{}` must run between 1 and {MAX_CRON_MINUTES} minutes",
            job.name
        )));
    }

    Ok(())
}

/// Validates a site's environment variable map.
///
/// Keys must look like environment variable names (`A_Z`, no leading digit),
/// values must be free of newlines and nginx configuration metacharacters —
/// they land inside double quotes in a `fastcgi_param` directive, so a `"` or
/// `$` would either break the block or be interpolated by nginx.
fn validate_site_env(env: &std::collections::BTreeMap<String, String>) -> Result<()> {
    if env.len() > MAX_SITE_ENV_VARS {
        return Err(Error::invalid_input(format!(
            "at most {MAX_SITE_ENV_VARS} environment variables per site are supported"
        )));
    }

    for (key, value) in env {
        let valid_key = !key.is_empty()
            && !key.chars().next().is_some_and(|c| c.is_ascii_digit())
            && key.bytes().all(|b| {
                b.is_ascii_uppercase()
                    || b.is_ascii_lowercase()
                    || b == b'_'
                    || (b.is_ascii_digit())
            });
        if !valid_key {
            return Err(Error::invalid_input(format!(
                "`{key}` is not a usable environment variable name (letters, digits, underscores; no leading digit)"
            )));
        }

        if value.len() > MAX_SITE_ENV_VALUE {
            return Err(Error::invalid_input(format!(
                "environment variable `{key}` exceeds {MAX_SITE_ENV_VALUE} bytes"
            )));
        }
        if value.contains('\n') || value.contains('\r') {
            return Err(Error::invalid_input(format!(
                "environment variable `{key}` must not contain newlines"
            )));
        }
        if value.contains('"') || value.contains('$') {
            return Err(Error::invalid_input(format!(
                "environment variable `{key}` must not contain `\"` or `$`"
            )));
        }
    }

    Ok(())
}

/// Validates one worker definition.
fn validate_worker(worker: &Worker) -> Result<()> {
    let valid_name = !worker.name.is_empty()
        && worker.name.len() <= 63
        && worker
            .name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !worker.name.starts_with('-')
        && !worker.name.ends_with('-');
    if !valid_name {
        return Err(Error::invalid_input(format!(
            "worker name `{}` must be a single lowercase DNS label (letters, digits, hyphens)",
            worker.name
        )));
    }

    match (worker.program.as_deref(), worker.php_version.as_deref()) {
        (Some(program), None) => {
            if program.trim().is_empty() {
                return Err(Error::invalid_input(format!(
                    "worker `{}` has an empty program",
                    worker.name
                )));
            }
        }
        (None, Some(version)) => {
            if version.trim().is_empty() {
                return Err(Error::invalid_input(format!(
                    "worker `{}` has an empty php_version",
                    worker.name
                )));
            }
        }
        (Some(_), Some(_)) => {
            return Err(Error::invalid_input(format!(
                "worker `{}` must set either program or php_version, not both",
                worker.name
            )));
        }
        (None, None) => {
            return Err(Error::invalid_input(format!(
                "worker `{}` must set program or php_version",
                worker.name
            )));
        }
    }

    if worker.working_dir.trim().is_empty() {
        return Err(Error::invalid_input(format!(
            "worker `{}` must set working_dir",
            worker.name
        )));
    }
    if !Path::new(&worker.working_dir).is_absolute() {
        return Err(Error::invalid_input(format!(
            "worker `{}` working_dir must be an absolute path",
            worker.name
        )));
    }

    if worker.args.len() > 64 {
        return Err(Error::invalid_input(format!(
            "worker `{}` has too many arguments ({} > 64)",
            worker.name,
            worker.args.len()
        )));
    }
    if !(1..=MAX_INSTANCES).contains(&worker.instances) {
        return Err(Error::invalid_input(format!(
            "worker `{}` instances must be between 1 and {MAX_INSTANCES}",
            worker.name
        )));
    }

    Ok(())
}

/// Validates a local domain suffix such as `test`.
///
/// Rejects anything that is not a single DNS label: dots would make site domains
/// ambiguous, and uppercase or unusual characters break nginx `server_name`
/// matching and certificate SANs.
fn validate_domain_suffix(suffix: &str) -> Result<()> {
    if suffix.is_empty() {
        return Err(
            Error::invalid_input("network.domain_suffix must not be empty")
                .with_hint("`test` is the recommended value"),
        );
    }

    if suffix.len() > 63 {
        return Err(Error::invalid_input(
            "network.domain_suffix must be at most 63 characters",
        ));
    }

    if suffix.contains('.') {
        return Err(Error::invalid_input(
            "network.domain_suffix must be a single label without dots",
        )
        .with_hint("use `test`, not `.test` or `dev.local`"));
    }

    let valid = suffix
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(Error::invalid_input(
            "network.domain_suffix may only contain lowercase letters, digits and hyphens",
        ));
    }

    if suffix.starts_with('-') || suffix.ends_with('-') {
        return Err(Error::invalid_input(
            "network.domain_suffix must not start or end with a hyphen",
        ));
    }

    Ok(())
}

/// Renders [`Config::default`] as a TOML table.
///
/// Used as the base layer that a user's document is merged onto.
fn default_document() -> Result<toml::Table> {
    let value = toml::Value::try_from(Config::default())
        .map_err(|err| Error::internal(format!("failed to encode default config: {err}")))?;

    match value {
        toml::Value::Table(table) => Ok(table),
        other => Err(Error::internal(format!(
            "default config encoded as {} rather than a table",
            other.type_str()
        ))),
    }
}

/// Overlays `overlay` onto the default document, recursing into sub-tables.
///
/// A missing key keeps the default; a present key wins. Recursing (rather than
/// replacing whole tables) is what lets a file that sets only
/// `network.http_port` keep every other network default.
pub fn merge_over_defaults(overlay: toml::Table) -> Result<toml::Table> {
    let mut base = default_document()?;
    merge_tables(&mut base, overlay);
    Ok(base)
}

/// Recursively merges `overlay` into `base`.
fn merge_tables(base: &mut toml::Table, overlay: toml::Table) {
    for (key, value) in overlay {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(base_table)), toml::Value::Table(overlay_table)) => {
                merge_tables(base_table, overlay_table);
            }
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

/// A single forward migration of the raw TOML document.
pub struct Migration {
    /// Schema version produced by applying this migration.
    pub to_version: u32,
    /// Transformation applied to the document.
    pub apply: fn(&mut toml::Table) -> Result<()>,
}

/// Migrations shipped by this build, ordered by `to_version`.
///
/// Empty at schema version 1. When the schema changes, bump
/// [`CURRENT_SCHEMA_VERSION`] and append a migration here rather than editing
/// the struct definitions in place.
pub const MIGRATIONS: &[Migration] = &[];

/// Applies migrations until the document reaches `target_version`.
///
/// Returns the version the document ended up at.
///
/// # Errors
///
/// Fails when the document is newer than this build understands, or when a
/// migration step is missing so the chain cannot be completed.
pub fn migrate_document(
    document: &mut toml::Table,
    target_version: u32,
    migrations: &[Migration],
) -> Result<u32> {
    let mut version = match document.get("schema_version") {
        Some(value) => value
            .as_integer()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| {
                Error::config("schema_version must be a non-negative integer")
                    .with_hint("delete the file to regenerate a default configuration")
            })?,
        // Written by hand: assume it matches this build and let validation
        // catch anything genuinely wrong.
        None => {
            tracing::warn!("configuration has no schema_version; assuming {target_version}");
            target_version
        }
    };

    if version > target_version {
        return Err(Error::config(format!(
            "configuration schema version {version} is newer than this DevX build supports ({target_version})"
        ))
        .with_hint("update DevX, or delete the configuration file to start fresh"));
    }

    while version < target_version {
        let step = migrations
            .iter()
            .find(|migration| migration.to_version == version + 1)
            .ok_or_else(|| {
                Error::config(format!(
                    "no migration from configuration schema version {version} to {}",
                    version + 1
                ))
            })?;

        (step.apply)(document)?;
        version = step.to_version;
        document.insert(
            "schema_version".to_owned(),
            toml::Value::Integer(i64::from(version)),
        );
    }

    Ok(version)
}

/// Serializes a configuration to TOML text, for export.
///
/// The inverse of [`parse_config`]: its output parses back to an equal
/// configuration.
///
/// # Errors
///
/// Fails when the configuration cannot be encoded, which indicates a build
/// defect rather than a user problem.
pub fn serialize_config(config: &Config) -> Result<String> {
    toml::to_string_pretty(config)
        .map_err(|err| Error::config(format!("failed to serialize configuration: {err}")))
}

/// Owns the configuration file and mediates all reads and writes.
#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
    config: Config,
}

/// Parses a configuration document from TOML text.
///
/// Used by import: the text may come from another machine or an older schema,
/// so it travels the same migration, merge-over-defaults and validation path
/// a file on disk receives. Missing sections fall back to defaults; invalid
/// values are refused.
///
/// # Errors
///
/// Fails when the text is not TOML, is newer than this build understands, or
/// fails [`Config::validate`].
pub fn parse_config(body: &str) -> Result<Config> {
    let mut document: toml::Table = toml::from_str(body).map_err(|err| {
        Error::config(format!("the configuration is not valid TOML: {err}"))
            .with_hint("check the syntax; an exported configuration parses as-is")
    })?;

    migrate_document(&mut document, CURRENT_SCHEMA_VERSION, MIGRATIONS)?;
    let merged = merge_over_defaults(document)?;

    let mut config: Config = toml::Value::Table(merged).try_into().map_err(|err| {
        Error::config(format!("the configuration has unexpected contents: {err}"))
            .with_hint("check the value types")
    })?;
    config.schema_version = CURRENT_SCHEMA_VERSION;
    config.validate()?;
    Ok(config)
}

impl ConfigStore {
    /// Loads configuration for `paths`, creating a default file when absent.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be parsed, migrated or validated.
    /// A missing file is not an error.
    pub fn load(paths: &AppPaths) -> Result<Self> {
        Self::load_from(paths.config_file())
    }

    /// Builds a store holding defaults, without reading or writing anything.
    ///
    /// Used when the file on disk is unusable: DevX keeps running on defaults
    /// and leaves the broken file in place for the user to inspect.
    pub fn defaults_at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            config: Config::default(),
        }
    }

    /// Loads configuration from an explicit path.
    pub fn load_from(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();

        let Some(raw) = read_if_exists(&path)? else {
            tracing::info!(path = %path.display(), "no configuration found; writing defaults");
            let store = Self {
                path,
                config: Config::default(),
            };
            store.save()?;
            return Ok(store);
        };

        let mut document: toml::Table = toml::from_str(&raw).map_err(|err| {
            Error::config(format!("{} is not valid TOML: {err}", path.display()))
                .with_hint("fix the syntax, or delete the file to regenerate defaults")
        })?;

        let version_on_disk = document
            .get("schema_version")
            .and_then(toml::Value::as_integer)
            .and_then(|value| u32::try_from(value).ok());

        migrate_document(&mut document, CURRENT_SCHEMA_VERSION, MIGRATIONS)?;

        let merged = merge_over_defaults(document)?;

        let mut config: Config = toml::Value::Table(merged).try_into().map_err(|err| {
            Error::config(format!("{} has unexpected contents: {err}", path.display()))
                .with_hint("check the value types; delete the file to restore defaults")
        })?;
        config.schema_version = CURRENT_SCHEMA_VERSION;

        config.validate()?;

        let store = Self { path, config };

        // Rewrite the file when it was migrated or predates schema stamping, so
        // the next load has no work to do.
        if version_on_disk != Some(CURRENT_SCHEMA_VERSION) {
            store.save()?;
        }

        Ok(store)
    }

    /// The loaded configuration.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Path of the backing file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Replaces the configuration after validating it.
    ///
    /// The in-memory value is only updated once the write succeeds, so a failed
    /// save leaves DevX running with exactly what is on disk.
    pub fn replace(&mut self, config: Config) -> Result<()> {
        let mut config = config;
        config.schema_version = CURRENT_SCHEMA_VERSION;
        config.validate()?;

        let previous = std::mem::replace(&mut self.config, config);
        match self.save() {
            Ok(()) => Ok(()),
            Err(err) => {
                self.config = previous;
                Err(err)
            }
        }
    }

    /// Mutates the configuration through `edit`, then validates and saves it.
    pub fn update(&mut self, edit: impl FnOnce(&mut Config)) -> Result<()> {
        let mut candidate = self.config.clone();
        edit(&mut candidate);
        self.replace(candidate)
    }

    /// Serializes the current configuration to disk atomically.
    pub fn save(&self) -> Result<()> {
        let body = toml::to_string_pretty(&self.config)
            .map_err(|err| Error::config(format!("failed to serialize configuration: {err}")))?;

        let contents = format!(
            "# DevX configuration.\n\
             # Managed by the app; hand edits are preserved but validated on load.\n\
             # Delete this file to restore defaults.\n\n{body}"
        );

        fsx::write_atomic(&self.path, contents)
    }
}

/// Reads a file, mapping "not found" to `None` instead of an error.
fn read_if_exists(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(Error::config(format!(
            "failed to read {}: {err}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn temp_store() -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());
        let store = ConfigStore::load(&paths).expect("load default config");
        (dir, store)
    }

    #[test]
    fn defaults_are_valid() {
        Config::default()
            .validate()
            .expect("defaults must validate");
    }

    #[test]
    fn missing_file_is_created_with_defaults() {
        let (_dir, store) = temp_store();

        assert!(store.path().is_file(), "config file should be created");
        assert_eq!(store.config(), &Config::default());
        let raw = std::fs::read_to_string(store.path()).expect("read");
        assert!(
            raw.contains("schema_version = 1"),
            "schema version must be recorded:\n{raw}"
        );
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());

        let mut store = ConfigStore::load(&paths).expect("load");
        store
            .update(|config| {
                config.network.domain_suffix = "localhost-dev".to_owned();
                config.network.http_port = 8080;
                config.general.theme = Theme::Dark;
                config.provisioning.max_concurrent_downloads = 4;
            })
            .expect("update");

        let reloaded = ConfigStore::load(&paths).expect("reload");
        assert_eq!(reloaded.config(), store.config());
        assert_eq!(reloaded.config().network.domain_suffix, "localhost-dev");
        assert_eq!(reloaded.config().network.http_port, 8080);
        assert_eq!(reloaded.config().general.theme, Theme::Dark);
    }

    #[test]
    fn partial_file_fills_in_defaults() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "schema_version = 1\n\n[network]\nhttp_port = 8080\n").expect("seed");

        let store = ConfigStore::load_from(&path).expect("load");

        assert_eq!(store.config().network.http_port, 8080);
        // Untouched values fall back to defaults rather than failing to parse.
        assert_eq!(store.config().network.domain_suffix, "test");
        assert_eq!(store.config().general, General::default());
    }

    #[test]
    fn merge_keeps_unset_defaults_and_recurses_into_tables() {
        let overlay: toml::Table =
            toml::from_str("[network]\nhttp_port = 8080\n").expect("parse overlay");

        let merged = merge_over_defaults(overlay).expect("merge");
        let config: Config = toml::Value::Table(merged).try_into().expect("deserialize");

        assert_eq!(config.network.http_port, 8080);
        assert_eq!(config.network.https_port, 443, "sibling keys survive");
        assert_eq!(config.general, General::default(), "other tables survive");
    }

    #[test]
    fn wrong_value_type_is_reported_as_a_config_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "schema_version = 1\n\n[network]\nhttp_port = \"eighty\"\n",
        )
        .expect("seed");

        let err = ConfigStore::load_from(&path).expect_err("a string port must be refused");
        assert_eq!(err.code, crate::ErrorCode::Config);
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "schema_version = 1\nfuture_toggle = true\n\n[network]\nfuture_port = 9\n",
        )
        .expect("seed");

        let store = ConfigStore::load_from(&path).expect("a newer key must not break loading");
        assert_eq!(store.config().network.domain_suffix, "test");
    }

    #[test]
    fn newer_schema_version_is_rejected() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "schema_version = 9999\n").expect("seed");

        let err = ConfigStore::load_from(&path).expect_err("must refuse a newer schema");
        assert_eq!(err.code, crate::ErrorCode::Config);
        assert!(
            err.message.contains("newer than this DevX build"),
            "unexpected message: {}",
            err.message
        );
    }

    #[test]
    fn invalid_file_is_rejected_with_actionable_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "this is not = = toml").expect("seed");

        let err = ConfigStore::load_from(&path).expect_err("must refuse invalid TOML");
        assert_eq!(err.code, crate::ErrorCode::Config);
        assert!(err.hint.is_some(), "parse failures need a hint");
    }

    #[test]
    fn hand_edited_invalid_value_fails_on_load() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "schema_version = 1\n\n[network]\ndomain_suffix = \".test\"\n",
        )
        .expect("seed");

        let err = ConfigStore::load_from(&path).expect_err("must reject a dotted suffix");
        assert_eq!(err.code, crate::ErrorCode::InvalidInput);
    }

    #[test]
    fn rejected_update_leaves_disk_and_memory_unchanged() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());
        let mut store = ConfigStore::load(&paths).expect("load");
        let before = store.config().clone();

        let err = store
            .update(|config| config.network.domain_suffix = "Not Valid".to_owned())
            .expect_err("must reject an invalid suffix");

        assert_eq!(err.code, crate::ErrorCode::InvalidInput);
        assert_eq!(store.config(), &before, "memory must be unchanged");
        assert_eq!(
            ConfigStore::load(&paths).expect("reload").config(),
            &before,
            "disk must be unchanged"
        );
    }

    #[test]
    fn validation_rejects_conflicting_ports() {
        let mut config = Config::default();
        config.network.https_port = config.network.http_port;

        let err = config.validate().expect_err("ports must differ");
        assert!(err.message.contains("must differ"), "{}", err.message);
    }

    #[test]
    fn validation_rejects_insecure_catalog_url() {
        let mut config = Config::default();
        config.provisioning.catalog_url = "http://example.com/catalog.json".to_owned();

        let err = config.validate().expect_err("http must be refused");
        assert_eq!(err.code, crate::ErrorCode::InvalidInput);
    }

    fn worker_named(name: &str) -> Worker {
        Worker {
            name: name.to_owned(),
            program: Some(r"C:\tools\worker.exe".to_owned()),
            php_version: None,
            args: vec!["--loop".to_owned()],
            working_dir: r"C:\project".to_owned(),
            instances: 1,
        }
    }

    #[test]
    fn valid_worker_passes_validation() {
        let mut config = Config::default();
        config.workers.push(worker_named("laravel-queue"));

        config.validate().expect("a well-formed worker must pass");
    }

    #[test]
    fn worker_validation_rejects_bad_names() {
        for name in ["", "Has Caps", "-lead", "trail-", "with_underscore"] {
            let mut config = Config::default();
            config.workers.push(worker_named(name));
            assert!(
                config.validate().is_err(),
                "worker name {name:?} should be rejected"
            );
        }
    }

    #[test]
    fn worker_validation_rejects_duplicate_names() {
        let mut config = Config::default();
        config.workers.push(worker_named("queue"));
        config.workers.push(worker_named("queue"));

        let err = config.validate().expect_err("duplicates must be rejected");
        assert!(err.message.contains("duplicate"), "{}", err.message);
    }

    #[test]
    fn worker_validation_requires_exactly_one_program_source() {
        let mut config = Config::default();

        let mut neither = worker_named("a");
        neither.program = None;
        config.workers.push(neither);

        let err = config.validate().expect_err("no program source must fail");
        assert!(err.message.contains("must set program"), "{}", err.message);

        let mut both = worker_named("b");
        both.php_version = Some("8.4".to_owned());
        config.workers.clear();
        config.workers.push(both);

        let err = config.validate().expect_err("two sources must fail");
        assert!(err.message.contains("not both"), "{}", err.message);
    }

    #[test]
    fn worker_validation_bounds_instances_and_working_dir() {
        let mut config = Config::default();

        let mut many = worker_named("many");
        many.instances = MAX_INSTANCES + 1;
        config.workers.push(many);
        assert!(config.validate().is_err(), "instances above the cap");

        let mut relative = worker_named("relative");
        relative.working_dir = "relative/path".to_owned();
        config.workers.clear();
        config.workers.push(relative);
        let err = config
            .validate()
            .expect_err("a relative working_dir must be rejected");
        assert!(err.message.contains("absolute"), "{}", err.message);
    }

    #[test]
    fn php_extensions_enable_and_disable() {
        let mut extensions = PhpExtensions::default();
        assert!(extensions.get("8.4").is_empty());

        extensions.enable("8.4", "php_gd.dll");
        extensions.enable("8.4", "php_gd.dll");
        assert_eq!(extensions.get("8.4"), ["php_gd.dll".to_owned()]);

        extensions.disable("8.4", "php_gd.dll");
        assert!(extensions.get("8.4").is_empty());
    }

    #[test]
    fn site_env_validation_accepts_and_rejects_the_right_shapes() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("APP_ENV".to_owned(), "local".to_owned());
        env.insert("DB_HOST".to_owned(), "127.0.0.1".to_owned());
        validate_site_env(&env).expect("well-formed vars must pass");

        let mut bad_key = std::collections::BTreeMap::new();
        bad_key.insert("has space".to_owned(), "x".to_owned());
        assert!(validate_site_env(&bad_key).is_err());

        let mut leading_digit = std::collections::BTreeMap::new();
        leading_digit.insert("1KEY".to_owned(), "x".to_owned());
        assert!(validate_site_env(&leading_digit).is_err());

        let mut newline = std::collections::BTreeMap::new();
        newline.insert("KEY".to_owned(), "line\nbreak".to_owned());
        assert!(validate_site_env(&newline).is_err());

        let mut metachar = std::collections::BTreeMap::new();
        metachar.insert("KEY".to_owned(), "a\"b".to_owned());
        assert!(validate_site_env(&metachar).is_err());
    }

    #[test]
    fn site_env_survives_a_config_round_trip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = AppPaths::rooted_at(dir.path());

        let mut store = ConfigStore::load(&paths).expect("load");
        store
            .update(|config| {
                config.sites.push(Site {
                    hostname: "app.test".to_owned(),
                    docroot: r"C:\src\app\public".to_owned(),
                    php_version: "8.4".to_owned(),
                    https: false,
                    env: [("APP_ENV".to_owned(), "local".to_owned())].into(),
                    aliases: vec!["app.local.test".to_owned()],
                });
            })
            .expect("update");

        let reloaded = ConfigStore::load(&paths).expect("reload");
        assert_eq!(
            reloaded.config().sites[0]
                .env
                .get("APP_ENV")
                .map(String::as_str),
            Some("local")
        );
    }

    #[test]
    fn domain_suffix_validation_accepts_and_rejects_the_right_shapes() {
        for good in ["test", "localhost", "dev-local", "x", "a1"] {
            validate_domain_suffix(good).unwrap_or_else(|err| panic!("{good} rejected: {err}"));
        }

        for bad in [
            "",
            ".test",
            "dev.local",
            "TEST",
            "-dev",
            "dev-",
            "dev_local",
        ] {
            assert!(
                validate_domain_suffix(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    // --- migration engine -------------------------------------------------

    /// Migrations used only by tests, standing in for future real ones.
    fn test_migrations() -> Vec<Migration> {
        vec![
            Migration {
                to_version: 2,
                apply: |document| {
                    // Simulates moving a top-level key under a table.
                    if let Some(value) = document.remove("legacy_suffix") {
                        let network = document
                            .entry("network".to_owned())
                            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
                        if let Some(table) = network.as_table_mut() {
                            table.insert("domain_suffix".to_owned(), value);
                        }
                    }
                    Ok(())
                },
            },
            Migration {
                to_version: 3,
                apply: |document| {
                    document.insert("added_in_v3".to_owned(), toml::Value::Boolean(true));
                    Ok(())
                },
            },
        ]
    }

    #[test]
    fn migration_chain_runs_every_step_in_order() {
        let mut document: toml::Table =
            toml::from_str("schema_version = 1\nlegacy_suffix = \"old\"\n").expect("parse");

        let version = migrate_document(&mut document, 3, &test_migrations()).expect("migrate");

        assert_eq!(version, 3);
        assert_eq!(
            document["schema_version"].as_integer(),
            Some(3),
            "the document must record the new version"
        );
        assert_eq!(
            document["network"]["domain_suffix"].as_str(),
            Some("old"),
            "the v2 step must have moved the legacy key"
        );
        assert_eq!(document["added_in_v3"].as_bool(), Some(true));
        assert!(!document.contains_key("legacy_suffix"));
    }

    #[test]
    fn migration_stops_at_the_requested_version() {
        let mut document: toml::Table = toml::from_str("schema_version = 1\n").expect("parse");

        let version = migrate_document(&mut document, 2, &test_migrations()).expect("migrate");

        assert_eq!(version, 2);
        assert!(
            !document.contains_key("added_in_v3"),
            "the v3 step must not run"
        );
    }

    #[test]
    fn migration_fails_when_a_step_is_missing() {
        let mut document: toml::Table = toml::from_str("schema_version = 1\n").expect("parse");
        let migrations = vec![Migration {
            to_version: 3,
            apply: |_| Ok(()),
        }];

        let err = migrate_document(&mut document, 3, &migrations)
            .expect_err("a gap in the chain must fail");
        assert!(err.message.contains("no migration from"), "{}", err.message);
    }

    #[test]
    fn migration_is_a_no_op_at_the_current_version() {
        let mut document: toml::Table =
            toml::from_str("schema_version = 3\nkeep = 1\n").expect("parse");

        let version = migrate_document(&mut document, 3, &test_migrations()).expect("migrate");

        assert_eq!(version, 3);
        assert_eq!(document["keep"].as_integer(), Some(1));
    }

    #[test]
    fn migration_rejects_a_non_integer_schema_version() {
        let mut document: toml::Table =
            toml::from_str("schema_version = \"one\"\n").expect("parse");

        let err = migrate_document(&mut document, 1, MIGRATIONS)
            .expect_err("a string version must be refused");
        assert_eq!(err.code, crate::ErrorCode::Config);
    }

    #[test]
    fn missing_schema_version_assumes_the_current_build() {
        let mut document: toml::Table =
            toml::from_str("[network]\nhttp_port = 8080\n").expect("parse");

        let version = migrate_document(&mut document, CURRENT_SCHEMA_VERSION, MIGRATIONS)
            .expect("must not fail");

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }
}
