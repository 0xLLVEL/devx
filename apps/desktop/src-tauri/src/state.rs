//! Shared application state owned by the Tauri runtime.

use std::sync::{Arc, Mutex};

use devx_core::{AppPaths, ConfigHealth, ConfigStore, Result};
use devx_proc::ServiceRegistry;
use devx_provision::{Catalog, HttpClient, Installer, Resolver};

/// State injected into every command handler.
///
/// The configuration store sits behind a `Mutex` because commands run on a
/// thread pool and a settings save must not interleave with a read.
pub struct AppState {
    /// Resolved config and data locations.
    pub paths: AppPaths,
    /// Configuration file, loaded once at startup.
    pub config: Mutex<ConfigStore>,
    /// Whether the file on disk loaded cleanly.
    pub config_health: Mutex<ConfigHealth>,
    /// Components DevX can install.
    pub catalog: Catalog,
    /// Shared HTTP client with its on-disk response cache.
    pub http: HttpClient,
    /// Version resolution against component upstreams.
    pub resolver: Resolver,
    /// Download, verify, extract and install pipeline.
    pub installer: Installer,
    /// Supervised background services.
    pub services: Arc<ServiceRegistry>,
    /// The bundled DNS resolver, once started; `None` until needed and
    /// after a stop, so every reader can tell whether it is running.
    pub dns: Mutex<Option<devx_dns::ServerHandle>>,
}

/// Loads configuration for `paths`, falling back to defaults when unusable.
///
/// Split out from [`AppState::initialise`] so the fallback can be tested without
/// mutating process environment variables.
pub fn load_config_or_defaults(paths: &AppPaths) -> (ConfigStore, ConfigHealth) {
    match ConfigStore::load(paths) {
        Ok(store) => (store, ConfigHealth::Loaded),
        Err(err) => {
            tracing::error!(
                error = %err,
                path = %paths.config_file().display(),
                "configuration is unusable; continuing with defaults"
            );
            (
                ConfigStore::defaults_at(paths.config_file()),
                ConfigHealth::Invalid {
                    message: err.message.clone(),
                    hint: err.hint.clone(),
                },
            )
        }
    }
}

impl AppState {
    /// Resolves paths, creates the directory layout and loads configuration.
    ///
    /// A configuration file that cannot be parsed or validated is **not** fatal:
    /// DevX starts on in-memory defaults, leaves the file untouched, and reports
    /// the problem through diagnostics. Refusing to launch would leave the user
    /// with no way to fix the file from the app that wrote it.
    ///
    /// # Errors
    ///
    /// Fails only when the directory layout cannot be created, which means DevX
    /// has nowhere to store anything and genuinely cannot run.
    pub fn initialise() -> Result<Self> {
        let paths = AppPaths::discover()?;
        paths.ensure_dirs()?;

        tracing::info!(
            config_dir = %paths.config_dir.display(),
            data_dir = %paths.data_dir.display(),
            "resolved DevX directories"
        );

        let (config, config_health) = load_config_or_defaults(&paths);

        // The catalog is embedded in the binary, so a parse failure is a build
        // defect rather than a user problem; the crate's tests guard it.
        let catalog = Catalog::embedded()?;

        let http = HttpClient::new(paths.cache_dir().join("http"))?;
        let resolver = Resolver::new(http.clone());

        let keep_archives = config.config().provisioning.keep_archives;
        let installer = Installer::new(paths.clone(), http.clone())?.keep_archives(keep_archives);

        tracing::info!(
            components = catalog.components.len(),
            "loaded component catalog"
        );

        Ok(Self {
            paths,
            config: Mutex::new(config),
            config_health: Mutex::new(config_health),
            catalog,
            http,
            resolver,
            installer,
            services: Arc::new(ServiceRegistry::new()),
            dns: Mutex::new(None),
        })
    }

    /// Whether the bundled DNS resolver is currently running.
    pub fn dns_running(&self) -> bool {
        self.dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// Runs `read` against the configuration store.
    ///
    /// Recovers from a poisoned lock: a panic in an unrelated command must not
    /// make settings permanently inaccessible.
    pub fn with_config<T>(&self, read: impl FnOnce(&ConfigStore) -> T) -> T {
        let guard = self
            .config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        read(&guard)
    }

    /// Runs `write` against the configuration store.
    pub fn with_config_mut<T>(&self, write: impl FnOnce(&mut ConfigStore) -> T) -> T {
        let mut guard = self
            .config
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        write(&mut guard)
    }

    /// Current configuration health.
    pub fn config_health(&self) -> ConfigHealth {
        self.config_health
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Records that the configuration on disk is now known good.
    ///
    /// Called after a successful save, which is how a user recovers from a
    /// broken file without restarting DevX.
    pub fn mark_config_healthy(&self) {
        let mut guard = self
            .config_health
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = ConfigHealth::Loaded;
    }
}
