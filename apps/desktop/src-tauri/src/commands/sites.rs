//! Site management commands: add, remove, env vars, aliases, and the nginx
//! block sync that keeps disk state equal to configured state.

use devx_core::{AppPaths, Error, Site as ConfigSite};
use devx_privileged::PipeClient;
use tauri::State;

use crate::state::AppState;

/// One site as the UI sees it, with the resolved FastCGI endpoint.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SiteStatus {
    /// Host name served.
    pub hostname: String,
    /// Absolute docroot path.
    pub docroot: String,
    /// PHP version serving the site, empty for a static site.
    pub php_version: String,
    /// The `fastcgi_pass` endpoint, when the site runs PHP.
    pub php_endpoint: Option<String>,
    /// Whether the site is served over HTTPS with the local CA certificate.
    pub https: bool,
    /// Which web server serves this site.
    pub web_server: devx_core::config::WebServer,
    /// Environment variables exposed to the site's PHP requests.
    pub env: std::collections::BTreeMap<String, String>,
    /// Additional host names the site answers to.
    pub aliases: Vec<String>,
    /// Basic-auth user when the site is protected, `None` for public.
    pub auth: Option<devx_core::config::SiteAuth>,
}

/// Lists the configured sites with their resolved PHP endpoints.
#[tauri::command]
#[specta::specta]
pub fn site_list(state: State<'_, AppState>) -> Result<Vec<SiteStatus>, Error> {
    let sites = state.with_config(|store| store.config().sites.clone());

    let mut statuses = Vec::new();
    for site in &sites {
        let php_endpoint = match site.php() {
            Some(version) => {
                devx_provision::pool_endpoint_for(&state.paths.service_config_dir(), version).ok()
            }
            None => None,
        };
        statuses.push(SiteStatus {
            hostname: site.hostname.clone(),
            docroot: site.docroot.clone(),
            php_version: site.php_version.clone(),
            php_endpoint,
            https: site.https,
            web_server: site.web_server,
            env: site.env.clone(),
            aliases: site.aliases.clone(),
            // Never expose the password hash to the UI — the user name is
            // enough to show the protected state.
            auth: site.auth.as_ref().map(|a| devx_core::config::SiteAuth {
                username: a.username.clone(),
                password_hash: String::new(),
            }),
        });
    }

    Ok(statuses)
}

/// Writes or removes the hosts-file entries for one site's names
/// (host name plus aliases), used when the resolution strategy is the
/// hosts file. Silent no-op in resolver mode, where NRPT covers the
/// suffix and the hosts file is deliberately left alone.
/// Rewrites the hosts file to match the configured sites after a strategy
/// switch.
///
/// Hosts-first strategies add an entry per site name and alias; resolver
/// mode removes every DevX-owned entry so nothing keeps resolving once
/// NRPT takes over. Best-effort: an unreachable helper is reported but
/// never blocks the settings save.
pub(crate) async fn reconcile_hosts_entries(state: &State<'_, AppState>, mode: devx_core::DnsMode) {
    let names: Vec<String> = state.with_config(|store| {
        store
            .config()
            .sites
            .iter()
            .flat_map(|site| {
                let mut names = vec![site.hostname.clone()];
                names.extend(site.aliases.clone());
                names
            })
            .collect()
    });

    let result = if mode == devx_core::DnsMode::Resolver {
        clear_hosts_entries().await
    } else {
        sync_hosts_entries(state, &names, true).await
    };

    if let Err(err) = result {
        tracing::warn!(error = %err, ?mode, "hosts reconciliation after a strategy switch failed");
    }
}

/// Removes every DevX-managed hosts entry.
async fn clear_hosts_entries() -> Result<(), Error> {
    if !PipeClient::is_available() {
        return Err(Error::privileged(
            "the privileged helper is unavailable, so the hosts file cannot be updated",
        ));
    }

    let mut client = PipeClient::connect()?;
    client.hello().await?;
    for entry in client.list_hosts_entries().await? {
        client.remove_hosts_entry(&entry.hostname).await?;
    }
    Ok(())
}

async fn sync_hosts_entries(
    state: &State<'_, AppState>,
    names: &[String],
    add: bool,
) -> Result<(), Error> {
    let mode = state.with_config(|store| store.config().network.dns_mode);
    // Hosts-file (and automatic, which is hosts-first) mode routes sites
    // through the hosts file; resolver mode covers everything via NRPT.
    if mode == devx_core::DnsMode::Resolver || names.is_empty() {
        return Ok(());
    }

    crate::helper::ensure_helper_running().await?;

    if !PipeClient::is_available() {
        return Err(Error::privileged(
            "the privileged helper is unavailable, so the hosts file cannot be updated"
        )
        .with_hint(
            "install and start the DevXHelper service (the installer does this), or switch the resolution strategy back to the bundled resolver"
        ));
    }

    let mut client = PipeClient::connect()?;
    client.hello().await?;
    for name in names {
        if add {
            client
                .add_hosts_entry(devx_ipc::HostsEntry {
                    hostname: name.clone(),
                    ip: "127.0.0.1".into(),
                })
                .await?;
        } else {
            client.remove_hosts_entry(name).await?;
        }
    }
    Ok(())
}

/// Adds (or replaces) a site — thin adapter over SiteOrchestrator.
#[tauri::command]
#[specta::specta]
pub async fn site_add(
    state: State<'_, AppState>,
    hostname: String,
    docroot: String,
    php_version: String,
    https: bool,
    web_server: Option<devx_core::config::WebServer>,
) -> Result<Vec<SiteStatus>, Error> {
    let web_server = web_server.unwrap_or(devx_core::config::WebServer::Nginx);
    let previous = state.with_config(|store| {
        store
            .config()
            .sites
            .iter()
            .find(|s| s.hostname.eq_ignore_ascii_case(&hostname))
            .cloned()
    });
    let site = ConfigSite {
        hostname: hostname.clone(),
        docroot: docroot.clone(),
        php_version: php_version.clone(),
        https,
        web_server,
        env: previous.as_ref().map(|s| s.env.clone()).unwrap_or_default(),
        aliases: previous
            .as_ref()
            .map(|s| s.aliases.clone())
            .unwrap_or_default(),
        auth: previous.as_ref().and_then(|s| s.auth.clone()),
    };
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .add(site)
        .await
}

/// Removes a site — thin adapter over SiteOrchestrator.
#[tauri::command]
#[specta::specta]
pub async fn site_remove(
    state: State<'_, AppState>,
    hostname: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .remove(&hostname)
        .await
}

/// Sets one environment variable — thin adapter.
#[tauri::command]
#[specta::specta]
pub async fn site_env_set(
    state: State<'_, AppState>,
    hostname: String,
    key: String,
    value: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .set_env_var(&hostname, key, value)
        .await
}

/// Removes one environment variable — thin adapter.
#[tauri::command]
#[specta::specta]
pub async fn site_env_delete(
    state: State<'_, AppState>,
    hostname: String,
    key: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .delete_env_var(&hostname, &key)
        .await
}

/// Sets basic-auth — thin adapter (hashing stays here, storage in orchestrator).
#[tauri::command]
#[specta::specta]
pub async fn site_auth_set(
    state: State<'_, AppState>,
    hostname: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let auth = match (username, password) {
        (Some(user), Some(pass)) if !user.trim().is_empty() && !pass.is_empty() => {
            let hash = bcrypt::hash(pass, bcrypt::DEFAULT_COST)
                .map_err(|err| Error::invalid_input(format!("hashing password failed: {err}")))?;
            Some(devx_core::config::SiteAuth {
                username: user.trim().to_string(),
                password_hash: hash,
            })
        }
        _ => None,
    };
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .set_auth(&hostname, auth)
        .await
}

/// Adds an alias — thin adapter.
#[tauri::command]
#[specta::specta]
pub async fn site_alias_add(
    state: State<'_, AppState>,
    hostname: String,
    alias: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .add_alias(&hostname, alias)
        .await
}

/// Removes an alias — thin adapter.
#[tauri::command]
#[specta::specta]
pub async fn site_alias_delete(
    state: State<'_, AppState>,
    hostname: String,
    alias: String,
) -> Result<Vec<SiteStatus>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    crate::site_orchestrator::SiteOrchestrator::new(state)
        .delete_alias(&hostname, &alias)
        .await
}

/// The newest installed version of a component, from the runtimes directory.
pub(crate) fn newest_installed_component(
    paths: &AppPaths,
    component_id: &str,
) -> Result<String, Error> {
    let runtimes = paths.runtimes_dir().join(component_id);
    let mut versions: Vec<String> = std::fs::read_dir(&runtimes)
        .map_err(|_| {
            Error::not_found(format!("{component_id} is not installed"))
                .with_hint("install the component from the Components page first")
        })?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| runtimes.join(name).join(".devx-ok").is_file())
        .collect();
    versions.sort();
    versions
        .pop()
        .ok_or_else(|| Error::not_found(format!("{component_id} is not installed")))
}

/// (Re)writes every site's server block and prunes stale ones.
///
/// One sync per mutation keeps the include directory exactly equal to the
/// configured set, which is what makes web server restarts deterministic.
pub(crate) fn sync_site_blocks(state: &State<'_, AppState>) -> Result<(), Error> {
    let sites = state.with_config(|store| store.config().sites.clone());
    let (http_port, https_port) = state.with_config(|store| {
        let config = store.config();
        let http = config
            .service_ports
            .get("nginx")
            .copied()
            .unwrap_or(config.network.http_port);
        (http, config.network.https_port)
    });

    let sync_sites: Vec<devx_provision::SyncSite> = sites
        .into_iter()
        .map(|site| {
            let php = site.php().map(str::to_owned);
            devx_provision::SyncSite {
                hostname: site.hostname,
                docroot: std::path::PathBuf::from(site.docroot),
                php_version: php,
                https: site.https,
                env: site.env.into_iter().collect(),
                aliases: site.aliases,
                web_server: site.web_server.into(),
                auth: site.auth,
            }
        })
        .collect();

    let ctx = devx_provision::SyncContext {
        service_config_dir: &state.paths.service_config_dir(),
        certs_dir: &state.paths.certs_dir(),
        http_port,
        https_port,
    };

    let sites_dir = state.paths.service_config_dir().join("nginx").join("sites");
    devx_provision::sync_site_blocks(&sites_dir, &sync_sites, ctx)?;

    Ok(())
}

/// Result of one site health check, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SitePing {
    /// HTTP status code, when the server answered.
    pub status: Option<u16>,
    /// Total round-trip time in milliseconds, when the server answered.
    pub latency_ms: Option<u32>,
    /// What went wrong, when the check failed.
    pub error: Option<String>,
}

/// Checks one site over HTTP(S) against the local web server.
///
/// Resolves the host through the system resolver first (the bundled DNS or
/// the hosts file), then issues a real request so the check covers the whole
/// chain — DNS, TLS, server block, and PHP when the docroot runs it.
#[tauri::command]
#[specta::specta]
pub async fn site_ping(state: State<'_, AppState>, hostname: String) -> Result<SitePing, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;

    let site = state
        .with_config(|store| {
            store
                .config()
                .sites
                .iter()
                .find(|s| s.hostname == hostname)
                .cloned()
        })
        .ok_or_else(|| Error::not_found(format!("site `{hostname}` is not configured")))?;

    let port = if site.https {
        state.with_config(|store| store.config().network.https_port)
    } else {
        state
            .services
            .port_of("nginx")
            .or_else(|| {
                devx_provision::definition_for("nginx")
                    .ok()
                    .and_then(|def| def.default_port)
            })
            .unwrap_or(80)
    };

    let started = std::time::Instant::now();
    let url = if site.https {
        format!("https://{hostname}:{port}/")
    } else {
        format!("http://{hostname}:{port}/")
    };

    // The local CA is self-signed by design, so the check must not demand a
    // public chain — it is verifying the site answers, not WebPki.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|err| Error::internal(format!("building the HTTP client failed: {err}")))?;

    match client.get(&url).send().await {
        Ok(response) => Ok(SitePing {
            status: Some(response.status().as_u16()),
            latency_ms: Some(started.elapsed().as_millis() as u32),
            error: None,
        }),
        Err(err) => Ok(SitePing {
            status: None,
            latency_ms: None,
            error: Some(err.to_string()),
        }),
    }
}

/// One parsed request from a site's access log, for the inspector.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SiteRequestEntry {
    /// Unix seconds of the request; `null` when the log line carries no
    /// parsable timestamp.
    #[specta(type = Option<specta_typescript::Number>)]
    pub time_unix: Option<u64>,
    /// Remote address as logged (usually `127.0.0.1`).
    pub remote: String,
    /// HTTP method, e.g. `GET`.
    pub method: String,
    /// Request path including query string, e.g. `/index.php?page=2`.
    pub path: String,
    /// HTTP status the server answered with.
    pub status: u16,
    /// Response body size in bytes, when logged; `null` for 0/`-`.
    #[specta(type = Option<specta_typescript::Number>)]
    pub bytes: Option<u64>,
    /// `Referer` header when present.
    pub referer: String,
    /// `User-Agent` header when present.
    pub user_agent: String,
    /// Milliseconds the server spent on the request, when the log records it.
    #[specta(type = Option<specta_typescript::Number>)]
    pub duration_ms: Option<u64>,
}

/// The recent requests one site served, parsed from its access log.
///
/// Understands the two formats DevX writes: nginx's combined format and
/// Caddy's JSON access log. Lines that match neither are skipped, so a
/// partially written last line never breaks the read. Newest entries first.
#[tauri::command]
#[specta::specta]
pub fn site_requests(
    state: State<'_, AppState>,
    hostname: String,
    limit: u32,
) -> Result<Vec<SiteRequestEntry>, Error> {
    devx_provision::sites::validate_hostname(&hostname)?;
    let limit = limit.clamp(1, 500) as usize;

    let log_path = state
        .paths
        .logs_dir()
        .join(format!("{}.access.log", hostname.to_ascii_lowercase()));
    let Ok(body) = std::fs::read_to_string(&log_path) else {
        // No log yet is normal for a site that has not served anything.
        return Ok(Vec::new());
    };

    let mut entries: Vec<SiteRequestEntry> = body.lines().filter_map(parse_access_line).collect();
    entries.reverse();
    entries.truncate(limit);
    Ok(entries)
}

/// Parses one access-log line in either format DevX writes.
fn parse_access_line(line: &str) -> Option<SiteRequestEntry> {
    let trimmed = line.trim();
    if trimmed.starts_with('{') {
        return parse_caddy_access_line(trimmed);
    }
    parse_nginx_access_line(trimmed)
}

/// Parses an nginx combined-format line:
/// `remote - user [time] "METHOD path HTTP/1.1" status bytes "referer" "ua"`.
fn parse_nginx_access_line(line: &str) -> Option<SiteRequestEntry> {
    let remote = line.split_whitespace().next()?.to_string();

    let time_start = line.find('[')? + 1;
    let time_end = line.find("]")?;
    let time_raw = &line[time_start..time_end];
    let time_unix = time::PrimitiveDateTime::parse(time_raw, &time::format_description::parse_borrowed::<2>(
        "[day]/[month repr:short]/[year]:[hour]:[minute]:[second] [offset_hour sign:mandatory][offset_minute]",
    )
    .ok()?)
    .ok()
    .map(|t| {
        let offset = t.assume_utc();
        offset.unix_timestamp().max(0) as u64
    });

    let request_start = line.find('"')? + 1;
    let request_end = line[request_start..].find('"')? + request_start;
    let request = &line[request_start..request_end];
    let mut request_parts = request.split_whitespace();
    let method = request_parts.next().unwrap_or("-").to_string();
    let path = request_parts.next().unwrap_or("-").to_string();

    let rest = &line[request_end + 1..];
    let numbers: Vec<&str> = rest.split_whitespace().take(2).collect();
    let status = numbers.first()?.parse::<u16>().ok()?;
    let bytes = numbers
        .get(1)
        .and_then(|b| b.parse::<u64>().ok())
        .filter(|b| *b > 0);

    // The combined format ends with two quoted fields; pull them out even
    // when a header itself contains quotes, by scanning from the right.
    let quotes: Vec<usize> = rest.match_indices('"').map(|(i, _)| i).collect();
    let (referer, user_agent) = if quotes.len() >= 4 {
        (
            rest[quotes[quotes.len() - 4] + 1..quotes[quotes.len() - 3]].to_string(),
            rest[quotes[quotes.len() - 2] + 1..quotes[quotes.len() - 1]].to_string(),
        )
    } else {
        (String::new(), String::new())
    };

    Some(SiteRequestEntry {
        time_unix,
        remote,
        method,
        path,
        status,
        bytes,
        referer,
        user_agent,
        duration_ms: None,
    })
}

/// Parses one Caddy JSON access-log line into the same shape.
fn parse_caddy_access_line(line: &str) -> Option<SiteRequestEntry> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;

    let time_unix = value
        .get("ts")
        .and_then(|ts| ts.as_f64())
        .map(|ts| ts.floor().max(0.0) as u64);
    let request = value.get("request")?;
    let remote = value
        .get("client_ip")
        .and_then(|v| v.as_str())
        .or_else(|| request.get("remote_ip").and_then(|v| v.as_str()))
        .unwrap_or("-")
        .to_string();
    let headers = request.get("headers");
    let header = |name: &str| -> String {
        headers
            .and_then(|h| h.get(name))
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    // Caddy logs duration in nanoseconds.
    let duration_ms = value
        .get("duration")
        .and_then(|d| {
            d.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| d.as_f64())
        })
        .map(|secs| (secs * 1000.0).round() as u64);

    Some(SiteRequestEntry {
        time_unix,
        remote,
        method: request
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("-")
            .to_string(),
        path: request
            .get("uri")
            .and_then(|v| v.as_str())
            .unwrap_or("-")
            .to_string(),
        status: value.get("status").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        bytes: value
            .get("size")
            .and_then(|v| v.as_u64())
            .filter(|b| *b > 0),
        referer: header("Referer"),
        user_agent: header("User-Agent"),
        duration_ms,
    })
}

#[cfg(test)]
mod request_parser_tests {
    use super::*;

    #[test]
    fn parses_nginx_combined_line() {
        let entry = parse_nginx_access_line(
            "127.0.0.1 - - [14/Sep/2026:10:15:30 +0700] \"GET /index.php?page=2 HTTP/1.1\" 200 1234 \"https://app.test/\" \"Mozilla/5.0\"",
        )
        .expect("combined line parses");
        assert_eq!(entry.remote, "127.0.0.1");
        assert_eq!(entry.method, "GET");
        assert_eq!(entry.path, "/index.php?page=2");
        assert_eq!(entry.status, 200);
        assert_eq!(entry.bytes, Some(1234));
        assert_eq!(entry.referer, "https://app.test/");
        assert_eq!(entry.user_agent, "Mozilla/5.0");
        assert!(entry.time_unix.is_some());
    }

    #[test]
    fn parses_nginx_line_with_escaped_quotes_in_agent() {
        // nginx escapes `"` inside logged values as `\x22`, so the last four
        // quote characters always delimit referer and user agent.
        let entry = parse_nginx_access_line(
            "127.0.0.1 - - [14/Sep/2026:10:15:30 +0000] \"POST /api HTTP/1.1\" 404 0 \"-\" \"Comma(1.0; \\x22quoted\\x22)\"",
        )
        .expect("line parses");
        assert_eq!(entry.status, 404);
        assert_eq!(entry.bytes, None);
        assert!(entry.user_agent.contains("quoted"));
    }

    #[test]
    fn skips_non_request_lines() {
        assert!(parse_access_line("").is_none());
        assert!(parse_access_line("not a request at all").is_none());
    }

    #[test]
    fn parses_caddy_json_line() {
        let raw = r#"{"level":"info","ts":1789436130.25,"logger":"http.log.access","msg":"handled request","request":{"remote_ip":"127.0.0.1","method":"GET","uri":"/style.css","proto":"HTTP/1.1","headers":{"User-Agent":["curl/8"],"Referer":["https://app.test/"]}},"client_ip":"127.0.0.1","status":200,"size":8421,"duration":0.0031}"#;
        let entry = parse_caddy_access_line(raw).expect("caddy line parses");
        assert_eq!(entry.method, "GET");
        assert_eq!(entry.path, "/style.css");
        assert_eq!(entry.status, 200);
        assert_eq!(entry.bytes, Some(8421));
        assert_eq!(entry.referer, "https://app.test/");
        assert_eq!(entry.user_agent, "curl/8");
        assert_eq!(entry.time_unix, Some(1_789_436_130));
        assert_eq!(entry.duration_ms, Some(3));
    }
}
