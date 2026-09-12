//! Starts real services from their definitions, exercising config templating,
//! port allocation and one-time init.
//!
//! Ignored by default (downloads and runs real servers). Run with:
//!
//! ```powershell
//! cargo test -p devx-provision --test live_service -- --ignored --nocapture
//! ```

#![cfg(windows)]

use std::collections::BTreeMap;
use std::time::Duration;

use devx_core::AppPaths;
use devx_proc::{HealthCheck, ProcessSpec, RestartPolicy, ServiceState, Supervisor};
use devx_provision::service::{Readiness, ResolvedInitStep};
use devx_provision::{
    definition_for, Catalog, HttpClient, Installer, RenderContext, Resolver, ServiceDefinition,
};

/// Installs `component`, prepares its service, runs init, and supervises it.
async fn start_service(paths: &AppPaths, component_id: &str, port: u16) -> Supervisor {
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

    let definition: ServiceDefinition = definition_for(component_id).expect("definition");
    let ctx = RenderContext {
        install_dir: install_dir.clone(),
        config_dir: paths.service_config_dir().join(component_id),
        data_dir: paths.service_data_dir().join(component_id),
        log_dir: paths.logs_dir(),
        port: Some(port),
        extra: BTreeMap::new(),
    };

    let plan = definition.prepare(&ctx).expect("prepare");

    // Run init steps (initdb / mysql_install_db).
    for step in definition.pending_init(&ctx) {
        run_init(&step).await;
    }

    let mut spec = ProcessSpec::new(component_id, plan.program.clone(), paths.logs_dir());
    spec.args = plan.args.clone();
    spec.env = plan.env.clone();
    spec.working_dir = plan.working_dir.clone();
    spec.health = match plan.readiness {
        Readiness::TcpPort => HealthCheck::TcpPort(port),
        Readiness::LogContains(needle) => HealthCheck::LogContains(needle),
        Readiness::UptimeMs(ms) => HealthCheck::Uptime(Duration::from_millis(ms)),
    };
    // Databases can take a while to initialise on first boot.
    spec.health_timeout = Duration::from_secs(40);
    spec.restart = RestartPolicy::Never;

    let sup = Supervisor::new(spec);
    sup.start()
        .await
        .unwrap_or_else(|e| panic!("start {component_id}: {e}\nlogs: {:?}", collect_logs(&sup)));
    sup
}

fn collect_logs(sup: &Supervisor) -> Vec<String> {
    sup.logs().into_iter().map(|l| l.text).collect()
}

async fn run_init(step: &ResolvedInitStep) {
    let output = tokio::process::Command::new(&step.program)
        .args(&step.args)
        .output()
        .await
        .unwrap_or_else(|e| panic!("init '{}': {e}", step.description));
    assert!(
        output.status.success(),
        "init '{}' failed: {}",
        step.description,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        step.marker.exists(),
        "init '{}' left no marker",
        step.description
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads and runs a real database"]
async fn mariadb_initialises_and_serves() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    let sup = start_service(&paths, "mariadb", 13306).await;
    assert_eq!(sup.state(), ServiceState::Running);

    // The init step must have created the system tables.
    assert!(paths
        .service_data_dir()
        .join("mariadb")
        .join("mysql")
        .exists());

    sup.stop().await;
    assert_eq!(sup.state(), ServiceState::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads and runs a real database"]
async fn postgresql_initialises_and_serves() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    let sup = start_service(&paths, "postgresql", 15432).await;
    assert_eq!(sup.state(), ServiceState::Running);
    assert!(paths
        .service_data_dir()
        .join("postgresql")
        .join("PG_VERSION")
        .exists());

    sup.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads and runs real services"]
async fn stateless_services_start_from_their_definitions() {
    let dir = tempfile::tempdir().expect("temp");
    let paths = AppPaths::rooted_at(dir.path());
    paths.ensure_dirs().expect("dirs");

    // A representative port per service, off the defaults to avoid collisions.
    for (component, port) in [
        ("mailpit", 18025u16),
        ("redis", 16379),
        ("meilisearch", 17700),
        ("minio", 19000),
    ] {
        let sup = start_service(&paths, component, port).await;
        assert_eq!(
            sup.state(),
            ServiceState::Running,
            "{component} not running"
        );
        sup.stop().await;
    }
}
