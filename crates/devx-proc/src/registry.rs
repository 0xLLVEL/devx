//! A registry of supervised services, keyed by id.
//!
//! The application owns one [`ServiceRegistry`]. It hands out shared handles to
//! supervisors so commands can start, stop and inspect a service by id without
//! the caller tracking the `Supervisor` objects themselves.

use std::collections::HashMap;
use std::sync::Arc;

use devx_core::{Error, Result};
use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::state::ServiceEvent;
use crate::supervisor::{ProcessSpec, Supervisor};

/// Capacity of the registry-wide event bus.
const EVENT_BUS_CAPACITY: usize = 64;

/// Owns the supervisors for every registered service.
pub struct ServiceRegistry {
    services: Mutex<HashMap<String, Arc<Supervisor>>>,
    events: broadcast::Sender<ServiceEvent>,
}

impl Default for ServiceRegistry {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        Self {
            services: Mutex::default(),
            events,
        }
    }
}

impl ServiceRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a service from its spec, replacing any prior registration.
    ///
    /// Replacing is only allowed when the previous supervisor is not active, so
    /// a running service cannot be silently swapped out from under itself.
    pub fn register(&self, spec: ProcessSpec) -> Result<Arc<Supervisor>> {
        let mut services = self.services.lock();

        if let Some(existing) = services.get(&spec.id) {
            if existing.state().is_active() {
                return Err(Error::conflict(format!(
                    "service `{}` is already registered and active",
                    spec.id
                )));
            }
        }

        let supervisor = Arc::new(Supervisor::with_events(
            spec.clone(),
            Some(self.events.clone()),
        ));
        services.insert(spec.id, supervisor.clone());
        Ok(supervisor)
    }

    /// Replaces the supervisor for `spec.id` with one built from `spec`,
    /// absorbing the dance every re-registration needs: an active supervisor
    /// is stopped first, because [`ServiceRegistry::register`] refuses to
    /// swap one out from under itself.
    ///
    /// The returned supervisor is registered but **not** started; callers
    /// decide whether to launch immediately (a config change that restarts a
    /// running service) or leave it stopped (a re-plan before the next start).
    pub async fn replace(&self, spec: ProcessSpec) -> Result<Arc<Supervisor>> {
        if let Some(existing) = self.get(&spec.id) {
            if existing.state().is_active() {
                existing.stop().await;
            }
        }
        self.register(spec)
    }

    /// Registers and starts a service, or reuses the registered supervisor
    /// when it is already active.
    ///
    /// This is the idempotent start every start command wants: an active
    /// supervisor is returned as-is (its spec is not refreshed), a stopped or
    /// failed one is replaced from `spec` and launched. One-time init steps
    /// remain the caller's job, since they precede planning.
    pub async fn register_or_active(&self, spec: ProcessSpec) -> Result<Arc<Supervisor>> {
        if let Some(existing) = self.get(&spec.id) {
            if existing.state().is_active() {
                return Ok(existing);
            }
        }
        let supervisor = self.register(spec)?;
        supervisor.start().await?;
        Ok(supervisor)
    }

    /// Subscribes to state transitions of every registered service.
    ///
    /// The returned receiver lags (not errors) if it falls behind the bus
    /// capacity; callers should treat `RecvError::Lagged` as "resync by
    /// polling", not as a failure.
    pub fn events(&self) -> broadcast::Receiver<ServiceEvent> {
        self.events.subscribe()
    }

    /// Returns the supervisor for `id`, if registered.
    pub fn get(&self, id: &str) -> Option<Arc<Supervisor>> {
        self.services.lock().get(id).cloned()
    }

    /// Returns the supervisor for `id`, or a not-found error.
    pub fn require(&self, id: &str) -> Result<Arc<Supervisor>> {
        self.get(id)
            .ok_or_else(|| Error::not_found(format!("service `{id}` is not registered")))
    }

    /// Whether a service is registered.
    pub fn contains(&self, id: &str) -> bool {
        self.services.lock().contains_key(id)
    }

    /// Ids of every registered service.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.services.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// The TCP port a registered service's health check probes, if any.
    ///
    /// For port-checked services (databases, mail, admin UIs) this is the port
    /// the service actually bound — including any reassigned one — which is
    /// what connection dialogs should target.
    pub fn port_of(&self, id: &str) -> Option<u16> {
        self.get(id).and_then(|supervisor| supervisor.health_port())
    }

    /// Point-in-time CPU and memory use of every registered service.
    ///
    /// Services without a live job (stopped, failed to spawn) report zero
    /// usage; the entry is still present so callers can zip it against the
    /// service list.
    pub fn metrics(&self) -> Vec<crate::state::ServiceMetrics> {
        self.services
            .lock()
            .values()
            .map(|supervisor| {
                let raw = supervisor.metrics();
                crate::state::ServiceMetrics {
                    id: supervisor.id().to_owned(),
                    state: supervisor.state(),
                    cpu_percent: raw.map(|m| m.cpu_percent).unwrap_or(0.0),
                    memory_bytes: raw.map(|m| m.memory_bytes).unwrap_or(0),
                    processes: raw.map(|m| m.processes).unwrap_or(0),
                }
            })
            .collect()
    }

    /// Stops every registered active service concurrently and waits for them to exit.
    pub async fn stop_all(&self) {
        let active: Vec<Arc<Supervisor>> = self
            .services
            .lock()
            .values()
            .filter(|s| s.state().is_active())
            .cloned()
            .collect();

        if active.is_empty() {
            return;
        }

        let mut jobs = tokio::task::JoinSet::new();
        for supervisor in active {
            jobs.spawn(async move {
                supervisor.stop().await;
            });
        }
        while jobs.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ServiceState;
    use crate::{ExitReason, HealthCheck, RestartPolicy};
    use devx_core::ErrorCode;
    use std::time::Duration;

    fn spec(id: &str) -> ProcessSpec {
        ProcessSpec::new(id, "cmd", std::env::temp_dir())
    }

    #[test]
    fn registers_and_retrieves_by_id() {
        let registry = ServiceRegistry::new();
        registry.register(spec("mailpit")).expect("register");

        assert!(registry.contains("mailpit"));
        assert!(registry.get("mailpit").is_some());
        assert_eq!(registry.ids(), vec!["mailpit".to_owned()]);
    }

    #[test]
    fn require_reports_not_found() {
        let registry = ServiceRegistry::new();
        let err = registry.require("nope").expect_err("must fail");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn re_registering_an_inactive_service_replaces_it() {
        let registry = ServiceRegistry::new();
        registry.register(spec("redis")).expect("first");
        // Not started, so replacing is allowed.
        registry.register(spec("redis")).expect("replace");
        assert_eq!(registry.ids().len(), 1);
    }

    #[tokio::test]
    async fn replace_on_an_inactive_service_never_stops_it() {
        let registry = ServiceRegistry::new();
        registry.register(spec("redis")).expect("first");

        // The replaced supervisor is registered but not started, so `replace`
        // must not need a stop to get there.
        let replacement = registry.replace(spec("redis")).await.expect("replace");
        assert_eq!(replacement.state(), ServiceState::Stopped);
        assert_eq!(registry.ids().len(), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn publishes_state_transitions_on_the_event_bus() {
        let registry = ServiceRegistry::new();
        let mut events = registry.events();

        let mut crashing = spec("crasher");
        crashing.args = vec!["/c".into(), "exit 1".into()];
        // Long enough that the child exits before the check passes.
        crashing.health = HealthCheck::Uptime(Duration::from_secs(10));
        crashing.restart = RestartPolicy::Never;
        let supervisor = registry.register(crashing).expect("register");
        supervisor.start().await.expect_err("exit 1 must fail");

        let mut saw_failed = None;
        while saw_failed.is_none() {
            match events.try_recv() {
                Ok(event) if event.state == ServiceState::Failed => {
                    saw_failed = Some(event);
                }
                Ok(_) => continue,
                // Skip lagged ticks; nothing else is being published here.
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }

        let event = saw_failed.expect("a Failed event must have been published");
        assert_eq!(event.id, "crasher");
        assert!(
            matches!(event.exit, Some(ExitReason::Crashed { .. })),
            "the crash reason must travel with the event, got {:?}",
            event.exit
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stop_all_stops_active_services() {
        let registry = ServiceRegistry::new();
        let mut s1 = spec("ping1");
        s1.args = vec![
            "/c".into(),
            "ping".into(),
            "-n".into(),
            "10".into(),
            "127.0.0.1".into(),
        ];
        s1.health = HealthCheck::Uptime(Duration::from_millis(200));
        s1.health_timeout = Duration::from_secs(5);
        s1.restart = RestartPolicy::Never;
        let sup1 = registry.register(s1).expect("register 1");

        let mut s2 = spec("ping2");
        s2.args = vec![
            "/c".into(),
            "ping".into(),
            "-n".into(),
            "10".into(),
            "127.0.0.1".into(),
        ];
        s2.health = HealthCheck::Uptime(Duration::from_millis(200));
        s2.health_timeout = Duration::from_secs(5);
        s2.restart = RestartPolicy::Never;
        let sup2 = registry.register(s2).expect("register 2");

        sup1.start().await.expect("start 1");
        sup2.start().await.expect("start 2");

        assert_eq!(sup1.state(), ServiceState::Running);
        assert_eq!(sup2.state(), ServiceState::Running);

        registry.stop_all().await;

        assert_eq!(sup1.state(), ServiceState::Stopped);
        assert_eq!(sup2.state(), ServiceState::Stopped);
    }
}
