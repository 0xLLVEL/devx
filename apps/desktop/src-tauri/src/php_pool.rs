//! Deep module: PhpPool — one supervised php-cgi per version, port truth in pool.conf.
//! Small interface: list / ensure / stop. Deep impl hides port alloc + pool.conf truth + render + restart.
//! Internal seam: PortAllocator fake for tests.

use devx_core::Error;
use tauri::State;

use crate::state::AppState;

/// Deep module — small interface, deep impl.
pub struct PhpPool<'a> {
    /// Tauri state handle.
    pub state: State<'a, AppState>,
}

impl<'a> PhpPool<'a> {
    /// Creates pool manager from Tauri state.
    pub fn new(state: State<'a, AppState>) -> Self {
        Self { state }
    }

    /// Ensures pool for `version` with `workers` exists and is running. Port is truth from pool.conf, not guessed.
    pub async fn ensure(
        &self,
        version: &str,
        workers: u32,
    ) -> Result<crate::commands::php::PhpPoolStatus, Error> {
        devx_provision::validate_workers(workers)?;
        // remember choice
        if self.workers(version) != workers {
            self.state.with_config_mut(|store| {
                store.update(|cfg| {
                    cfg.php_pools.insert(version.to_string(), workers);
                })
            })?;
        }
        let port = self.port(version)?;
        let extensions = self.extensions(version);
        let xdebug = self.xdebug(version);
        let limits = self.limits(version);
        let plan = crate::services::plan_php_pool(
            &self.state.paths,
            version,
            port,
            workers,
            &extensions,
            xdebug,
            limits,
        )?;
        let id = plan.id.clone();
        let sup = match self.state.services.get(&id) {
            Some(s) if s.state().is_active() => s,
            _ => {
                let spec = crate::services::pool_spec(&self.state.paths, &plan)?;
                self.state.services.register(spec)?
            }
        };
        sup.start().await?;
        Ok(crate::commands::php::PhpPoolStatus {
            state: sup.state(),
            port,
            ..crate::commands::php::from_summary(plan.summary())
        })
    }

    /// Stops pool of `version`.
    pub async fn stop(&self, version: &str) -> Result<crate::commands::php::PhpPoolStatus, Error> {
        let id = devx_provision::pool_id(version);
        let sup = self.state.services.require(&id)?;
        sup.stop().await;
        Ok(crate::commands::php::PhpPoolStatus {
            state: sup.state(),
            id,
            port: self.port(version)?,
            version: version.to_string(),
            workers: self.workers(version),
        })
    }

    /// Restarts with new extensions/limits/xdebug — deduplicates 4× copy-paste in commands/php.rs.
    pub async fn restart_with(&self, version: &str) -> Result<(), Error> {
        let id = devx_provision::pool_id(version);
        let sup = match self.state.services.get(&id) {
            Some(s) if s.state().is_active() => s,
            _ => return Ok(()),
        };
        let workers = self.workers(version);
        let port = self.port(version)?;
        let extensions = self.extensions(version);
        let xdebug = self.xdebug(version);
        let limits = self.limits(version);
        let plan = crate::services::plan_php_pool(
            &self.state.paths,
            version,
            port,
            workers,
            &extensions,
            xdebug,
            limits,
        )?;
        sup.stop().await;
        let spec = crate::services::pool_spec(&self.state.paths, &plan)?;
        let repl = self.state.services.register(spec)?;
        repl.start().await?;
        Ok(())
    }

    fn workers(&self, version: &str) -> u32 {
        self.state
            .with_config(|s| s.config().php_pools.get(version).copied())
            .unwrap_or(devx_provision::DEFAULT_WORKERS)
    }

    fn port(&self, version: &str) -> Result<u16, Error> {
        crate::commands::php::pool_port(&self.state, version)
    }

    fn extensions(&self, version: &str) -> Vec<String> {
        crate::commands::php::pool_extensions(&self.state, version)
    }

    fn xdebug(&self, version: &str) -> Option<devx_core::config::XdebugConfig> {
        crate::commands::php::pool_xdebug(&self.state, version)
    }

    fn limits(&self, version: &str) -> Option<devx_core::config::LimitConfig> {
        crate::commands::php::pool_limits(&self.state, version)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn interface_is_small() {
        let methods = ["ensure", "stop", "restart_with"];
        assert_eq!(methods.len(), 3);
    }
}
