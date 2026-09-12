//! Service lifecycle state machine.
//!
//! A supervised process moves through a small set of states. Keeping the
//! transition rules in one place, as pure functions, lets the supervisor be
//! tested without spawning anything: the interesting logic (what a crash means,
//! when a restart is allowed) is decided here.

use serde::{Deserialize, Serialize};

/// Where a supervised service is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Not running, and not trying to.
    Stopped,
    /// Spawned, waiting for its health check to pass.
    Starting,
    /// Running and healthy.
    Running,
    /// Asked to stop, waiting for the process to exit.
    Stopping,
    /// Exited unexpectedly, or failed to start.
    Failed,
}

impl ServiceState {
    /// Whether the service is doing anything, healthy or not.
    ///
    /// Used to decide if a stop request has work to do.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }

    /// Whether a start request is meaningful from this state.
    pub fn can_start(self) -> bool {
        matches!(self, Self::Stopped | Self::Failed)
    }
}

/// Why a service left the `Running` or `Starting` state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExitReason {
    /// A stop was requested and the process exited.
    Requested,
    /// The process exited on its own, with this code.
    Crashed {
        /// Process exit code, when known.
        code: Option<i32>,
    },
    /// The health check never passed within the allowed time.
    HealthTimeout,
    /// The process could not be spawned at all.
    SpawnFailed {
        /// Human-readable reason.
        message: String,
    },
}

impl ExitReason {
    /// Whether this reason should count against the restart budget.
    ///
    /// A requested stop is not a failure; everything else is.
    pub fn is_failure(&self) -> bool {
        !matches!(self, Self::Requested)
    }
}

/// Point-in-time resource use of one supervised service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ServiceMetrics {
    /// Id of the supervised service.
    pub id: String,
    /// Current lifecycle state.
    pub state: ServiceState,
    /// CPU use since the previous sample, normalised to one core (0–100).
    pub cpu_percent: f64,
    /// Resident memory of every process in the service's job, in bytes.
    #[specta(type = specta_typescript::Number)]
    pub memory_bytes: u64,
    /// How many live processes the job contains.
    pub processes: u32,
}

/// A state transition announced by a supervisor.
///
/// Published on a registry-wide broadcast channel so a single subscriber can
/// observe every service at once; `exit` carries why the service left the
/// running state, when it did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ServiceEvent {
    /// Id of the supervised service.
    pub id: String,
    /// The state it moved to.
    pub state: ServiceState,
    /// Why it left the running state, if it did.
    pub exit: Option<ExitReason>,
}

/// Decides whether a failed service should be restarted, given its policy and
/// how many times it has already failed in the current window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RestartPolicy {
    /// Never restart automatically.
    Never,
    /// Restart on failure, up to `max_retries` times before giving up.
    OnFailure {
        /// Attempts allowed within the failure window.
        max_retries: u32,
    },
}

impl RestartPolicy {
    /// Whether a restart is allowed after `failures` prior failures.
    pub fn allows_restart(self, failures: u32) -> bool {
        match self {
            Self::Never => false,
            Self::OnFailure { max_retries } => failures < max_retries,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_states_are_the_in_flight_ones() {
        assert!(ServiceState::Starting.is_active());
        assert!(ServiceState::Running.is_active());
        assert!(ServiceState::Stopping.is_active());
        assert!(!ServiceState::Stopped.is_active());
        assert!(!ServiceState::Failed.is_active());
    }

    #[test]
    fn start_is_only_meaningful_from_rest() {
        assert!(ServiceState::Stopped.can_start());
        assert!(ServiceState::Failed.can_start());
        assert!(!ServiceState::Running.can_start());
        assert!(!ServiceState::Starting.can_start());
    }

    #[test]
    fn only_a_requested_stop_is_not_a_failure() {
        assert!(!ExitReason::Requested.is_failure());
        assert!(ExitReason::Crashed { code: Some(1) }.is_failure());
        assert!(ExitReason::HealthTimeout.is_failure());
        assert!(ExitReason::SpawnFailed {
            message: "boom".into()
        }
        .is_failure());
    }

    #[test]
    fn never_policy_forbids_restart() {
        assert!(!RestartPolicy::Never.allows_restart(0));
    }

    #[test]
    fn on_failure_policy_respects_the_budget() {
        let policy = RestartPolicy::OnFailure { max_retries: 3 };
        assert!(policy.allows_restart(0));
        assert!(policy.allows_restart(2));
        assert!(!policy.allows_restart(3));
        assert!(!policy.allows_restart(4));
    }
}
