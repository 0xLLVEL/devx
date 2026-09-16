//! The §98 notification center: what the user has read, and the two actions
//! that move that marker.
//!
//! Thin by design: the rules live in [`crate::notifications`] as pure
//! functions over the recorded events, and this module only reads the log,
//! reads and writes the marker file, and shapes the answer for the UI.

use tauri::State;

use crate::event_log;
use crate::notifications::{self, NotificationList, ReadState};
use crate::state::AppState;
use devx_core::Error;

/// What §98's panel shows: the recorded transitions, newest first, each marked
/// read or unread, plus the unread count behind the bell's badge.
///
/// Reading is free of side effects — opening the panel must not mark anything
/// read, or §98's "Mark all read" would have nothing left to do.
#[tauri::command]
#[specta::specta]
pub fn notifications_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<NotificationList, Error> {
    let events = recent_events(&state);
    let marker = notifications::load(&state.paths);
    Ok(notifications::evaluate(
        &events,
        &marker,
        entry_limit(limit),
    ))
}

/// §98's "Mark all read": everything recorded so far is read.
///
/// Failures are not read by this. §98 keeps an error visible until it is
/// acknowledged, so one that has not been cleared stays in the list and in the
/// badge — that is the point of the rule, not an oversight.
#[tauri::command]
#[specta::specta]
pub fn notifications_mark_all_read(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<NotificationList, Error> {
    move_marker(&state, limit, ReadState::marked_read)
}

/// §98's "Clear": everything recorded so far is acknowledged, so the panel
/// empties.
///
/// Only the marker moves. `events.jsonl` is never edited, so the same
/// transitions stay on the Activity timeline (§42) and in the logs — clearing
/// notifications is not deleting history.
#[tauri::command]
#[specta::specta]
pub fn notifications_clear(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<NotificationList, Error> {
    move_marker(&state, limit, ReadState::acknowledged_through)
}

/// Advances the marker with `advance`, saves it, and answers with the panel
/// the frontend should now show — one round trip, and one source of truth for
/// the result.
///
/// The save is part of the command rather than a background detail: a marker
/// that only lived in memory would show every notification again after the
/// next launch, after the UI had already told the user it was handled.
fn move_marker(
    state: &AppState,
    limit: Option<u32>,
    advance: fn(&ReadState, u64) -> ReadState,
) -> Result<NotificationList, Error> {
    let events = recent_events(state);
    let marker = notifications::load(&state.paths);

    // An empty log has no instant to advance to. Leaving the marker alone is
    // the only honest option, and the panel is empty either way.
    let marker = match notifications::newest_at(&events) {
        Some(newest) => advance(&marker, newest),
        None => marker,
    };

    notifications::save(&state.paths, &marker)?;
    Ok(notifications::evaluate(
        &events,
        &marker,
        entry_limit(limit),
    ))
}

/// The transitions the panel decides over.
fn recent_events(state: &AppState) -> Vec<event_log::RecordedEvent> {
    event_log::recent(&state.paths, event_log::MAX_RECENT)
}

/// The requested page size, defaulted; [`notifications::evaluate`] clamps it.
fn entry_limit(limit: Option<u32>) -> usize {
    limit
        .map(|limit| limit as usize)
        .unwrap_or(notifications::DEFAULT_ENTRIES)
}
