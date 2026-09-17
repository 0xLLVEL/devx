//! Persistent event log for supervised-service transitions.
//!
//! Every [`devx_proc::ServiceEvent`] is appended to `data/events.jsonl`,
//! one JSON object per line, so the history survives restarts of the app and
//! answers "what happened while I was away" — something the in-memory
//! broadcast channel cannot do. The read side (`events_recent`) returns the
//! newest entries; the write side is fire-and-forget: a failed append is
//! logged and dropped, never allowed to break the service watching loop.

use std::io::Write;

use serde::{Deserialize, Serialize};

/// How many lines `events_recent` returns at most.
pub const MAX_RECENT: usize = 200;

/// One recorded service transition, with the wall-clock time it happened.
///
/// `ServiceEvent` is re-encoded field by field rather than nested, so the
/// JSONL file stays readable by hand and by future schema tweaks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedEvent {
    /// Unix timestamp in seconds.
    pub at_unix: u64,
    /// Id of the supervised service.
    pub id: String,
    /// The state it moved to (snake_case `ServiceState`).
    pub state: String,
    /// Why it left the running state, when it did (snake_case `ExitReason`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<String>,
}

/// The `data/events.jsonl` path for `paths`.
fn log_path(paths: &devx_core::AppPaths) -> std::path::PathBuf {
    paths.data_dir.join("events.jsonl")
}

/// Appends one transition to the event log.
///
/// Fire-and-forget by design: a broken disk must not take down the service
/// watcher, so failures are logged and swallowed.
pub fn record(paths: &devx_core::AppPaths, event: &devx_proc::ServiceEvent) {
    /// The serde wire name of a serialisable value, for the log's text fields.
    fn wire_name<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_value(value)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    let entry = RecordedEvent {
        at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        id: event.id.clone(),
        state: wire_name(&event.state),
        // `ExitReason` is internally tagged, so its wire form is an object
        // with a `kind` discriminator; keep just the kind string.
        exit: event.exit.as_ref().map(|reason| {
            serde_json::to_value(reason)
                .ok()
                .and_then(|v| v.get("kind").and_then(|k| k.as_str().map(str::to_owned)))
                .unwrap_or_default()
        }),
    };

    let path = log_path(paths);
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            tracing::warn!(error = %err, "could not create the event-log directory");
            return;
        }
    }

    let line = match serde_json::to_string(&entry) {
        Ok(line) => line,
        Err(err) => {
            tracing::warn!(error = %err, "could not serialise a service event");
            return;
        }
    };

    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(err) => {
            tracing::warn!(error = %err, path = %path.display(), "could not open the event log");
            return;
        }
    };
    if let Err(err) = writeln!(file, "{line}") {
        tracing::warn!(error = %err, "could not append to the event log");
    }
}

/// Reads up to `limit` most-recent events, newest first.
///
/// The log is plain JSONL and stays small (one short line per transition),
/// so the whole file is read and the newest `limit` entries returned.
/// Unparseable lines (a torn final write, manual edits) are skipped,
/// not fatal. Returns an empty list when the log does not exist yet.
pub fn recent(paths: &devx_core::AppPaths, limit: usize) -> Vec<RecordedEvent> {
    let limit = limit.min(MAX_RECENT);
    let path = log_path(paths);
    let Ok(content) = std::fs::read_to_string(&path) else {
        // No log yet: an empty history is the honest answer.
        return Vec::new();
    };

    let mut events = Vec::with_capacity(limit);
    for line in content.lines().rev() {
        if events.len() >= limit {
            break;
        }
        push_line(&mut events, line, limit);
    }
    events
}

/// Parses one JSONL line into an event, ignoring anything unreadable.
fn push_line(events: &mut Vec<RecordedEvent>, line: &str, limit: usize) {
    if events.len() >= limit || line.trim().is_empty() {
        return;
    }
    match serde_json::from_str(line) {
        Ok(event) => events.push(event),
        Err(_) => {
            // A torn write or manual edit; skip rather than fail the read.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devx_core::AppPaths;
    use devx_proc::{ExitReason, ServiceEvent, ServiceState};
    use tempfile::TempDir;

    fn paths(dir: &TempDir) -> AppPaths {
        AppPaths::rooted_at(dir.path())
    }

    fn event(id: &str, state: ServiceState, exit: Option<ExitReason>) -> ServiceEvent {
        ServiceEvent {
            id: id.to_owned(),
            state,
            exit,
        }
    }

    #[test]
    fn record_appends_and_recent_reads_newest_first() {
        let dir = TempDir::new().unwrap();
        let paths = paths(&dir);

        record(&paths, &event("mariadb", ServiceState::Starting, None));
        record(&paths, &event("mariadb", ServiceState::Running, None));
        record(
            &paths,
            &event(
                "nginx",
                ServiceState::Failed,
                Some(ExitReason::Crashed { code: Some(1) }),
            ),
        );

        let recent = recent(&paths, 10);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].id, "nginx");
        assert_eq!(recent[0].state, "failed");
        assert_eq!(recent[0].exit.as_deref(), Some("crashed"));
        assert_eq!(recent[2].id, "mariadb");
        assert_eq!(recent[2].state, "starting");
    }

    #[test]
    fn recent_respects_the_limit() {
        let dir = TempDir::new().unwrap();
        let paths = paths(&dir);
        for _ in 0..25 {
            record(&paths, &event("mariadb", ServiceState::Running, None));
        }

        let recent = recent(&paths, 5);
        assert_eq!(recent.len(), 5);
    }

    #[test]
    fn recent_on_a_missing_log_is_empty() {
        let dir = TempDir::new().unwrap();
        assert!(recent(&paths(&dir), 10).is_empty());
    }

    #[test]
    fn torn_final_line_is_skipped() {
        let dir = TempDir::new().unwrap();
        let paths = paths(&dir);
        record(&paths, &event("nginx", ServiceState::Running, None));

        // Simulate a torn write: append a partial JSON object.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(log_path(&paths))
            .unwrap();
        write!(file, "{{\"at_unix\":1,\"id\":\"maria").unwrap();
        drop(file);

        let recent = recent(&paths, 10);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "nginx");
    }

    #[test]
    fn entry_shape_is_stable() {
        let dir = TempDir::new().unwrap();
        let paths = paths(&dir);
        record(
            &paths,
            &event("php", ServiceState::Failed, Some(ExitReason::HealthTimeout)),
        );
        let content = std::fs::read_to_string(log_path(&paths)).unwrap();
        let entry: RecordedEvent = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(entry.id, "php");
        assert_eq!(entry.state, "failed");
        assert_eq!(entry.exit.as_deref(), Some("health_timeout"));
        assert_eq!(content.lines().count(), 1);
    }
}
