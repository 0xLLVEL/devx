//! Typed client for the bundled Mailpit mail catcher.
//!
//! Mailpit captures every email an app sends to its SMTP port and exposes a
//! small HTTP API for reading them. DevX ships it as the `mailpit` service
//! (SMTP on `127.0.0.1:1025`, HTTP UI + API on the service's own port), and
//! this crate is the typed bridge to that API — the Mail page never shells
//! out or parses HTML.
//!
//! The mapping is deliberately honest about Mailpit's wire format: its JSON
//! keys are capitalized Go exports (`ID`, `Read`, `From`), so the DTOs rename
//! them into DevX's snake_case convention at the boundary, and `Address`
//! normalizes the three-way `null`/missing/object ambiguity into plain
//! strings.
//!
//! ```no_run
//! use devx_mail::MailpitClient;
//!
//! # async fn demo() -> devx_core::Result<()> {
//! let client = MailpitClient::new("127.0.0.1", 8025);
//! let inbox = client.inbox(50).await?;
//! println!("{} unread of {}", inbox.unread, inbox.total);
//! # Ok(())
//! # }
//! ```

use std::time::Duration;

use devx_core::{Error, Result};
use serde::{Deserialize, Serialize};

/// Base URL of the local Mailpit instance this client talks to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// Host Mailpit's HTTP server binds, almost always loopback.
    pub host: String,
    /// Port of Mailpit's HTTP UI (which also serves the API).
    pub port: u16,
}

impl Endpoint {
    /// Builds an endpoint for `host:port`.
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }

    /// The API base URL, e.g. `http://127.0.0.1:8025`.
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

/// `From`, `To`, ... as Mailpit models them: a display name and address.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Address {
    /// The `user@host` part.
    pub address: String,
    /// Display name, empty when the message has none.
    pub name: String,
}

/// One message in the inbox listing (`GET /api/v1/messages`).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct MessageSummary {
    /// Mailpit's short database ID; the key for every other call.
    pub id: String,
    /// Whether the message has been read (viewed) already.
    pub read: bool,
    /// Sender.
    pub from: Address,
    /// Primary recipients.
    pub to: Vec<Address>,
    /// Subject line, possibly empty.
    pub subject: String,
    /// When the message was received (RFC 3339).
    pub created: String,
    /// Size of the raw message in bytes.
    ///
    /// Exported to TypeScript as a plain `number`; see the repo-wide note on
    /// `u64` fields — display values never approach 2^53.
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    /// How many attachments the message carries.
    pub attachments: u32,
    /// Up to 250 characters of plain-text preview.
    pub snippet: String,
    /// Tags Mailpit attached to the message.
    pub tags: Vec<String>,
}

/// A full message (`GET /api/v1/message/{id}`): summary fields plus body.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct Message {
    /// Mailpit's short database ID.
    pub id: String,
    /// Sender.
    pub from: Address,
    /// Primary recipients.
    pub to: Vec<Address>,
    /// CC recipients.
    pub cc: Vec<Address>,
    /// BCC recipients.
    pub bcc: Vec<Address>,
    /// Subject line.
    pub subject: String,
    /// Message date, falling back to receive time (RFC 3339).
    pub date: String,
    /// Plain-text body, when the message has one.
    pub text: Option<String>,
    /// HTML body, when the message has one.
    pub html: Option<String>,
    /// Size of the raw message in bytes.
    ///
    /// Exported to TypeScript as a plain `number`; see the repo-wide note on
    /// `u64` fields — display values never approach 2^53.
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    /// Tags Mailpit attached to the message.
    pub tags: Vec<String>,
    /// Attachments, metadata only (bytes stay in Mailpit).
    pub attachments: Vec<Attachment>,
}

/// One attachment of a full message.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct Attachment {
    /// MIME part identifier within the message.
    pub part_id: String,
    /// File name Mailpit reports.
    pub file_name: String,
    /// MIME content type.
    pub content_type: String,
    /// Size in bytes, exported to TypeScript as a plain `number`.
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
}

/// The inbox: mailbox statistics plus one page of summaries.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct Inbox {
    /// Total messages currently stored.
    #[specta(type = specta_typescript::Number)]
    pub total: u64,
    /// How many of those have not been read.
    #[specta(type = specta_typescript::Number)]
    pub unread: u64,
    /// Summaries, newest first.
    pub messages: Vec<MessageSummary>,
}

/// `mail.Address` on the wire: `{Name, Address}`, and Mailpit marshals a
/// missing From as `null`. Everything normalizes to owned strings.
#[derive(Debug, Default, Deserialize)]
struct RawAddress {
    #[serde(default)]
    #[serde(rename = "Name")]
    name: String,
    #[serde(default)]
    #[serde(rename = "Address")]
    address: String,
}

impl From<RawAddress> for Address {
    fn from(raw: RawAddress) -> Self {
        Self {
            address: raw.address,
            name: raw.name,
        }
    }
}

/// An address field that may be absent, `null`, or an object.
#[derive(Debug, Default, Deserialize)]
struct RawOptionalAddress(Option<RawAddress>);

impl From<RawOptionalAddress> for Address {
    fn from(raw: RawOptionalAddress) -> Self {
        raw.0.map(Address::from).unwrap_or(Address {
            address: String::new(),
            name: String::new(),
        })
    }
}

/// A list of addresses that may be absent or `null`.
#[derive(Debug, Default, Deserialize)]
struct RawAddressList(Option<Vec<RawAddress>>);

impl From<RawAddressList> for Vec<Address> {
    fn from(raw: RawAddressList) -> Self {
        raw.0
            .unwrap_or_default()
            .into_iter()
            .map(Address::from)
            .collect()
    }
}

/// `MessageSummary` as Mailpit serializes it (capitalized Go exports).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawMessageSummary {
    #[serde(rename = "ID")]
    id: String,
    read: bool,
    from: RawOptionalAddress,
    to: RawAddressList,
    subject: String,
    created: String,
    size: u64,
    attachments: u32,
    snippet: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

impl From<RawMessageSummary> for MessageSummary {
    fn from(raw: RawMessageSummary) -> Self {
        Self {
            id: raw.id,
            read: raw.read,
            from: raw.from.into(),
            to: raw.to.into(),
            subject: raw.subject,
            created: raw.created,
            size: raw.size,
            attachments: raw.attachments,
            snippet: raw.snippet,
            tags: raw.tags.unwrap_or_default(),
        }
    }
}

/// `Message` as Mailpit serializes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawMessage {
    #[serde(rename = "ID")]
    id: String,
    from: RawOptionalAddress,
    to: RawAddressList,
    cc: RawAddressList,
    bcc: RawAddressList,
    subject: String,
    date: String,
    text: Option<String>,
    /// Go exports this as `HTML`, not `Html`, so PascalCase misses it.
    #[serde(rename = "HTML")]
    html: Option<String>,
    size: u64,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    attachments: Option<Vec<RawAttachment>>,
}

impl From<RawMessage> for Message {
    fn from(raw: RawMessage) -> Self {
        Self {
            id: raw.id,
            from: raw.from.into(),
            to: raw.to.into(),
            cc: raw.cc.into(),
            bcc: raw.bcc.into(),
            subject: raw.subject,
            date: raw.date,
            text: raw.text,
            html: raw.html,
            size: raw.size,
            tags: raw.tags.unwrap_or_default(),
            attachments: raw
                .attachments
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

/// `Attachment` as Mailpit serializes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawAttachment {
    #[serde(rename = "PartID")]
    part_id: String,
    #[serde(rename = "FileName")]
    file_name: String,
    #[serde(rename = "ContentType")]
    content_type: String,
    size: u64,
}

impl From<RawAttachment> for Attachment {
    fn from(raw: RawAttachment) -> Self {
        Self {
            part_id: raw.part_id,
            file_name: raw.file_name,
            content_type: raw.content_type,
            size: raw.size,
        }
    }
}

/// `MessagesSummary` — the envelope of `GET /api/v1/messages`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct RawMessagesEnvelope {
    total: u64,
    unread: u64,
    messages: Option<Vec<RawMessageSummary>>,
}

/// HTTP client for one Mailpit instance's v1 API.
///
/// Cloning is cheap (shared connection pool); requests time out after five
/// seconds so a stopped service surfaces as an error promptly.
#[derive(Debug, Clone)]
pub struct MailpitClient {
    endpoint: Endpoint,
    http: reqwest::Client,
}

impl MailpitClient {
    /// Creates a client for Mailpit's HTTP endpoint.
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            endpoint: Endpoint::new(host, port),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("static client configuration"),
        }
    }

    /// The endpoint this client targets.
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Fetches the inbox: totals plus up to `limit` newest summaries.
    pub async fn inbox(&self, limit: u32) -> Result<Inbox> {
        let url = format!("{}/api/v1/messages?limit={limit}", self.endpoint.base_url());
        let envelope: RawMessagesEnvelope = self
            .http
            .get(url)
            .send()
            .await
            .map_err(transport_error)?
            .error_for_status()
            .map_err(transport_error)?
            .json()
            .await
            .map_err(transport_error)?;
        Ok(Inbox {
            total: envelope.total,
            unread: envelope.unread,
            messages: envelope
                .messages
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
        })
    }

    /// Fetches one full message by ID.
    pub async fn message(&self, id: &str) -> Result<Message> {
        let url = format!(
            "{}/api/v1/message/{}",
            self.endpoint.base_url(),
            percent_encode(id)
        );
        let raw: RawMessage = self
            .http
            .get(url)
            .send()
            .await
            .map_err(transport_error)?
            .error_for_status()
            .map_err(transport_error)?
            .json()
            .await
            .map_err(transport_error)?;
        Ok(raw.into())
    }

    /// Deletes the given messages, or everything when `ids` is empty.
    pub async fn delete(&self, ids: &[String]) -> Result<()> {
        let url = format!("{}/api/v1/messages", self.endpoint.base_url());
        let body = serde_json::json!({ "ids": ids });
        self.http
            .delete(url)
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?
            .error_for_status()
            .map_err(transport_error)?
            .text()
            .await
            .map_err(transport_error)?;
        Ok(())
    }

    /// Marks messages read (`read: true`) or unread (`read: false`).
    pub async fn set_read(&self, ids: &[String], read: bool) -> Result<()> {
        let url = format!("{}/api/v1/messages", self.endpoint.base_url());
        let body = serde_json::json!({ "ids": ids, "read": read });
        self.http
            .put(url)
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?
            .error_for_status()
            .map_err(transport_error)?
            .text()
            .await
            .map_err(transport_error)?;
        Ok(())
    }
}

/// Maps reqwest failures into [`devx_core::Error`] with Network/Io codes.
fn transport_error(err: reqwest::Error) -> Error {
    if err.is_timeout() {
        Error::new(
            devx_core::ErrorCode::Network,
            format!("mailpit request timed out: {err}"),
        )
    } else if err.is_connect() {
        Error::new(
            devx_core::ErrorCode::Network,
            format!("cannot reach mailpit: {err}"),
        )
    } else {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("mailpit request failed: {err}"),
        )
    }
}

/// Percent-encodes a path segment (Mailpit message IDs are short UUIDs, but
/// be defensive about anything else in the URL).
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
