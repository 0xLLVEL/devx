//! Health checks that decide when a starting service is actually ready.
//!
//! "The process is running" is not the same as "the service is ready": nginx
//! has bound its port, MariaDB accepts connections, Mailpit answers HTTP. Each
//! service declares how readiness is observed, and the supervisor polls it
//! before moving from `Starting` to `Running`.

use std::time::Duration;

/// How to tell that a starting service has become ready.
#[derive(Debug, Clone)]
pub enum HealthCheck {
    /// Ready as soon as the process has stayed alive for this long.
    ///
    /// The weakest check, for processes with no observable readiness signal.
    Uptime(Duration),
    /// Ready when a TCP connection to `127.0.0.1:port` succeeds.
    ///
    /// The usual check for servers: it proves the port is actually accepting.
    TcpPort(u16),
    /// Ready when a line matching this substring appears in the output.
    LogContains(String),
}

/// Whether a captured log line satisfies a [`HealthCheck::LogContains`] check.
///
/// Split out as a pure function so the matching rule is tested directly.
pub fn log_line_signals_ready(check: &HealthCheck, line: &str) -> bool {
    match check {
        HealthCheck::LogContains(needle) => line.contains(needle.as_str()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_check_matches_a_substring() {
        let check = HealthCheck::LogContains("ready to accept connections".to_owned());
        assert!(log_line_signals_ready(
            &check,
            "2026-09-11 mariadbd: ready to accept connections"
        ));
        assert!(!log_line_signals_ready(&check, "still starting up"));
    }

    #[test]
    fn non_log_checks_never_match_a_line() {
        assert!(!log_line_signals_ready(&HealthCheck::TcpPort(3306), "3306"));
        assert!(!log_line_signals_ready(
            &HealthCheck::Uptime(Duration::from_secs(1)),
            "anything"
        ));
    }
}
