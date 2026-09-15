//! Mail catcher commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

/// Reports whether Mailpit is running and how full its inbox is.
#[tauri::command]
#[specta::specta]
pub async fn mail_status(state: State<'_, AppState>) -> Result<MailStatus, Error> {
    let (running, port) = {
        let registry = &state.services;
        let running = registry
            .get("mailpit")
            .map(|supervisor| supervisor.state().is_active())
            .unwrap_or(false);
        let port = registry.port_of("mailpit").or(if running {
            devx_provision::definition_for("mailpit")
                .ok()
                .and_then(|def| def.default_port)
        } else {
            None
        });
        (running, port)
    };

    // Counts are best-effort: a stopped or just-started service reports
    // `null`s instead of failing the whole status call.
    let (total, unread) = if running {
        match devx_mail::MailpitClient::new("127.0.0.1", port.unwrap_or(8025))
            .inbox(1)
            .await
        {
            Ok(inbox) => (Some(inbox.total), Some(inbox.unread)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(MailStatus {
        running,
        port,
        smtp_port: MAILPIT_SMTP_PORT,
        total,
        unread,
    })
}

/// Lists the newest messages in Mailpit's inbox.
#[tauri::command]
#[specta::specta]
pub async fn mail_list(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<devx_mail::MessageSummary>, Error> {
    let port = mail_api_port(&state)?;
    Ok(devx_mail::MailpitClient::new("127.0.0.1", port)
        .inbox(limit)
        .await?
        .messages)
}

/// Fetches one full message by ID. Mailpit marks it read on fetch.
#[tauri::command]
#[specta::specta]
pub async fn mail_message(
    state: State<'_, AppState>,
    id: String,
) -> Result<devx_mail::Message, Error> {
    let port = mail_api_port(&state)?;
    devx_mail::MailpitClient::new("127.0.0.1", port)
        .message(&id)
        .await
}

/// Deletes the given messages, or every message when `ids` is empty.
#[tauri::command]
#[specta::specta]
pub async fn mail_delete(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), Error> {
    let port = mail_api_port(&state)?;
    devx_mail::MailpitClient::new("127.0.0.1", port)
        .delete(&ids)
        .await
}

/// The port Mailpit's API answers on, from the running service's supervisor.
fn mail_api_port(state: &AppState) -> Result<u16, Error> {
    state
        .services
        .port_of("mailpit")
        .or_else(|| {
            devx_provision::definition_for("mailpit")
                .ok()
                .and_then(|def| def.default_port)
        })
        .ok_or_else(|| Error::not_found("the mailpit service has no port"))
}

const MAILPIT_SMTP_PORT: u16 = 1025;

/// Status of the Mailpit service, as the Mail page needs it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct MailStatus {
    /// Whether the `mailpit` service is currently running.
    pub running: bool,
    /// Port the HTTP UI (and API) answers on; `null` while stopped.
    pub port: Option<u16>,
    /// SMTP port apps should send mail to.
    pub smtp_port: u16,
    /// Total and unread counts, when the API is reachable right now.
    ///
    /// Exported to TypeScript as plain `number`s (see the repo-wide `u64`
    /// note); `null` while the API is unreachable.
    #[specta(type = Option<specta_typescript::Number>)]
    pub total: Option<u64>,
    /// Unread count, when the API is reachable right now.
    #[specta(type = Option<specta_typescript::Number>)]
    pub unread: Option<u64>,
}
