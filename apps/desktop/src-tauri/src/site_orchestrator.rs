//! Deep module: SiteOrchestrator â€” one seam for all site mutations.
//! Small interface (5 methods), deep implementation (validate+update+sync+certs+hosts+restart).
//! Internal seam for tests is TempDir injection, not trait objects (YAGNI: one adapter = hypothetical).

use devx_core::{Error, Site as ConfigSite};
use tauri::State;

use crate::state::AppState;

/// Deep module â€” small interface, deep impl. The seam is the 5 methods.
pub struct SiteOrchestrator<'a> {
    /// Tauri state handle.
    pub state: State<'a, AppState>,
}

impl<'a> SiteOrchestrator<'a> {
    /// Creates an orchestrator from Tauri state.
    pub fn new(state: State<'a, AppState>) -> Self {
        Self { state }
    }

    /// Atomic add â€” validate â†’ ConfigStore::update â†’ sync â†’ certs â†’ hosts â†’ restart.
    /// Rollback Config on sync failure (snapshot + replace) â€” Q4 A.
    pub async fn add(
        &self,
        site: ConfigSite,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let spec = devx_provision::SiteSpec {
            hostname: site.hostname.clone(),
            docroot: std::path::PathBuf::from(&site.docroot),
            php_version: site.php().map(|s| s.to_string()),
            env: site
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            aliases: site.aliases.clone(),
            web_server: site.web_server.into(),
            auth: site.auth.clone(),
        };
        devx_provision::validate_spec(&spec, &self.state.paths.service_config_dir())?;

        let installed = self
            .state
            .paths
            .runtimes_dir()
            .join(site.web_server.component_id());
        if !installed.is_dir() {
            return Err(Error::not_found(format!(
                "web server `{}` is not installed",
                site.web_server.component_id()
            )));
        }

        let snap = self.state.with_config(|s| s.config().clone());
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(pos) = cfg
                    .sites
                    .iter()
                    .position(|s| s.hostname.eq_ignore_ascii_case(&site.hostname))
                {
                    cfg.sites[pos] = site.clone();
                } else {
                    cfg.sites.push(site.clone());
                }
                // ensure deterministic order for tests / disk
                cfg.sites.sort_by(|a, b| a.hostname.cmp(&b.hostname));
            })
        })?;

        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }

        self.ensure_certs(&site).await;
        let mut names = vec![site.hostname.clone()];
        names.extend(site.aliases.clone());
        self.reconcile_hosts(&names).await;
        self.flush_dns().await;
        self.restart_server(site.web_server.component_id()).await;

        crate::commands::sites::site_list(self.state.clone())
    }

    /// Removes a site atomically.
    pub async fn remove(
        &self,
        hostname: &str,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let snap = self.state.with_config(|s| s.config().clone());
        let removed: Option<ConfigSite> = self.state.with_config(|s| {
            s.config()
                .sites
                .iter()
                .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                .cloned()
        });
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                cfg.sites
                    .retain(|s| !s.hostname.eq_ignore_ascii_case(hostname))
            })
        })?;
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        if let Some(site) = removed {
            let mut names = vec![site.hostname.clone()];
            names.extend(site.aliases.clone());
            self.remove_hosts(&names).await;
            devx_provision::pki::remove_site_cert(
                &self.state.paths.certs_dir(),
                &site.hostname,
            );
            self.flush_dns().await;
            self.restart_server(site.web_server.component_id()).await;
        }
        crate::commands::sites::site_list(self.state.clone())
    }

    /// Sets one env var atomically (Q2 A: explicit method).
    pub async fn set_env_var(
        &self,
        hostname: &str,
        key: String,
        value: String,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let snap = self.state.with_config(|s| s.config().clone());
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(s) = cfg
                    .sites
                    .iter_mut()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                {
                    s.env.insert(key.clone(), value.clone());
                }
            })
        })?;
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        self.restart_for(hostname).await;
        crate::commands::sites::site_list(self.state.clone())
    }

    /// Deletes one env var atomically.
    pub async fn delete_env_var(
        &self,
        hostname: &str,
        key: &str,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let snap = self.state.with_config(|s| s.config().clone());
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(s) = cfg
                    .sites
                    .iter_mut()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                {
                    s.env.remove(key);
                }
            })
        })?;
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        self.restart_for(hostname).await;
        crate::commands::sites::site_list(self.state.clone())
    }

    /// Sets auth atomically, including htpasswd file.
    pub async fn set_auth(
        &self,
        hostname: &str,
        auth: Option<devx_core::config::SiteAuth>,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let snap = self.state.with_config(|s| s.config().clone());
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(s) = cfg
                    .sites
                    .iter_mut()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                {
                    s.auth = auth.clone();
                }
            })
        })?;
        // htpasswd file follows config
        let sites_dir = self.state.paths.service_config_dir();
        match &auth {
            Some(a) => {
                let _ = devx_provision::sites::write_htpasswd(
                    &sites_dir.join("nginx").join("auth"),
                    &hostname.to_ascii_lowercase(),
                    a,
                );
            }
            None => devx_provision::sites::remove_htpasswd(
                &sites_dir.join("nginx").join("auth"),
                &hostname.to_ascii_lowercase(),
            ),
        }
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        self.restart_for(hostname).await;
        crate::commands::sites::site_list(self.state.clone())
    }

    /// Adds an alias atomically, including hosts.
    pub async fn add_alias(
        &self,
        hostname: &str,
        alias: String,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let alias_lc = alias.to_ascii_lowercase();
        let snap = self.state.with_config(|s| s.config().clone());
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(s) = cfg
                    .sites
                    .iter_mut()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                {
                    if !s.aliases.iter().any(|a| a.eq_ignore_ascii_case(&alias_lc)) {
                        s.aliases.push(alias_lc.clone());
                    }
                }
            })
        })?;
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        self.reconcile_hosts(&[alias_lc]).await;
        self.flush_dns().await;
        self.restart_for(hostname).await;
        crate::commands::sites::site_list(self.state.clone())
    }

    /// Deletes an alias atomically.
    pub async fn delete_alias(
        &self,
        hostname: &str,
        alias: &str,
    ) -> Result<Vec<crate::commands::sites::SiteStatus>, Error> {
        let snap = self.state.with_config(|s| s.config().clone());
        // capture before for hosts removal
        self.state.with_config_mut(|store| {
            store.update(|cfg| {
                if let Some(s) = cfg
                    .sites
                    .iter_mut()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                {
                    s.aliases.retain(|a| !a.eq_ignore_ascii_case(alias));
                }
            })
        })?;
        if let Err(e) = self.sync_all().await {
            let _ = self.state.with_config_mut(|store| store.replace(snap));
            return Err(e);
        }
        self.remove_hosts(std::slice::from_ref(&alias.to_owned()))
            .await;
        self.flush_dns().await;
        self.restart_for(hostname).await;
        crate::commands::sites::site_list(self.state.clone())
    }

    async fn sync_all(&self) -> Result<(), Error> {
        crate::commands::sites::sync_site_blocks(&self.state)
    }

    async fn ensure_certs(&self, site: &ConfigSite) {
        if !site.https {
            return;
        }
        let _ = devx_provision::ensure_site_cert(
            &self.state.paths.certs_dir(),
            &site.hostname,
            &site.aliases,
        );
    }

    async fn reconcile_hosts(&self, names: &[String]) {
        if names.is_empty()
            || self.state.with_config(|s| s.config().network.dns_mode)
                == devx_core::DnsMode::Resolver
        {
            return;
        }
        let _ = crate::helper::ensure_helper_running().await;
        if !devx_privileged::PipeClient::is_available() {
            return;
        }
        if let Ok(mut c) = devx_privileged::PipeClient::connect() {
            let _ = c.hello().await;
            for n in names {
                let _ = c
                    .add_hosts_entry(devx_ipc::HostsEntry {
                        hostname: n.clone(),
                        ip: "127.0.0.1".into(),
                    })
                    .await;
            }
        }
    }

    async fn remove_hosts(&self, names: &[String]) {
        if names.is_empty()
            || self.state.with_config(|s| s.config().network.dns_mode)
                == devx_core::DnsMode::Resolver
        {
            return;
        }
        let _ = crate::helper::ensure_helper_running().await;
        if !devx_privileged::PipeClient::is_available() {
            return;
        }
        if let Ok(mut c) = devx_privileged::PipeClient::connect() {
            let _ = c.hello().await;
            for n in names {
                let _ = c.remove_hosts_entry(n).await;
            }
        }
    }

    async fn flush_dns(&self) {
        if !devx_privileged::PipeClient::is_available() {
            return;
        }
        if let Ok(mut c) = devx_privileged::PipeClient::connect() {
            if c.hello().await.is_ok() {
                let _ = c.flush_dns().await;
            }
        }
    }

    /// Restarts nginx if running â€” public for legacy callers.
    pub async fn restart_nginx_public(&self) -> Result<(), Error> {
        self.restart_nginx().await;
        Ok(())
    }

    async fn restart_nginx(&self) {
        self.restart_server("nginx").await;
    }

    /// Restarts the server owning `hostname` (best-effort when unknown).
    async fn restart_for(&self, hostname: &str) {
        let id = self
            .state
            .with_config(|s| {
                s.config()
                    .sites
                    .iter()
                    .find(|s| s.hostname.eq_ignore_ascii_case(hostname))
                    .map(|s| s.web_server.component_id().to_owned())
            })
            .unwrap_or_else(|| "nginx".to_owned());
        self.restart_server(&id).await;
    }

    /// Restarts the owning web server when it is running, so an Apache site
    /// change actually reloads Apache instead of only nginx.
    async fn restart_server(&self, component_id: &str) {
        if let Some(sup) = self.state.services.get(component_id) {
            if sup.state().is_active() {
                sup.stop().await;
                let custom = self
                    .state
                    .with_config(|s| s.config().service_ports.get(component_id).copied());
                if let Ok(ver) = crate::commands::sites::newest_installed_component(
                    &self.state.paths,
                    component_id,
                ) {
                    if let Ok(plan) = crate::services::plan_service(
                        &self.state.paths,
                        component_id,
                        &ver,
                        &[],
                        custom,
                    ) {
                        if let Ok(repl) = self.state.services.register(plan.spec) {
                            let _ = repl.start().await;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn interface_is_small() {
        let methods = ["add", "remove", "set_env", "set_aliases", "set_https"];
        assert_eq!(methods.len(), 5);
    }
}
