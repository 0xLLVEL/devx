//! Read state behind the §98 notification center.
//!
//! §98 is not a second inbox. Every entry it shows is a transition the
//! supervisor already recorded in `data/events.jsonl`, and the only thing DevX
//! has to remember is how far the user has read. That single fact is persisted
//! as two watermarks in `data/notifications.json`, which keeps the decision
//! logic here pure — the events and the marker go in, the panel comes out — and
//! means the event log is never rewritten: clearing the panel cannot destroy
//! history, and the Activity timeline (§42) still shows the same transitions.
//!
//! * `read_through_unix`: events at or before it have been read (§98 "Mark all
//!   read").
//! * `acknowledged_through_unix`: events at or before it are acknowledged. They
//!   leave the list, and the failures among them stop counting as unread (§98
//!   "Clear").
//!
//! §98's last line — "Errors should remain visible until acknowledged if
//! important" — is the whole reason there are two watermarks instead of one.
//! The second one is only ever moved by an acknowledging action, so a failure
//! stays in the list and in the badge count while "Mark all read" — which
//! deliberately does not touch it — can silence everything else. Read is what
//! the user has seen; acknowledged is what the user has accepted.
//!
//! Watermarks only ever move forward, and a marker file that cannot be trusted
//! is discarded for [`ReadState::all_unread`]: the failure direction is chosen
//! so a corrupt file shows too much rather than hiding a failure nobody saw.

use serde::{Deserialize, Serialize};

use crate::event_log::RecordedEvent;

/// Schema of `notifications.json`.
///
/// A file written by another version is not guessed at; see [`ReadState::parse`].
const SCHEMA_VERSION: u32 = 1;

/// How many entries the panel asks for when it does not say.
pub const DEFAULT_ENTRIES: usize = 50;

/// Most entries one answer may carry.
pub const MAX_ENTRIES: usize = 200;

/// What the user has read, as it persists between launches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadState {
    /// Schema this marker was written with.
    version: u32,
    /// Events at or before this instant are read.
    #[serde(default)]
    read_through_unix: u64,
    /// Events at or before this instant are acknowledged.
    #[serde(default)]
    acknowledged_through_unix: u64,
}

impl Default for ReadState {
    fn default() -> Self {
        Self::all_unread()
    }
}

impl ReadState {
    /// Nothing read yet — the honest state for a fresh install, and the
    /// fallback whenever the marker file cannot be used.
    pub fn all_unread() -> Self {
        Self {
            version: SCHEMA_VERSION,
            read_through_unix: 0,
            acknowledged_through_unix: 0,
        }
    }

    /// Parses a marker file, falling back to "everything unread".
    ///
    /// Never fails and never panics: truncated JSON, a hand-edited file, a
    /// version written by a future DevX, or a marker whose watermarks run
    /// backwards all land on [`Self::all_unread`]. Showing notifications the
    /// user has already read is a cosmetic problem; hiding a failure that was
    /// never seen is not, so the unusable case resolves toward showing.
    pub fn parse(raw: &str) -> Self {
        Self::parse_checked(raw).unwrap_or_else(|_| Self::all_unread())
    }

    /// The usable parse of `raw`, or the reason it cannot be used.
    fn parse_checked(raw: &str) -> Result<Self, &'static str> {
        let state: Self = serde_json::from_str(raw)
            .map_err(|_| "it is not readable JSON in the expected shape")?;
        if state.version != SCHEMA_VERSION {
            return Err("it was written by a different DevX schema");
        }
        // Acknowledging before reading describes an impossible history, which
        // means the file is not ours to interpret.
        if state.acknowledged_through_unix > state.read_through_unix {
            return Err("its watermarks run backwards");
        }
        Ok(state)
    }

    /// Serialises the marker for the file.
    fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Whether `event` still belongs in the panel.
    ///
    /// Acknowledged events are gone from the list, failures included: that is
    /// exactly what §98's "Clear" means.
    pub fn is_visible(&self, event: &RecordedEvent) -> bool {
        event.at_unix > self.acknowledged_through_unix
    }

    /// Whether `event` counts as unread.
    ///
    /// Ordinary transitions are unread until they are read. A failure is unread
    /// until it is *acknowledged* as well, so §98's "Mark all read" cannot take
    /// the badge down while a service is still broken — the badge keeps asking
    /// for the acknowledgement that "Clear" provides.
    pub fn is_unread(&self, event: &RecordedEvent) -> bool {
        event.at_unix > self.read_through_unix
            || (is_important(event) && event.at_unix > self.acknowledged_through_unix)
    }

    /// The marker after §98's "Mark all read" up to `through_unix`.
    pub fn marked_read(&self, through_unix: u64) -> Self {
        Self {
            read_through_unix: self.read_through_unix.max(through_unix),
            ..self.clone()
        }
    }

    /// The marker after §98's "Clear" up to `through_unix`: everything is
    /// acknowledged, so the list is empty and nothing is unread.
    ///
    /// Read is advanced with it — an acknowledged event is by definition one
    /// the user has seen.
    pub fn acknowledged_through(&self, through_unix: u64) -> Self {
        let acknowledged = self.acknowledged_through_unix.max(through_unix);
        Self {
            read_through_unix: self.read_through_unix.max(acknowledged),
            acknowledged_through_unix: acknowledged,
            ..self.clone()
        }
    }
}

/// Whether an event is one §98 keeps until it is acknowledged.
///
/// Deliberately the same judgement `devx_proc` makes when it spends a restart
/// budget: a transition to `failed` ("exited unexpectedly, or failed to
/// start"), or any exit reason other than a requested stop. A `stopped` state
/// carrying such a reason counts too, because the supervisor uses that pair
/// when a stop request lands in the middle of a crash-restart loop.
pub fn is_important(event: &RecordedEvent) -> bool {
    if event.state == "failed" {
        return true;
    }
    matches!(event.exit.as_deref(), Some(exit) if !exit.is_empty() && exit != "requested")
}

/// One notification: a recorded transition, with what §98 shows beside it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct NotificationEntry {
    /// Unix timestamp in seconds.
    #[specta(type = specta_typescript::Number)]
    pub at_unix: u64,
    /// Id of the supervised service.
    pub id: String,
    /// The state it moved to (`running`, `failed`, `starting`, …).
    pub state: String,
    /// Why it left the running state (`crashed`, `health_timeout`, …), when it did.
    pub exit: Option<String>,
    /// `error` for the transitions that stay until acknowledged, `info`
    /// otherwise. The frontend pairs it with text, never with colour alone
    /// (§55).
    pub severity: String,
    /// Whether the user still owes this one a look.
    pub unread: bool,
}

/// §98's panel contents.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct NotificationList {
    /// The entries to show, newest first.
    pub entries: Vec<NotificationEntry>,
    /// How many of the events read are unread — the bell's badge.
    ///
    /// Counted over every event handed in, not just the ones that fit in
    /// `entries`, so a truncated panel still badges the truth.
    pub unread_count: u32,
    /// How many recorded transitions this answer was computed from.
    ///
    /// Not shown as a number: it is what lets the panel tell "nothing has
    /// happened yet" from "everything was cleared" instead of printing one
    /// sentence for both.
    pub recorded: u32,
}

/// The panel for `events`: what to show, and how much of it is unread.
///
/// `events` is expected newest-first, as [`crate::event_log::recent`] returns
/// it; `limit` caps only what is displayed, never the count.
pub fn evaluate(events: &[RecordedEvent], state: &ReadState, limit: usize) -> NotificationList {
    let limit = limit.clamp(1, MAX_ENTRIES);
    let unread_count = events.iter().filter(|event| state.is_unread(event)).count() as u32;

    let entries = events
        .iter()
        .filter(|event| state.is_visible(event))
        .take(limit)
        .map(|event| NotificationEntry {
            at_unix: event.at_unix,
            id: event.id.clone(),
            state: event.state.clone(),
            exit: event.exit.clone(),
            severity: if is_important(event) { "error" } else { "info" }.to_owned(),
            unread: state.is_unread(event),
        })
        .collect();

    NotificationList {
        entries,
        unread_count,
        recorded: events.len() as u32,
    }
}

/// The newest timestamp in `events`, for the watermarks a read/clear moves.
///
/// `None` for an empty log, which is how the commands know to leave the marker
/// alone rather than move it to a time nothing happened at.
pub fn newest_at(events: &[RecordedEvent]) -> Option<u64> {
    events.iter().map(|event| event.at_unix).max()
}

/// The `data/notifications.json` marker for `paths`.
///
/// It lives in `data_dir` next to `events.jsonl`, not in `config.toml`: what
/// the user has already seen is runtime state, meaningless without the log it
/// refers to, and no one should be editing it by hand.
fn marker_path(paths: &devx_core::AppPaths) -> std::path::PathBuf {
    paths.data_dir.join("notifications.json")
}

/// Reads the marker, falling back to "everything unread".
///
/// A missing file is the normal first-run case; an unreadable one is logged
/// with the reason and then treated the same way, because a marker DevX cannot
/// trust must not be allowed to hide notifications.
pub fn load(paths: &devx_core::AppPaths) -> ReadState {
    let path = marker_path(paths);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match ReadState::parse_checked(&raw) {
            Ok(state) => state,
            Err(reason) => {
                tracing::warn!(
                    path = %path.display(),
                    reason,
                    "ignoring the notification marker; every recorded event counts as unread"
                );
                ReadState::all_unread()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => ReadState::all_unread(),
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "could not read the notification marker; every recorded event counts as unread"
            );
            ReadState::all_unread()
        }
    }
}

/// Writes the marker atomically, through the same helper the config uses.
///
/// # Errors
///
/// Fails when the file cannot be written. The callers surface it rather than
/// swallowing it: telling the user "marked read" and then showing the same
/// notifications after a restart would be worse than the error.
pub fn save(paths: &devx_core::AppPaths, state: &ReadState) -> Result<(), devx_core::Error> {
    let body = state.to_json().map_err(|err| {
        devx_core::Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to serialize the notification marker: {err}"),
        )
    })?;
    devx_core::fsx::write_atomic(marker_path(paths), body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use devx_core::AppPaths;
    use tempfile::TempDir;

    /// A recorded transition, with only the fields the rules look at.
    fn event(at_unix: u64, id: &str, state: &str, exit: Option<&str>) -> RecordedEvent {
        RecordedEvent {
            at_unix,
            id: id.to_owned(),
            state: state.to_owned(),
            exit: exit.map(str::to_owned),
        }
    }

    /// Newest first, the order `event_log::recent` returns.
    fn log() -> Vec<RecordedEvent> {
        vec![
            event(400, "nginx", "running", None),
            event(300, "mariadb", "failed", Some("crashed")),
            event(200, "redis", "starting", None),
            event(100, "redis", "running", None),
        ]
    }

    /// The same shape without anything going wrong, for the tests about plain
    /// reading: `log()` carries a failure, which §98 deliberately holds back.
    fn quiet_log() -> Vec<RecordedEvent> {
        vec![
            event(400, "nginx", "running", None),
            event(300, "redis", "stopping", Some("requested")),
            event(200, "redis", "starting", None),
            event(100, "redis", "running", None),
        ]
    }

    #[test]
    fn an_empty_log_has_nothing_to_show() {
        let panel = evaluate(&[], &ReadState::all_unread(), 50);

        assert!(panel.entries.is_empty());
        assert_eq!(panel.unread_count, 0);
        assert_eq!(
            panel.recorded, 0,
            "the panel can tell nothing ever happened"
        );
    }

    #[test]
    fn a_fresh_marker_marks_everything_unread() {
        let panel = evaluate(&log(), &ReadState::all_unread(), 50);

        assert_eq!(panel.entries.len(), 4);
        assert_eq!(panel.unread_count, 4);
        assert!(panel.entries.iter().all(|entry| entry.unread));
    }

    #[test]
    fn reading_up_to_the_newest_leaves_nothing_unread_but_keeps_the_list() {
        let marker = ReadState::all_unread().marked_read(400);

        let panel = evaluate(&quiet_log(), &marker, 50);

        // Read is not cleared: §98's two actions do different things.
        assert_eq!(panel.entries.len(), 4);
        assert_eq!(panel.unread_count, 0);
        assert!(panel.entries.iter().all(|entry| !entry.unread));
    }

    #[test]
    fn events_newer_than_the_marker_are_unread() {
        let marker = ReadState::all_unread().marked_read(300);

        let panel = evaluate(&quiet_log(), &marker, 50);

        // Only the 400 stands above the watermark.
        assert_eq!(panel.unread_count, 1);
        assert!(
            panel.entries[0].unread,
            "the newest event is the unread one"
        );
        assert!(!panel.entries[1].unread);
    }

    #[test]
    fn a_failure_survives_mark_all_read() {
        let marker = ReadState::all_unread().marked_read(400);

        let panel = evaluate(&log(), &marker, 50);

        let failure = &panel.entries[1];
        assert_eq!(failure.state, "failed");
        assert!(
            failure.unread,
            "§98: an error stays until it is acknowledged, not merely read"
        );
        // And it is the only one: the rest went quiet.
        assert_eq!(panel.unread_count, 1);
    }

    #[test]
    fn clear_acknowledges_the_failure_and_empties_the_list() {
        let marker = ReadState::all_unread()
            .marked_read(400)
            .acknowledged_through(400);

        let panel = evaluate(&log(), &marker, 50);

        assert!(panel.entries.is_empty());
        assert_eq!(panel.unread_count, 0);
        assert_eq!(
            panel.recorded, 4,
            "clearing empties the panel without pretending nothing happened"
        );
    }

    #[test]
    fn a_failure_after_a_clear_is_unread_again() {
        let marker = ReadState::all_unread().acknowledged_through(400);

        let mut events = log();
        events.insert(0, event(500, "nginx", "failed", Some("health_timeout")));

        let panel = evaluate(&events, &marker, 50);

        assert_eq!(panel.entries.len(), 1);
        assert_eq!(panel.entries[0].id, "nginx");
        assert_eq!(panel.entries[0].severity, "error");
        assert_eq!(panel.unread_count, 1);
    }

    #[test]
    fn a_requested_stop_is_not_something_to_acknowledge() {
        let marker = ReadState::all_unread().acknowledged_through(250);

        let events = vec![
            event(350, "nginx", "stopping", Some("requested")),
            event(300, "nginx", "stopped", Some("requested")),
            event(250, "nginx", "stopped", Some("crashed")),
        ];
        let panel = evaluate(&events, &marker, 50);

        // Both requested stops are ordinary news and still listed; the crash
        // recorded at the acknowledged instant is gone.
        assert_eq!(panel.entries.len(), 2);
        assert_eq!(
            panel.entries[0].severity, "info",
            "a requested stop is not a failure"
        );
        assert_eq!(panel.unread_count, 2);
    }

    #[test]
    fn the_limit_caps_the_list_but_not_the_count() {
        let marker = ReadState::all_unread();

        let panel = evaluate(&log(), &marker, 2);

        assert_eq!(panel.entries.len(), 2);
        assert_eq!(
            panel.unread_count, 4,
            "the badge must count what the panel could not show"
        );
    }

    #[test]
    fn watermarks_only_move_forward() {
        let marker = ReadState::all_unread()
            .marked_read(500)
            .marked_read(100)
            .acknowledged_through(400)
            .acknowledged_through(50);

        // A shorter log (a rotating file, a manual delete) must not un-read
        // what the user has already seen.
        assert_eq!(marker.read_through_unix, 500);
        assert_eq!(marker.acknowledged_through_unix, 400);
    }

    #[test]
    fn an_empty_log_leaves_the_marker_where_it_is() {
        assert_eq!(newest_at(&[]), None);
        assert_eq!(newest_at(&log()), Some(400));
    }

    #[test]
    fn a_marker_round_trips_through_json() {
        let marker = ReadState::all_unread()
            .marked_read(700)
            .acknowledged_through(600);

        let raw = marker.to_json().expect("serialize");

        assert_eq!(ReadState::parse(&raw), marker);
    }

    #[test]
    fn a_broken_marker_reads_as_everything_unread() {
        for raw in [
            "",
            "not json at all",
            "{\"version\":1,\"read_through_unix\":",
            // A future schema, which this build must not interpret.
            "{\"version\":99,\"read_through_unix\":700,\"acknowledged_through_unix\":600}",
            // Acknowledged ahead of read describes a history that cannot exist.
            "{\"version\":1,\"read_through_unix\":10,\"acknowledged_through_unix\":600}",
        ] {
            assert_eq!(
                ReadState::parse(raw),
                ReadState::all_unread(),
                "`{raw}` must fall back to showing everything"
            );
            assert!(
                ReadState::parse_checked(raw).is_err(),
                "the log line needs a reason for `{raw}`"
            );
        }
    }

    #[test]
    fn a_saved_marker_is_read_back_from_disk() {
        let dir = TempDir::new().unwrap();
        let paths = AppPaths::rooted_at(dir.path());

        // No file yet: everything is unread, and nothing was created.
        assert_eq!(load(&paths), ReadState::all_unread());
        assert!(!paths.data_dir.join("notifications.json").exists());

        let marker = ReadState::all_unread().marked_read(400);
        save(&paths, &marker).expect("save");

        assert_eq!(load(&paths), marker);
        assert_eq!(
            evaluate(&log(), &load(&paths), 50).unread_count,
            1,
            "the marker survives the round trip that a restart performs"
        );
    }

    #[test]
    fn a_corrupt_marker_on_disk_falls_back_without_failing() {
        let dir = TempDir::new().unwrap();
        let paths = AppPaths::rooted_at(dir.path());
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.data_dir.join("notifications.json"), "{ truncated").unwrap();

        let marker = load(&paths);

        assert_eq!(marker, ReadState::all_unread());
        // And a save over it repairs the file rather than failing.
        save(&paths, &marker.marked_read(400)).expect("save");
        assert_eq!(load(&paths).read_through_unix, 400);
    }
}
