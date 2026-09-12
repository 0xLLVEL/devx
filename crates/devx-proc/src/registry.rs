//! A registry of supervised services, keyed by id.
//!
//! The application owns one [`ServiceRegistry`]. It hands out shared handles to
//! supervisors so commands can start, stop and inspect a service by id without
//! the caller tracking the `Supervisor` objects themselves.

use std::collections::HashMap;
use std::sync::Arc;

use devx_core::{Error, Result};
use parking_lot::Mutex;

use crate::supervisor::{ProcessSpec, Supervisor};

/// Owns the supervisors for every registered service.
#[derive(Default)]
pub struct ServiceRegistry {
    services: Mutex<HashMap<String, Arc<Supervisor>>>,
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

        let supervisor = Arc::new(Supervisor::new(spec.clone()));
        services.insert(spec.id, supervisor.clone());
        Ok(supervisor)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use devx_core::ErrorCode;

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
}
