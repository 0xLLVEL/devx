//! Turning an installed component into a supervised process.
//!
//! This bridges `devx-provision`'s declarative [`ServiceDefinition`] and
//! `devx-proc`'s [`ProcessSpec`]: it resolves the per-service config and data
//! directories, allocates a port (avoiding conflicts), renders the config,
//! runs any pending one-time init steps, and produces the spec the supervisor
//! launches.

use std::path::PathBuf;
use std::time::Duration;

use devx_core::{AppPaths, Error, Result};
use devx_proc::{HealthCheck, ProcessSpec, RestartPolicy};
use devx_provision::php_pool::{pool_id, validate_workers, PhpPoolPlan};
use devx_provision::service::{Readiness, ResolvedInitStep};
use devx_provision::{
    definition_for, PoolPlanOptions, PortAllocator, PortDecision, RenderContext, ServiceDefinition,
};
use devx_sys::ports::owner_of;

/// A fully resolved plan for starting one service.
#[derive(Debug)]
pub struct ServicePlan {
    /// The supervisor spec to launch.
    pub spec: ProcessSpec,
    /// Init steps that must run before the first launch.
    pub init_steps: Vec<ResolvedInitStep>,
    /// The port decision, for reporting to the UI.
    pub port: PortDecision,
}

/// Builds a launch plan for `component_id` at `version`.
///
/// `reserved` lists ports already assigned to other services being planned in
/// the same pass, so simultaneous starts do not collide.
pub fn plan_service(
    paths: &AppPaths,
    component_id: &str,
    version: &str,
    reserved: &[u16],
) -> Result<ServicePlan> {
    let definition = definition_for(component_id)?;

    let install_dir = paths.runtimes_dir().join(component_id).join(version);
    let config_dir = paths.service_config_dir().join(component_id);
    let data_dir = paths.service_data_dir().join(component_id);
    let log_dir = paths.logs_dir();

    // Decide the port before rendering config, so the config carries the port
    // the service will actually bind.
    let port_decision = match definition.default_port {
        Some(preferred) => {
            let allocator = PortAllocator::new(|port| owner_of(port).map(describe_owner));
            allocator.allocate(preferred, reserved)
        }
        None => PortDecision::Available { port: 0 },
    };

    let chosen_port = port_decision.resolved_port().filter(|&p| p != 0);

    if definition.default_port.is_some() && chosen_port.is_none() {
        return Err(port_conflict_error(component_id, &port_decision));
    }

    // nginx includes per-site server blocks from a sibling `sites` directory;
    // create it up front so the include never matches nothing at all.
    if component_id == "nginx" {
        let sites_dir = paths.service_config_dir().join("nginx").join("sites");
        std::fs::create_dir_all(&sites_dir).map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Io,
                format!("failed to create {}: {err}", sites_dir.display()),
            )
        })?;
    }

    let ctx = RenderContext {
        install_dir: install_dir.clone(),
        config_dir,
        data_dir,
        log_dir: log_dir.clone(),
        port: chosen_port,
        extra: Default::default(),
    };

    let plan = definition.prepare(&ctx)?;
    let init_steps = definition.pending_init(&ctx);

    let spec = build_spec(&definition, component_id, &plan, chosen_port, log_dir);

    Ok(ServicePlan {
        spec,
        init_steps,
        port: port_decision,
    })
}

/// Assembles the supervisor spec from a rendered launch plan.
fn build_spec(
    definition: &ServiceDefinition,
    component_id: &str,
    plan: &devx_provision::LaunchPlan,
    port: Option<u16>,
    log_dir: PathBuf,
) -> ProcessSpec {
    let mut spec = ProcessSpec::new(component_id, plan.program.clone(), log_dir);
    spec.args = plan.args.clone();
    spec.env = plan.env.clone();
    spec.working_dir = plan.working_dir.clone();
    spec.health = match (&plan.readiness, port) {
        (Readiness::TcpPort, Some(port)) => HealthCheck::TcpPort(port),
        (Readiness::TcpPort, None) => HealthCheck::Uptime(Duration::from_millis(500)),
        (Readiness::LogContains(needle), _) => HealthCheck::LogContains(needle.clone()),
        (Readiness::UptimeMs(ms), _) => HealthCheck::Uptime(Duration::from_millis(*ms)),
    };
    spec.health_timeout = Duration::from_secs(30);
    spec.restart = RestartPolicy::OnFailure { max_retries: 3 };
    let _ = definition;
    spec
}

/// Runs pending init steps in order, failing on the first that does not succeed.
///
/// Each step's marker file is checked afterwards: a program that exits zero but
/// leaves no marker is treated as a failure, because the next launch would
/// otherwise proceed against an uninitialised data directory.
pub async fn run_init_steps(steps: &[ResolvedInitStep]) -> Result<()> {
    for step in steps {
        tracing::info!(step = %step.description, program = %step.program.display(), "running init step");

        let output = tokio::process::Command::new(&step.program)
            .args(&step.args)
            .output()
            .await
            .map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Process,
                    format!("failed to run init step '{}': {err}", step.description),
                )
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(Error::new(
                devx_core::ErrorCode::Process,
                format!(
                    "init step '{}' failed (exit {:?}): {}",
                    step.description,
                    output.status.code(),
                    stderr.trim()
                ),
            ));
        }

        if !step.marker.exists() {
            return Err(Error::new(
                devx_core::ErrorCode::Process,
                format!(
                    "init step '{}' exited successfully but produced no data directory",
                    step.description
                ),
            ));
        }
    }
    Ok(())
}

/// Builds a launch plan for the FastCGI pool of one installed PHP version.
///
/// Unlike [`plan_service`], a pool has no init steps and always knows its
/// port: callers pass the port they want, having already resolved collisions
/// across pools with [`existing_pool_ports`].
pub fn plan_php_pool(
    paths: &AppPaths,
    version: &str,
    port: u16,
    workers: u32,
) -> Result<PhpPoolPlan> {
    validate_workers(workers)?;

    let install_dir = paths.runtimes_dir().join("php").join(version);
    if !install_dir.join(".devx-ok").is_file() {
        return Err(Error::not_found(format!("php {version} is not installed"))
            .with_hint("install the PHP version first"));
    }

    let id = pool_id(version);
    devx_provision::plan_pool(
        version,
        &install_dir,
        &paths.service_config_dir().join(&id),
        &paths.service_data_dir().join(&id),
        &paths.logs_dir(),
        &PoolPlanOptions::new(port).with_workers(workers),
    )
}

/// The ports every installed pool's rendered `pool.conf` claims.
///
/// Scanning the rendered files (rather than remembering ports in memory) is
/// what lets DevX restart without re-numbering existing pools: a pool keeps
/// its port for its whole life, and a new version simply skips the ones in
/// use. Unreadable or malformed files are skipped rather than fatal — their
/// pools cannot be running anyway.
pub fn existing_pool_ports(paths: &AppPaths) -> Vec<u16> {
    let mut ports = Vec::new();

    let Ok(entries) = std::fs::read_dir(paths.service_config_dir()) else {
        return ports;
    };

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !devx_provision::is_pool_id(&name) {
            continue;
        }
        if let Ok(listen) = devx_provision::pool_listen_addr(&entry.path()) {
            if let Some(port) = listen.rsplit(':').next().and_then(|p| p.parse().ok()) {
                ports.push(port);
            }
        }
    }

    ports
}

/// Picks a free port for a new pool, above every port already claimed.
///
/// [`devx_provision::FIRST_POOL_PORT`] starts the range; anything claimed by
/// an installed pool or held on the machine is skipped, plus anything in
/// `reserved` so pools planned in one pass cannot collide.
pub fn next_pool_port(paths: &AppPaths, reserved: &[u16]) -> u16 {
    let mut port = devx_provision::FIRST_POOL_PORT;
    let claimed = existing_pool_ports(paths);
    let allocator = PortAllocator::new(|p| owner_of(p).map(describe_owner));

    loop {
        if !claimed.contains(&port) && !reserved.contains(&port) {
            if let devx_provision::PortDecision::Available { port: chosen } =
                allocator.allocate(port, &[])
            {
                return chosen;
            }
        }
        port = port.saturating_add(1);
    }
}

/// Turns a pool plan into a supervised [`ProcessSpec`].
///
/// The pool has no health check of its own beyond staying alive: a FastCGI
/// socket only speaks the protocol, not HTTP, so readiness is a short uptime
/// plus `php-cgi` binding the port (verified live by the `live_php` test).
pub fn pool_spec(paths: &AppPaths, plan: &PhpPoolPlan) -> Result<ProcessSpec> {
    let config_dir = paths.service_config_dir().join(&plan.id);
    devx_provision::write_pool_files(&config_dir, plan)?;

    let mut spec = ProcessSpec::new(plan.id.clone(), plan.program.clone(), paths.logs_dir());
    spec.args = plan.args.clone();
    spec.env = plan.env.clone();
    spec.working_dir = Some(config_dir);
    spec.health = HealthCheck::Uptime(Duration::from_millis(500));
    spec.health_timeout = Duration::from_secs(15);
    spec.restart = RestartPolicy::OnFailure { max_retries: 3 };
    Ok(spec)
}

/// A short label for a port's holder.
fn describe_owner(owner: devx_sys::PortOwner) -> String {
    match owner.process_name {
        Some(name) => format!("{name} (PID {})", owner.pid),
        None => format!("PID {}", owner.pid),
    }
}

/// Builds an actionable error for an unresolvable port conflict.
fn port_conflict_error(component_id: &str, decision: &PortDecision) -> Error {
    let held = match decision {
        PortDecision::Unavailable { requested, held_by } => {
            let who = held_by.as_deref().unwrap_or("another process");
            format!("port {requested} is held by {who}")
        }
        _ => "no free port could be found".to_owned(),
    };
    Error::conflict(format!("cannot start {component_id}: {held}"))
        .with_hint("stop whatever is using the port, or change the port in Settings")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_an_unknown_service_is_not_found() {
        let paths = AppPaths::rooted_at(std::path::Path::new("C:\\devx-test"));
        let err = plan_service(&paths, "php", "8.4.25", &[]).expect_err("php is not a service");
        assert_eq!(err.code, devx_core::ErrorCode::NotFound);
    }

    #[test]
    fn planning_renders_config_and_resolves_the_program() {
        let dir = tempfile::tempdir().expect("temp");
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().expect("dirs");

        let plan = plan_service(&paths, "mailpit", "1.31.1", &[]).expect("plan");

        assert_eq!(plan.spec.id, "mailpit");
        assert!(plan
            .spec
            .program
            .ends_with("runtimes\\mailpit\\1.31.1\\mailpit.exe"));
        // Mailpit needs no init and no rendered config files.
        assert!(plan.init_steps.is_empty());
        assert!(matches!(
            plan.port,
            PortDecision::Available { .. } | PortDecision::Reassigned { .. }
        ));
    }

    #[test]
    fn planning_renders_a_config_file_for_nginx() {
        let dir = tempfile::tempdir().expect("temp");
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().expect("dirs");

        let _plan = plan_service(&paths, "nginx", "1.31.5", &[]).expect("plan");

        let conf = paths.service_config_dir().join("nginx").join("nginx.conf");
        assert!(conf.is_file(), "nginx.conf should be rendered");
        let body = std::fs::read_to_string(conf).expect("read");
        assert!(body.contains("listen"), "{body}");
    }

    // --- PHP pools ---------------------------------------------------------

    /// Creates a fake installed PHP 8.4.25 with the completion marker.
    fn fake_php_install(paths: &AppPaths) -> PathBuf {
        let install_dir = paths.runtimes_dir().join("php").join("8.4.25");
        std::fs::create_dir_all(&install_dir).expect("install dir");
        std::fs::write(install_dir.join(".devx-ok"), b"ok").expect("marker");
        install_dir
    }

    #[test]
    fn planning_an_uninstalled_php_version_is_not_found() {
        let dir = tempfile::tempdir().expect("temp");
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().expect("dirs");

        let err = plan_php_pool(&paths, "8.4.25", 9100, 4).expect_err("not installed");
        assert_eq!(err.code, devx_core::ErrorCode::NotFound);
    }

    #[test]
    fn planning_a_pool_renders_files_and_targets_php_cgi() {
        let dir = tempfile::tempdir().expect("temp");
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().expect("dirs");
        fake_php_install(&paths);

        let plan = plan_php_pool(&paths, "8.4.25", 9100, 4).expect("plan");
        assert_eq!(plan.id, "php-pool-8.4.25");

        let spec = pool_spec(&paths, &plan).expect("spec");

        // Both rendered files land in the pool's config directory…
        let config_dir = paths.service_config_dir().join("php-pool-8.4.25");
        assert!(config_dir.join("php.ini").is_file());
        assert!(config_dir.join("pool.conf").is_file());

        // …and the spec points php-cgi at that ini with the FastCGI port.
        assert!(spec.program.ends_with("php-cgi.exe"));
        assert_eq!(spec.args[1], "127.0.0.1:9100");
        assert!(spec
            .args
            .iter()
            .any(|arg| arg.ends_with("php-pool-8.4.25/php.ini")));
        assert!(spec
            .env
            .iter()
            .any(|(k, v)| k == "PHP_FCGI_CHILDREN" && v == "4"));
    }

    #[test]
    fn pool_ports_are_claimed_across_restarts() {
        let dir = tempfile::tempdir().expect("temp");
        let paths = AppPaths::rooted_at(dir.path());
        paths.ensure_dirs().expect("dirs");

        // A fresh tree has no claims, so the first port is the base port.
        assert_eq!(next_pool_port(&paths, &[]), devx_provision::FIRST_POOL_PORT);

        // A second pool planned in the same pass must skip it.
        assert_eq!(
            next_pool_port(&paths, &[devx_provision::FIRST_POOL_PORT]),
            devx_provision::FIRST_POOL_PORT + 1
        );

        // A pool whose rendered conf claims a port keeps it after a restart:
        // the next port is chosen past the claim.
        fake_php_install(&paths);
        let plan =
            plan_php_pool(&paths, "8.4.25", devx_provision::FIRST_POOL_PORT, 4).expect("plan");
        pool_spec(&paths, &plan).expect("spec");

        assert_eq!(
            next_pool_port(&paths, &[]),
            devx_provision::FIRST_POOL_PORT + 1
        );
    }
}
