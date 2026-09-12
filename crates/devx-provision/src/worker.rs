//! User-configured supervised worker processes.
//!
//! A *worker* is any long-running command the user attaches to DevX's
//! supervisor — a Laravel `queue:work`, a Node consumer, a watcher. Unlike the
//! seven services and the PHP pools, workers have no baked-in definition: the
//! user provides either a program (a path or a `PATH` name) or a DevX-managed
//! PHP version, plus arguments and a working directory, and DevX runs one
//! supervised process per configured instance.
//!
//! Like the pools, everything here is pure: the module computes what *would*
//! run; the desktop shell turns the result into a [`devx_proc::ProcessSpec`].

use std::path::{Path, PathBuf};

use devx_core::{Error, Result};
use serde::Serialize;

/// Stable prefix for worker identifiers: `worker-queue-1`.
const WORKER_ID_PREFIX: &str = "worker-";

/// Identifier of worker instance `instance` (1-based) of `name`.
pub fn worker_id(name: &str, instance: u32) -> String {
    format!("{WORKER_ID_PREFIX}{name}-{instance}")
}

/// Whether `id` identifies a worker instance.
pub fn is_worker_id(id: &str) -> bool {
    id.starts_with(WORKER_ID_PREFIX)
        && id
            .rsplit('-')
            .next()
            .is_some_and(|tail| tail.parse::<u32>().is_ok())
}

/// Everything needed to run one worker instance, produced by [`plan_worker`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct WorkerPlan {
    /// Stable supervisor id: `worker-<name>-<instance>`.
    pub id: String,
    /// The user-chosen worker name.
    pub name: String,
    /// Which copy of the worker this is, 1-based.
    pub instance: u32,
    /// Executable to run.
    pub program: PathBuf,
    /// Launch arguments.
    pub args: Vec<String>,
    /// Directory the process runs in.
    pub working_dir: PathBuf,
}

/// Plans (but does not start) one instance of a configured worker.
///
/// Instances share everything but the id, so this is the canonical plan; see
/// [`plan_worker_instances`] for the per-instance list. `runtimes_dir` is the
/// `runtimes/` directory, used to resolve a `php_version` worker's `php.exe`
/// the same way the pools do.
///
/// # Errors
///
/// Fails when the worker definition is ambiguous (both or neither of
/// `program`/`php_version`) — [`devx_core::Config::validate`] normally catches
/// this first, so this is a belt-and-braces check.
pub fn plan_worker(worker: &devx_core::Worker, runtimes_dir: &Path) -> Result<WorkerPlan> {
    plan_instance(worker, runtimes_dir, 1)
}

/// Plans every instance of a worker, `1..=instances`.
pub fn plan_worker_instances(
    worker: &devx_core::Worker,
    runtimes_dir: &Path,
) -> Result<Vec<WorkerPlan>> {
    (1..=worker.instances)
        .map(|instance| plan_instance(worker, runtimes_dir, instance))
        .collect()
}

/// Plans one specific instance of a worker.
fn plan_instance(
    worker: &devx_core::Worker,
    runtimes_dir: &Path,
    instance: u32,
) -> Result<WorkerPlan> {
    let program = match (&worker.program, &worker.php_version) {
        (Some(program), None) => PathBuf::from(program),
        (None, Some(version)) => runtimes_dir
            .join("php")
            .join(sanitize(version))
            .join("php.exe"),
        _ => {
            return Err(Error::invalid_input(format!(
                "worker `{}` must set exactly one of program or php_version",
                worker.name
            )))
        }
    };

    Ok(WorkerPlan {
        id: worker_id(&worker.name, instance),
        name: worker.name.clone(),
        instance,
        program,
        args: worker.args.clone(),
        working_dir: PathBuf::from(&worker.working_dir),
    })
}

/// Replaces characters a Windows directory name cannot carry.
///
/// Matches the installer's per-version layout (`runtimes/php/<version>`), so a
/// worker's `php.exe` resolves to exactly the path the pools use.
fn sanitize(version: &str) -> String {
    version
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use devx_core::{ErrorCode, Worker};

    fn worker(name: &str) -> Worker {
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
    fn worker_ids_carry_name_and_instance() {
        assert_eq!(worker_id("queue", 1), "worker-queue-1");
        assert_eq!(worker_id("queue", 12), "worker-queue-12");
        assert!(is_worker_id("worker-queue-1"));
        assert!(!is_worker_id("nginx"));
        assert!(!is_worker_id("worker-queue"), "no instance suffix");
    }

    #[test]
    fn a_program_worker_resolves_as_given() {
        let plan = plan_worker(&worker("queue"), Path::new("C:/devx/data/runtimes")).expect("plan");

        assert_eq!(plan.id, "worker-queue-1");
        assert_eq!(plan.program, PathBuf::from(r"C:\tools\worker.exe"));
        assert_eq!(plan.args, ["--loop"]);
        assert_eq!(plan.working_dir, PathBuf::from(r"C:\project"));
    }

    #[test]
    fn a_php_worker_resolves_through_the_runtime_layout() {
        let mut definition = worker("queue");
        definition.program = None;
        definition.php_version = Some("8.4.25".to_owned());

        let plan = plan_worker(&definition, Path::new("C:/devx/data/runtimes")).expect("plan");
        assert_eq!(
            plan.program,
            PathBuf::from("C:/devx/data/runtimes/php/8.4.25/php.exe")
        );
    }

    #[test]
    fn a_php_worker_sanitises_unsafe_version_characters() {
        let mut definition = worker("queue");
        definition.program = None;
        definition.php_version = Some(r"weird/ver:sion".to_owned());

        let plan = plan_worker(&definition, Path::new("C:/devx/data/runtimes")).expect("plan");
        assert_eq!(
            plan.program,
            PathBuf::from("C:/devx/data/runtimes/php/weird_ver_sion/php.exe")
        );
    }

    #[test]
    fn an_ambiguous_worker_is_rejected() {
        let mut definition = worker("queue");
        definition.php_version = Some("8.4.25".to_owned());

        let err = plan_worker(&definition, Path::new("C:/runtimes"))
            .expect_err("both sources must be refused");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn instances_plan_into_disjoint_ids() {
        let mut definition = worker("queue");
        definition.instances = 3;

        let plans = plan_worker_instances(&definition, Path::new("C:/runtimes")).expect("plans");
        assert_eq!(
            plans.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["worker-queue-1", "worker-queue-2", "worker-queue-3"]
        );
    }
}
