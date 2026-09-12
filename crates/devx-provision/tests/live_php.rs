//! Starts a real PHP FastCGI pool from an installed PHP version, exercising
//! php.ini rendering, `PHP_FCGI_CHILDREN`, and the FastCGI socket end to end.
//!
//! Ignored by default (downloads a real PHP build). Run with:
//!
//! ```powershell
//! cargo test -p devx-provision --test live_php -- --ignored --nocapture
//! ```

#![cfg(windows)]

use std::time::Duration;

use devx_core::AppPaths;
use devx_proc::{HealthCheck, ProcessSpec, RestartPolicy, ServiceState, Supervisor};
use devx_provision::php_pool::{plan_pool, write_pool_files, PoolPlanOptions};
use devx_provision::{Catalog, HttpClient, Installer, Resolver};

const TEST_PORT: u16 = 19100;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads and runs a real PHP runtime"]
async fn php_pool_starts_and_speaks_fastcgi() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    // Install the newest resolvable PHP build, as the UI would.
    let catalog = Catalog::embedded().expect("catalog");
    let component = catalog.component("php").expect("component");
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
        .expect("install php");

    // Plan the pool exactly as the desktop shell does.
    let config_dir = paths.service_config_dir().join("php-pool");
    let data_dir = paths.service_data_dir().join("php-pool");
    let plan = plan_pool(
        &latest.version,
        &install_dir,
        &config_dir,
        &data_dir,
        &paths.logs_dir(),
        &PoolPlanOptions::new(TEST_PORT).with_workers(2),
    )
    .expect("plan");
    write_pool_files(&config_dir, &plan).expect("write files");

    assert!(config_dir.join("php.ini").is_file());
    assert!(
        plan.php_ini.contains("error_log = "),
        "ini must direct errors into DevX logs"
    );

    // Supervise it with the same shape the shell builds.
    let mut spec = ProcessSpec::new(plan.id.clone(), plan.program.clone(), paths.logs_dir());
    spec.args = plan.args.clone();
    spec.env = plan.env.clone();
    spec.working_dir = Some(config_dir.clone());
    spec.health = HealthCheck::Uptime(Duration::from_millis(800));
    spec.health_timeout = Duration::from_secs(20);
    spec.restart = RestartPolicy::Never;

    let sup = Supervisor::new(spec);
    sup.start()
        .await
        .unwrap_or_else(|e| panic!("start pool: {e}\nlogs: {:?}", logs(&sup)));
    assert_eq!(sup.state(), ServiceState::Running);

    // The socket must accept a connection: php-cgi bound the FastCGI port.
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", TEST_PORT))
        .await
        .expect("FastCGI socket must accept connections");
    drop(stream);

    // A FastCGI server answers the binary protocol, not HTTP: the connection
    // above is the strongest readiness signal available without a client
    // library, and the process staying up rules out an immediate crash.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        sup.state(),
        ServiceState::Running,
        "pool must stay up after a connection"
    );

    sup.stop().await;
    assert_eq!(sup.state(), ServiceState::Stopped);
}

fn logs(sup: &Supervisor) -> Vec<String> {
    sup.logs().into_iter().map(|l| l.text).collect()
}
