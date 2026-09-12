//! Serves a real HTTP request through the full site stack: nginx server
//! block → FastCGI pool → `php-cgi` → rendered response.
//!
//! This is the end-to-end proof of Task 9: a site added to the sites include
//! directory, with the pool of its chosen PHP version, answers `curl`
//! (or anything speaking HTTP) on the nginx port.
//!
//! Ignored by default (downloads real nginx and PHP builds). Run with:
//!
//! ```powershell
//! cargo test -p devx-provision --test live_site -- --ignored --nocapture
//! ```

#![cfg(windows)]

use std::time::Duration;

use devx_core::AppPaths;
use devx_proc::{HealthCheck, ProcessSpec, RestartPolicy, ServiceState, Supervisor};
use devx_provision::php_pool::{plan_pool, write_pool_files, PoolPlanOptions};
use devx_provision::sites::{prune_stale_blocks, write_site_block};
use devx_provision::{
    definition_for, Catalog, HttpClient, Installer, RenderContext, Resolver, SiteSpec,
};

const NGINX_PORT: u16 = 18080;
const POOL_PORT: u16 = 19101;

/// Installs `component` at its newest resolvable version.
async fn install(paths: &AppPaths, component_id: &str) -> (String, std::path::PathBuf) {
    let catalog = Catalog::embedded().expect("catalog");
    let component = catalog.component(component_id).expect("component");
    let http = HttpClient::new(paths.cache_dir().join("http")).expect("http");

    let listing = Resolver::new(http.clone())
        .list_versions(component)
        .await
        .expect("resolve");
    let latest = &listing.versions[0];

    let installer = Installer::new(paths.clone(), http).expect("installer");
    let install_dir = installer
        .install(latest, &component.layout, |_| {})
        .await
        .unwrap_or_else(|e| panic!("install {component_id}: {e}"));

    (latest.version.clone(), install_dir)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads and runs real nginx and PHP builds"]
async fn nginx_serves_a_php_site_through_its_pool() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    // 1. Install nginx and PHP.
    let (nginx_version, nginx_dir) = install(&paths, "nginx").await;
    let (php_version, php_dir) = install(&paths, "php").await;

    // 2. Start the PHP FastCGI pool exactly as the desktop shell does.
    let pool_id = devx_provision::pool_id(&php_version);
    let pool_config_dir = paths.service_config_dir().join(&pool_id);
    let plan = plan_pool(
        &php_version,
        &php_dir,
        &pool_config_dir,
        &paths.service_data_dir().join(&pool_id),
        &paths.logs_dir(),
        &PoolPlanOptions::new(POOL_PORT).with_workers(2),
    )
    .expect("plan pool");
    write_pool_files(&pool_config_dir, &plan).expect("write pool files");

    let mut pool_spec = ProcessSpec::new(plan.id.clone(), plan.program.clone(), paths.logs_dir());
    pool_spec.args = plan.args.clone();
    pool_spec.env = plan.env.clone();
    pool_spec.working_dir = Some(pool_config_dir.clone());
    pool_spec.health = HealthCheck::Uptime(Duration::from_millis(800));
    pool_spec.health_timeout = Duration::from_secs(20);
    pool_spec.restart = RestartPolicy::Never;

    let pool = Supervisor::new(pool_spec);
    pool.start()
        .await
        .unwrap_or_else(|e| panic!("start pool: {e}\nlogs: {:?}", logs(&pool)));
    assert_eq!(pool.state(), ServiceState::Running);

    // 3. Create the docroot with an index.php that reports something real.
    let docroot = paths.cache_dir().join("live-sites").join("myapp");
    std::fs::create_dir_all(&docroot).expect("docroot");
    std::fs::write(
        docroot.join("index.php"),
        "<?php header('Content-Type: text/plain'); echo 'devx-live ' . PHP_VERSION;",
    )
    .expect("index.php");
    std::fs::write(docroot.join("index.html"), "devx-static").expect("index.html");

    // 4. Render and sync the site block, as `site_add` does.
    let sites_dir = paths.service_config_dir().join("nginx").join("sites");
    std::fs::create_dir_all(&sites_dir).expect("sites dir");

    let spec = SiteSpec {
        hostname: "myapp.test".to_owned(),
        docroot: docroot.clone(),
        php_version: Some(php_version.clone()),
        env: Vec::new(),
        aliases: Vec::new(),
    };
    write_site_block(
        &sites_dir,
        &spec,
        Some(&format!("127.0.0.1:{POOL_PORT}")),
        None,
    )
    .expect("write site block");

    // A site that was removed must not survive the next sync.
    std::fs::write(sites_dir.join("ghost.test.conf"), "# stale\n").expect("seed stale");
    let pruned = prune_stale_blocks(&sites_dir, &["myapp.test".to_owned()]).expect("prune");
    assert_eq!(pruned, vec!["ghost.test".to_owned()]);
    assert!(!sites_dir.join("ghost.test.conf").exists());

    // 5. Start nginx with the managed config.
    let definition = definition_for("nginx").expect("definition");
    let ctx = RenderContext {
        install_dir: nginx_dir.clone(),
        config_dir: paths.service_config_dir().join("nginx"),
        data_dir: paths.service_data_dir().join("nginx"),
        log_dir: paths.logs_dir(),
        port: Some(NGINX_PORT),
        extra: Default::default(),
    };
    let nginx_plan = definition.prepare(&ctx).expect("prepare nginx");

    let mut nginx_spec = ProcessSpec::new("nginx", nginx_plan.program.clone(), paths.logs_dir());
    nginx_spec.args = nginx_plan.args.clone();
    nginx_spec.env = nginx_plan.env.clone();
    nginx_spec.working_dir = nginx_plan.working_dir.clone();
    nginx_spec.health = HealthCheck::TcpPort(NGINX_PORT);
    nginx_spec.health_timeout = Duration::from_secs(30);
    nginx_spec.restart = RestartPolicy::Never;

    let nginx = Supervisor::new(nginx_spec);
    nginx
        .start()
        .await
        .unwrap_or_else(|e| panic!("start nginx: {e}\nlogs: {:?}", logs(&nginx)));
    assert_eq!(nginx.state(), ServiceState::Running);

    // 6. The site answers: PHP version proves the request flowed through
    //    nginx's server block into the FastCGI pool of the chosen version.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client");

    let body = http_get(
        &client,
        &format!("http://127.0.0.1:{NGINX_PORT}/"),
        "myapp.test",
    )
    .await;
    assert_eq!(
        body,
        format!("devx-live {php_version}"),
        "the PHP site must serve through the pool"
    );

    // 7. A second site proves per-site routing and the static path.
    let static_docroot = paths.cache_dir().join("live-sites").join("plain");
    std::fs::create_dir_all(&static_docroot).expect("docroot");
    std::fs::write(static_docroot.join("index.html"), "devx-static").expect("index.html");

    write_site_block(
        &sites_dir,
        &SiteSpec {
            hostname: "plain.test".to_owned(),
            docroot: static_docroot.clone(),
            php_version: None,
            env: Vec::new(),
            aliases: Vec::new(),
        },
        None,
        None,
    )
    .expect("write static block");

    // nginx must reload to see the new block: send it a reload signal by
    // stopping and restarting (a reload subcommand is a Task 10 nicety).
    nginx.stop().await;
    nginx
        .start()
        .await
        .unwrap_or_else(|e| panic!("restart nginx: {e}\nlogs: {:?}", logs(&nginx)));

    let static_body = http_get(
        &client,
        &format!("http://127.0.0.1:{NGINX_PORT}/"),
        "plain.test",
    )
    .await;
    assert_eq!(static_body, "devx-static", "static site serves its file");

    // The PHP site still routes to its pool after the restart.
    let php_again = http_get(
        &client,
        &format!("http://127.0.0.1:{NGINX_PORT}/"),
        "myapp.test",
    )
    .await;
    assert_eq!(php_again, format!("devx-live {php_version}"));

    nginx.stop().await;
    pool.stop().await;

    let _ = (nginx_version, docroot, static_docroot);
}

/// GETs `url` with a `Host` header, returning the body as text.
async fn http_get(client: &reqwest::Client, url: &str, host: &str) -> String {
    client
        .get(url)
        .header("Host", host)
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {url} (host {host}): {e}"))
        .error_for_status()
        .unwrap_or_else(|e| panic!("GET {url} (host {host}): {e}"))
        .text()
        .await
        .expect("body")
}

fn logs(sup: &Supervisor) -> Vec<String> {
    sup.logs().into_iter().map(|l| l.text).collect()
}
