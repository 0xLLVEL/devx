//! The process supervisor.
//!
//! One [`Supervisor`] owns one child process across its lifecycle: it spawns the
//! process into a job object, pumps its output into the log ring and the rotated
//! log file, runs the health check to decide when it is `Running`, and reacts to
//! exit by restarting (within the policy budget) or settling into `Failed`.
//!
//! The public surface is deliberately small: `start`, `stop`, `state`, and log
//! accessors. Everything else is an internal task communicating over channels.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use devx_core::{Error, ErrorCode, Result};
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, watch};

use crate::health::HealthCheck;
use crate::logbuf::{LogLine, LogRing, LogStream};
use crate::logfile::RotatingLog;
use crate::state::{ExitReason, RestartPolicy, ServiceEvent, ServiceState};

/// How to launch and supervise a process.
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    /// Stable identifier, used in log file names and diagnostics.
    pub id: String,
    /// Executable to run.
    pub program: PathBuf,
    /// Arguments.
    pub args: Vec<String>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
    /// Working directory, if any.
    pub working_dir: Option<PathBuf>,
    /// How readiness is observed.
    pub health: HealthCheck,
    /// How long to wait for the health check before declaring a failure.
    pub health_timeout: Duration,
    /// Restart behaviour after an unexpected exit.
    pub restart: RestartPolicy,
    /// Directory for the rotated log file.
    pub log_dir: PathBuf,
    /// Lines kept in the in-memory tail.
    pub log_ring_capacity: usize,
    /// Size at which the log file rotates.
    pub log_max_bytes: u64,
}

impl ProcessSpec {
    /// A spec with sensible defaults for the given identity and program.
    pub fn new(
        id: impl Into<String>,
        program: impl Into<PathBuf>,
        log_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            id: id.into(),
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            working_dir: None,
            health: HealthCheck::Uptime(Duration::from_millis(300)),
            health_timeout: Duration::from_secs(30),
            restart: RestartPolicy::OnFailure { max_retries: 3 },
            log_dir: log_dir.into(),
            log_ring_capacity: 1000,
            log_max_bytes: 5 * 1024 * 1024,
        }
    }
}

/// Shared, observable state of a supervised service.
#[derive(Debug)]
struct Shared {
    state: watch::Sender<ServiceState>,
    logs: Mutex<LogRing>,
    last_exit: Mutex<Option<ExitReason>>,
    /// Registry-wide event bus; `None` when the supervisor is standalone.
    events: Option<broadcast::Sender<ServiceEvent>>,
    /// Job object of the current child, kept alive while it runs so metrics
    /// can enumerate its processes.
    #[cfg(windows)]
    job: Mutex<Option<Arc<crate::job::JobObject>>>,
    /// Previous CPU reading, for the next metrics delta.
    #[cfg(windows)]
    last_sample: Mutex<Option<crate::metrics::Sample>>,
}

/// Supervises one process across its lifecycle.
pub struct Supervisor {
    spec: ProcessSpec,
    shared: Arc<Shared>,
    state_rx: watch::Receiver<ServiceState>,
    /// Signals the running control loop to stop; `None` when not running.
    stopper: Mutex<Option<StopHandle>>,
}

/// Handle used to ask the control loop to stop and await its completion.
struct StopHandle {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Supervisor {
    /// Creates a supervisor for `spec` in the `Stopped` state.
    pub fn new(spec: ProcessSpec) -> Self {
        Self::with_events(spec, None)
    }

    /// Creates a supervisor that publishes transitions on the registry's event
    /// bus. Standalone supervisors (tests, the CLI) pass `None`.
    pub fn with_events(spec: ProcessSpec, events: Option<broadcast::Sender<ServiceEvent>>) -> Self {
        let (state_tx, state_rx) = watch::channel(ServiceState::Stopped);
        let shared = Arc::new(Shared {
            state: state_tx,
            logs: Mutex::new(LogRing::new(spec.log_ring_capacity)),
            last_exit: Mutex::new(None),
            events,
            #[cfg(windows)]
            job: Mutex::new(None),
            #[cfg(windows)]
            last_sample: Mutex::new(None),
        });

        Self {
            spec,
            shared,
            state_rx,
            stopper: Mutex::new(None),
        }
    }

    /// Current state.
    pub fn state(&self) -> ServiceState {
        *self.state_rx.borrow()
    }

    /// The service's id.
    pub fn id(&self) -> &str {
        &self.spec.id
    }

    /// Samples the CPU and memory use of the supervised job, when one is live.
    ///
    /// Returns `None` when the service has never spawned, has already exited,
    /// or the OS query failed; metrics are best-effort.
    #[cfg(windows)]
    pub fn metrics(&self) -> Option<crate::metrics::RawMetrics> {
        let job = self.shared.job.lock().clone()?;
        crate::metrics::sample_job(&job, &mut self.shared.last_sample.lock())
    }

    /// Non-Windows stub: no job objects to sample.
    #[cfg(not(windows))]
    pub fn metrics(&self) -> Option<crate::metrics::RawMetrics> {
        None
    }

    /// The TCP port the health check probes, when the check is a port.
    ///
    /// The browser and service cards read this to show which port a
    /// running service actually bound, including reassigned ones.
    pub fn health_port(&self) -> Option<u16> {
        match &self.spec.health {
            HealthCheck::TcpPort(port) => Some(*port),
            _ => None,
        }
    }

    /// A receiver for observing state changes.
    pub fn subscribe(&self) -> watch::Receiver<ServiceState> {
        self.state_rx.clone()
    }

    /// Snapshot of the retained log tail.
    pub fn logs(&self) -> Vec<LogLine> {
        self.shared.logs.lock().snapshot()
    }

    /// Log lines newer than `after`.
    pub fn logs_since(&self, after: u64) -> Vec<LogLine> {
        self.shared.logs.lock().since(after)
    }

    /// Why the service last left the running state, if it has.
    pub fn last_exit(&self) -> Option<ExitReason> {
        self.shared.last_exit.lock().clone()
    }

    /// Starts the service, returning once it is `Running` or has `Failed`.
    ///
    /// Idempotent for an already-active service. The control loop keeps running
    /// in the background to supervise restarts.
    pub async fn start(&self) -> Result<()> {
        if self.state().is_active() {
            return Ok(());
        }

        let (stop_tx, stop_rx) = watch::channel(false);
        let spec = self.spec.clone();
        let shared = self.shared.clone();

        let task = tokio::spawn(async move {
            control_loop(spec, shared, stop_rx).await;
        });

        *self.stopper.lock() = Some(StopHandle {
            stop: stop_tx,
            task,
        });

        // Wait for the loop to reach a terminal-for-start state.
        let mut rx = self.state_rx.clone();
        loop {
            let current = *rx.borrow_and_update();
            match current {
                ServiceState::Running => return Ok(()),
                ServiceState::Failed => {
                    let reason = self.last_exit();
                    return Err(spawn_error(&self.spec.id, reason));
                }
                _ => {}
            }
            if rx.changed().await.is_err() {
                return Err(Error::new(
                    ErrorCode::Process,
                    format!("supervisor for `{}` stopped unexpectedly", self.spec.id),
                ));
            }
        }
    }

    /// Stops the service and waits for the process to exit.
    ///
    /// Idempotent for an already-stopped service.
    pub async fn stop(&self) {
        let handle = self.stopper.lock().take();
        if let Some(handle) = handle {
            let _ = handle.stop.send(true);
            let _ = handle.task.await;
        }
    }
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Supervisor")
            .field("id", &self.spec.id)
            .field("state", &self.state())
            .finish_non_exhaustive()
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // Signal the loop to stop; the job object (owned inside the loop) is
        // dropped when the task ends, killing the child. We cannot await here,
        // but the signal plus job-object teardown prevents an orphan.
        if let Some(handle) = self.stopper.lock().take() {
            let _ = handle.stop.send(true);
            handle.task.abort();
        }
    }
}

/// Clears the shared job-object slot when the run cycle ends.
///
/// The job's `KILL_ON_JOB_CLOSE` semantics are the orphan-proofing, so the
/// handle must close when the child's run does — not when the supervisor is
/// eventually dropped.
#[cfg(windows)]
struct JobSlotGuard<'a> {
    slot: &'a Mutex<Option<Arc<crate::job::JobObject>>>,
}

#[cfg(windows)]
impl Drop for JobSlotGuard<'_> {
    fn drop(&mut self) {
        *self.slot.lock() = None;
    }
}

/// Builds an error describing why a start failed.
fn spawn_error(id: &str, reason: Option<ExitReason>) -> Error {
    match reason {
        Some(ExitReason::SpawnFailed { message }) => Error::new(
            ErrorCode::Process,
            format!("failed to start `{id}`: {message}"),
        ),
        Some(ExitReason::HealthTimeout) => Error::new(
            ErrorCode::Process,
            format!("`{id}` started but never became healthy"),
        )
        .with_hint("check the service logs for a startup error"),
        Some(ExitReason::Crashed { code }) => Error::new(
            ErrorCode::Process,
            format!("`{id}` exited during startup with code {code:?}"),
        ),
        _ => Error::new(ErrorCode::Process, format!("`{id}` failed to start")),
    }
}

/// Sets the observable state and announces the transition on the event bus.
fn set_state(shared: &Shared, id: &str, state: ServiceState, exit: Option<ExitReason>) {
    let _ = shared.state.send(state);
    if let Some(events) = &shared.events {
        let _ = events.send(ServiceEvent {
            id: id.to_owned(),
            state,
            exit,
        });
    }
}

/// The background loop: spawn, supervise, restart within budget.
async fn control_loop(spec: ProcessSpec, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut failures = 0u32;

    loop {
        if *stop.borrow() {
            break;
        }

        set_state(&shared, &spec.id, ServiceState::Starting, None);
        let outcome = run_once(&spec, &shared, &mut stop).await;

        *shared.last_exit.lock() = Some(outcome.clone());

        match &outcome {
            ExitReason::Requested => {
                set_state(
                    &shared,
                    &spec.id,
                    ServiceState::Stopped,
                    Some(outcome.clone()),
                );
                break;
            }
            reason if reason.is_failure() => {
                failures += 1;
                if *stop.borrow() {
                    set_state(
                        &shared,
                        &spec.id,
                        ServiceState::Stopped,
                        Some(outcome.clone()),
                    );
                    break;
                }
                if spec.restart.allows_restart(failures) {
                    // Backoff grows with consecutive failures, capped so a
                    // permanently broken service does not wait minutes.
                    let backoff = restart_backoff(failures);
                    tracing::warn!(id = %spec.id, failures, ?backoff, "restarting after failure");
                    set_state(
                        &shared,
                        &spec.id,
                        ServiceState::Failed,
                        Some(outcome.clone()),
                    );
                    if wait_or_stop(&mut stop, backoff).await {
                        set_state(
                            &shared,
                            &spec.id,
                            ServiceState::Stopped,
                            Some(outcome.clone()),
                        );
                        break;
                    }
                } else {
                    tracing::error!(id = %spec.id, failures, "giving up after repeated failures");
                    set_state(
                        &shared,
                        &spec.id,
                        ServiceState::Failed,
                        Some(outcome.clone()),
                    );
                    break;
                }
            }
            _ => {
                set_state(
                    &shared,
                    &spec.id,
                    ServiceState::Stopped,
                    Some(outcome.clone()),
                );
                break;
            }
        }
    }
}

/// Backoff before the Nth restart, capped at 10s.
fn restart_backoff(failures: u32) -> Duration {
    let secs = 2u64.saturating_pow(failures.saturating_sub(1)).min(10);
    Duration::from_secs(secs)
}

/// Sleeps for `dur`, returning `true` if a stop was requested meanwhile.
async fn wait_or_stop(stop: &mut watch::Receiver<bool>, dur: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(dur) => *stop.borrow(),
        changed = stop.changed() => changed.is_ok() && *stop.borrow(),
    }
}

/// One spawn-to-exit cycle. Returns why the process left.
async fn run_once(
    spec: &ProcessSpec,
    shared: &Arc<Shared>,
    stop: &mut watch::Receiver<bool>,
) -> ExitReason {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(k, v)| (k.clone(), v.clone())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &spec.working_dir {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash a console window for each child.
        command.creation_flags(0x0800_0000);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return ExitReason::SpawnFailed {
                message: err.to_string(),
            }
        }
    };

    // Assign to a job object so the child cannot outlive this supervisor. The
    // handle is parked in `shared` so metrics can enumerate its processes
    // while it runs; the guard below closes it on every exit path, which is
    // what kills any descendants a stop request did not reach directly.
    #[cfg(windows)]
    let _job_guard = match assign_to_job(&child) {
        Ok(job) => {
            *shared.job.lock() = Some(Arc::new(job));
            Some(JobSlotGuard { slot: &shared.job })
        }
        Err(err) => {
            tracing::error!(id = %spec.id, error = %err, "failed to jail process; killing it");
            let _ = child.start_kill();
            let _ = child.wait().await;
            return ExitReason::SpawnFailed {
                message: format!("could not assign to job object: {err}"),
            };
        }
    };

    // Pump stdout and stderr into the log ring and file.
    let log_path = spec.log_dir.join(format!("{}.log", spec.id));
    let (ready_tx, mut ready_rx) = watch::channel(false);
    let mut log_tasks = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        log_tasks.push(spawn_log_pump(
            stdout,
            LogStream::Stdout,
            shared.clone(),
            spec.health.clone(),
            ready_tx.clone(),
            log_path.clone(),
            spec.log_max_bytes,
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        log_tasks.push(spawn_log_pump(
            stderr,
            LogStream::Stderr,
            shared.clone(),
            spec.health.clone(),
            ready_tx,
            log_path,
            spec.log_max_bytes,
        ));
    }

    // Wait until the health check passes, the process exits, a stop is asked,
    // or the health timeout elapses.
    let health = spec.health.clone();
    let deadline = tokio::time::sleep(spec.health_timeout);
    tokio::pin!(deadline);

    let become_ready = async {
        match &health {
            HealthCheck::Uptime(dur) => {
                tokio::time::sleep(*dur).await;
            }
            HealthCheck::TcpPort(port) => wait_for_tcp(*port).await,
            HealthCheck::LogContains(_) => {
                // The log pump flips `ready` when a matching line appears.
                while ready_rx.changed().await.is_ok() {
                    if *ready_rx.borrow() {
                        break;
                    }
                }
            }
        }
    };

    tokio::select! {
        _ = become_ready => {
            set_state(shared, &spec.id, ServiceState::Running, None);
        }
        status = child.wait() => {
            // Exited before ever becoming healthy.
            return exit_reason_from_status(status);
        }
        _ = stop.changed() => {
            if *stop.borrow() {
                return stop_child(&mut child).await;
            }
        }
        _ = &mut deadline => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return ExitReason::HealthTimeout;
        }
    }

    // Running: wait for exit or a stop request.
    let reason = tokio::select! {
        status = child.wait() => exit_reason_from_status(status),
        _ = stop.changed() => {
            if *stop.borrow() {
                stop_child(&mut child).await
            } else {
                // Spurious change; wait for real exit.
                exit_reason_from_status(child.wait().await)
            }
        }
    };

    for task in log_tasks {
        task.abort();
    }

    reason
}

/// Assigns the child to a fresh job object.
#[cfg(windows)]
fn assign_to_job(child: &tokio::process::Child) -> Result<crate::job::JobObject> {
    use windows::Win32::Foundation::HANDLE;

    let raw = child
        .raw_handle()
        .ok_or_else(|| Error::new(ErrorCode::Process, "child has no handle"))?;
    let job = crate::job::JobObject::new()?;
    // SAFETY: the child is alive; its handle is valid for this call.
    unsafe {
        job.assign(HANDLE(raw as _))?;
    }
    Ok(job)
}

/// Interprets a process exit status as an [`ExitReason`].
fn exit_reason_from_status(status: std::io::Result<std::process::ExitStatus>) -> ExitReason {
    match status {
        Ok(status) if status.success() => ExitReason::Crashed { code: Some(0) },
        Ok(status) => ExitReason::Crashed {
            code: status.code(),
        },
        Err(err) => ExitReason::SpawnFailed {
            message: err.to_string(),
        },
    }
}

/// Requests a graceful stop, then waits for the child to exit.
async fn stop_child(child: &mut tokio::process::Child) -> ExitReason {
    // On Windows there is no SIGTERM; `start_kill` terminates the process, and
    // the job object guarantees any descendants go with it.
    let _ = child.start_kill();
    let _ = child.wait().await;
    ExitReason::Requested
}

/// Attempts a TCP connection until it succeeds.
async fn wait_for_tcp(port: u16) {
    loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(_) => return,
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// Spawns a task that reads lines from `reader` into the log ring and file.
fn spawn_log_pump<R>(
    reader: R,
    stream: LogStream,
    shared: Arc<Shared>,
    health: HealthCheck,
    ready: watch::Sender<bool>,
    log_path: PathBuf,
    max_bytes: u64,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut file = RotatingLog::open(&log_path, max_bytes).ok();
        let mut lines = BufReader::new(reader).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if crate::health::log_line_signals_ready(&health, &line) {
                let _ = ready.send(true);
            }
            if let Some(file) = file.as_mut() {
                let _ = file.write_line(&line);
            }
            shared.logs.lock().push(stream, line);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(restart_backoff(1), Duration::from_secs(1));
        assert_eq!(restart_backoff(2), Duration::from_secs(2));
        assert_eq!(restart_backoff(3), Duration::from_secs(4));
        assert_eq!(restart_backoff(4), Duration::from_secs(8));
        assert_eq!(restart_backoff(5), Duration::from_secs(10), "capped");
        assert_eq!(restart_backoff(20), Duration::from_secs(10), "capped");
    }

    #[test]
    fn default_spec_has_reasonable_values() {
        let spec = ProcessSpec::new("nginx", "nginx.exe", "C:\\logs");
        assert_eq!(spec.id, "nginx");
        assert!(matches!(spec.restart, RestartPolicy::OnFailure { .. }));
        assert!(spec.log_ring_capacity > 0);
    }
}
