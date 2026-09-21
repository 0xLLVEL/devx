//! Bundled wildcard DNS resolver commands.

use crate::state::AppState;
use devx_core::Error;
use devx_privileged::PipeClient;
use tauri::State;

/// The bundled DNS resolver's status, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct DnsStatus {
    /// Whether the resolver is running inside DevX right now.
    pub running: bool,
    /// Port the resolver listens on, when running.
    pub port: Option<u16>,
    /// Whether the NRPT rule routes `.test` queries to DevX. `None` when
    /// the privileged helper is unavailable to check.
    pub nrpt_active: Option<bool>,
    /// The suffix the resolver answers for.
    pub suffix: String,
}

/// Reports the bundled resolver's status and whether the NRPT rule is active.
#[tauri::command]
#[specta::specta]
pub async fn dns_status(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let (running, port) = {
        let guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(handle) => (true, Some(handle.local_addr().port())),
            None => (false, None),
        }
    };

    let nrpt_active = if PipeClient::is_available() {
        match PipeClient::connect() {
            Ok(mut client) => match client.hello().await {
                Ok(()) => Some(true),
                Err(_) => Some(false),
            },
            Err(_) => Some(false),
        }
    } else {
        None
    };

    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());

    Ok(DnsStatus {
        running,
        port,
        nrpt_active,
        suffix,
    })
}

/// Builds the hostname-to-loopback map from the configured sites.
///
/// Every hostname and alias resolves to its owning server's address, so the
/// bundled resolver answers each name on the right loopback without a
/// restart. Pure over the config, so it is unit-testable without state.
pub(crate) fn site_ip_map(
    config: &devx_core::config::Config,
) -> std::collections::HashMap<String, std::net::Ipv4Addr> {
    let mut map = std::collections::HashMap::new();
    for site in &config.sites {
        let ip = devx_provision::server_ip_for_component(site.web_server.component_id());
        map.insert(site.hostname.to_ascii_lowercase(), ip);
        for alias in &site.aliases {
            map.insert(alias.to_ascii_lowercase(), ip);
        }
    }
    map
}

/// Starts the bundled DNS resolver and (through the helper) points the NRPT
/// rule at it. Idempotent: starting twice keeps the running instance.
#[tauri::command]
#[specta::specta]
pub async fn dns_start(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());
    let dns_port = state.with_config(|store| store.config().network.dns_port);

    // Refresh the shared map from the current sites before (re)starting, so
    // a resolver that survives config edits still answers fresh data.
    let fresh = state.with_config(|store| site_ip_map(store.config()));
    if let Ok(mut map) = state.dns_map.write() {
        *map = fresh;
    }
    let config = {
        let mut cfg = devx_dns::ResolverConfig::default_for(&suffix);
        cfg.hosts = state.dns_map.clone();
        cfg
    };

    // The MutexGuard must not live across the `.await`: std guards are not
    // `Send`, and the Tauri runtime requires `Send` futures. Bind first,
    // then store the handle in a separate, await-free block.
    let already_running = state.dns_running();
    if !already_running {
        // Try the configured port (53 on a stock Windows box binds fine
        // unelevated — there is no low-port privilege) and fall back to an
        // ephemeral one only when it is genuinely taken. The NRPT rule names
        // the resolver's actual port either way.
        let handle = match devx_dns::serve(dns_port, config.clone()).await {
            Ok(handle) => handle,
            Err(_) => devx_dns::serve(0, config)
                .await
                .map_err(|err| {
                    Error::conflict(format!("could not start the DNS resolver: {err}")).with_hint(
                        "another resolver may own the port; stop it or change dns_port in Settings",
                    )
                })?,
        };
        tracing::info!(port = handle.local_addr().port(), "DNS resolver started");
        let mut guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(handle);
    }

    // Route .test queries to this resolver. The rule names the resolver's
    // real port, so it must be written after the socket exists.
    let resolver_port = {
        let guard = state
            .dns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_ref().map(|h| h.local_addr().port())
    };
    if let Some(resolver_port) = resolver_port {
        // The helper is auto-elevated on demand: the first start raises one
        // UAC prompt, after which the pipe stays up for every later flow.
        if let Err(err) = crate::helper::ensure_helper_running().await {
            tracing::warn!(error = %err, "helper elevation skipped; NRPT cannot be installed");
        }
        if PipeClient::is_available() {
            let mut client = PipeClient::connect()?;
            client.hello().await?;
            client.set_nrpt_rule(&suffix, resolver_port).await?;
            tracing::info!(%suffix, resolver_port, "NRPT rule installed");
        } else {
            // Without the helper the rule cannot be written and every *.test
            // lookup fails with ERR_NAME_NOT_RESOLVED — say so loudly.
            tracing::warn!(
                %suffix,
                resolver_port,
                "privileged helper unavailable: the NRPT rule was NOT installed, so *.test names will not resolve. Install the DevXHelper service (the installer does this) to route .test through DevX."
            );
        }
    }

    dns_status(state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(hostname: &str, server: devx_core::config::WebServer, alias: Option<&str>) -> devx_core::config::Site {
        devx_core::config::Site {
            hostname: hostname.to_owned(),
            docroot: "C:\\sites\\app".to_owned(),
            php_version: String::new(),
            https: false,
            web_server: server,
            env: Default::default(),
            aliases: alias.map(|a| vec![a.to_owned()]).unwrap_or_default(),
            auth: None,
        }
    }

    #[test]
    fn ip_map_points_each_name_at_its_owner_loopback() {
        use devx_core::config::WebServer;
        let mut config = devx_core::config::Config::default();
        config.sites.push(site("app.test", WebServer::Nginx, None));
        config
            .sites
            .push(site("mtdb.test", WebServer::Apache, Some("www.mtdb.test")));

        let map = site_ip_map(&config);
        assert_eq!(
            map.get("app.test"),
            Some(&std::net::Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            map.get("mtdb.test"),
            Some(&std::net::Ipv4Addr::new(127, 0, 0, 2))
        );
        assert_eq!(
            map.get("www.mtdb.test"),
            Some(&std::net::Ipv4Addr::new(127, 0, 0, 2))
        );
    }
}

/// Re-installs the NRPT rule for the running resolver, prompting for
/// helper elevation when needed.
///
/// The one-click remedy for "resolver running but names not resolving":
/// it starts the resolver when stopped, then makes sure the helper is up
/// (one UAC prompt the first time) and points the rule at the resolver's
/// actual port.
#[tauri::command]
#[specta::specta]
pub async fn dns_repair(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    if !state.dns_running() {
        // Starting the resolver also installs the rule via the helper.
        return dns_start(state).await;
    }

    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());
    let resolver_port = state
        .dns
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|handle| handle.local_addr().port());

    if let Some(resolver_port) = resolver_port {
        crate::helper::ensure_helper_running().await?;
        let mut client = PipeClient::connect()?;
        client.hello().await?;
        client.set_nrpt_rule(&suffix, resolver_port).await?;
        tracing::info!(%suffix, resolver_port, "NRPT rule re-installed");
    }

    dns_status(state).await
}

/// Stops the bundled resolver and removes the NRPT rule.
#[tauri::command]
#[specta::specta]
pub async fn dns_stop(state: State<'_, AppState>) -> Result<DnsStatus, Error> {
    let suffix = state.with_config(|store| store.config().network.domain_suffix.clone());

    if PipeClient::is_available() {
        if let Ok(mut client) = PipeClient::connect() {
            if client.hello().await.is_ok() {
                if let Err(err) = client.remove_nrpt_rule(&suffix).await {
                    tracing::warn!(error = %err, "could not remove the NRPT rule");
                }
            }
        }
    }

    let handle = state
        .dns
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(handle) = handle {
        handle.stop().await;
        tracing::info!("DNS resolver stopped");
    }

    dns_status(state).await
}
