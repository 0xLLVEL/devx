//! Port allocation with conflict detection.
//!
//! A service has a preferred port (nginx wants 80, MariaDB wants 3306). If it is
//! free, use it. If not, DevX needs to either explain who holds it or offer the
//! next free port. The "who holds it" data comes from the OS; this module turns
//! it into a decision.
//!
//! The check is injected as a closure so the allocation logic is tested without
//! touching the real network stack.

use serde::Serialize;

/// Outcome of trying to place a service on a port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PortDecision {
    /// The preferred port is free.
    Available {
        /// The port to use.
        port: u16,
    },
    /// The preferred port is taken; an alternative was found.
    Reassigned {
        /// The originally requested port.
        requested: u16,
        /// A free port to use instead.
        port: u16,
        /// Who holds the requested port, if known.
        held_by: Option<String>,
    },
    /// The preferred port is taken and no alternative was free.
    Unavailable {
        /// The requested port.
        requested: u16,
        /// Who holds it, if known.
        held_by: Option<String>,
    },
}

impl PortDecision {
    /// The port to actually use, if the service can start.
    pub fn resolved_port(&self) -> Option<u16> {
        match self {
            Self::Available { port } | Self::Reassigned { port, .. } => Some(*port),
            Self::Unavailable { .. } => None,
        }
    }
}

/// Allocates ports, checking availability through an injected probe.
pub struct PortAllocator<F> {
    /// Returns the holder of a port, or `None` if free.
    holder_of: F,
    /// How many ports past the preferred one to try.
    search_span: u16,
}

impl<F> PortAllocator<F>
where
    F: Fn(u16) -> Option<String>,
{
    /// Builds an allocator using `holder_of` to test each port.
    pub fn new(holder_of: F) -> Self {
        Self {
            holder_of,
            search_span: 64,
        }
    }

    /// Sets how many ports past the preferred one to search.
    pub fn with_search_span(mut self, span: u16) -> Self {
        self.search_span = span;
        self
    }

    /// Decides where to place a service that prefers `preferred`.
    ///
    /// `reserved` holds ports already handed out in this planning pass but not
    /// yet bound, so two services planned together do not collide.
    pub fn allocate(&self, preferred: u16, reserved: &[u16]) -> PortDecision {
        let taken = |port: u16| reserved.contains(&port) || (self.holder_of)(port).is_some();

        if !taken(preferred) {
            return PortDecision::Available { port: preferred };
        }

        let held_by = (self.holder_of)(preferred);

        // Search upward for the next free port, skipping reserved ones.
        let start = preferred.saturating_add(1);
        for offset in 0..self.search_span {
            let Some(candidate) = start.checked_add(offset) else {
                break;
            };
            if !taken(candidate) {
                return PortDecision::Reassigned {
                    requested: preferred,
                    port: candidate,
                    held_by,
                };
            }
        }

        PortDecision::Unavailable {
            requested: preferred,
            held_by,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn free_preferred_port_is_used() {
        let allocator = PortAllocator::new(|_| None);
        assert_eq!(
            allocator.allocate(80, &[]),
            PortDecision::Available { port: 80 }
        );
    }

    #[test]
    fn taken_port_is_reassigned_to_the_next_free_one() {
        // 80 and 81 are taken, 82 is free.
        let allocator = PortAllocator::new(|port| match port {
            80 => Some("System".to_owned()),
            81 => Some("nginx.exe".to_owned()),
            _ => None,
        });

        let decision = allocator.allocate(80, &[]);
        assert_eq!(
            decision,
            PortDecision::Reassigned {
                requested: 80,
                port: 82,
                held_by: Some("System".to_owned()),
            }
        );
        assert_eq!(decision.resolved_port(), Some(82));
    }

    #[test]
    fn reserved_ports_are_avoided() {
        // Nothing is bound, but 3306 was already handed to another service this
        // pass, so a second request must move past it.
        let allocator = PortAllocator::new(|_| None);
        let decision = allocator.allocate(3306, &[3306]);
        assert_eq!(
            decision,
            PortDecision::Reassigned {
                requested: 3306,
                port: 3307,
                held_by: None,
            }
        );
    }

    #[test]
    fn exhausted_search_reports_unavailable() {
        // Everything in the search span is taken.
        let allocator = PortAllocator::new(|_| Some("busy".to_owned())).with_search_span(4);
        let decision = allocator.allocate(9000, &[]);
        assert_eq!(
            decision,
            PortDecision::Unavailable {
                requested: 9000,
                held_by: Some("busy".to_owned()),
            }
        );
        assert_eq!(decision.resolved_port(), None);
    }

    #[test]
    fn search_span_is_respected() {
        // Only 9002 is free, but the span reaches just far enough.
        let allocator = PortAllocator::new(|port| (port != 9002).then(|| "busy".to_owned()))
            .with_search_span(2);
        assert_eq!(allocator.allocate(9000, &[]).resolved_port(), Some(9002));
    }
}
