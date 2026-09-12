//! Tests for the Mailpit API client, run against a local mock server.
//!
//! The mock replies with Mailpit's real wire shapes — capitalized Go exports,
//! `null` From, absent tags — so the DTO mapping is exercised end to end.

use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use devx_mail::MailpitClient;

/// The inbox listing Mailpit returns, warts and all.
fn messages_body() -> serde_json::Value {
    serde_json::json!({
        "total": 2,
        "unread": 1,
        "count": 2,
        "messages_count": 2,
        "messages_unread": 1,
        "start": 0,
        "tags": ["welcome"],
        "messages": [
            {
                "ID": "1827969f40763c0b286a01e26e30ba51",
                "MessageID": "8ea1f0f5-8b3b-4a0b-9f4e-1b0d3b6a2c01",
                "Read": false,
                "From": { "Name": "My App", "Address": "app@myapp.test" },
                "To": [{ "Name": "", "Address": "user@example.com" }],
                "Cc": [],
                "Bcc": [],
                "ReplyTo": [],
                "Subject": "Welcome!",
                "Created": "2026-09-12T10:30:00.123+02:00",
                "Tags": ["welcome"],
                "Size": 5120,
                "Attachments": 1,
                "Snippet": "Thanks for signing up..."
            },
            {
                "ID": "2f21a7dbd0f0a4b4c19c98f0c1d3e5a7",
                "MessageID": "cafe1234-0000-4000-8000-000000000000",
                "Read": true,
                "From": null,
                "To": [{ "Name": "Dev", "Address": "dev@myapp.test" }],
                "Subject": "",
                "Created": "2026-09-11T08:00:00+02:00",
                "Size": 128,
                "Attachments": 0,
                "Snippet": "password reset link"
            }
        ]
    })
}

#[tokio::test]
async fn inbox_normalizes_mailpit_shapes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(messages_body()))
        .mount(&server)
        .await;

    let client = MailpitClient::new("127.0.0.1", server.address().port());
    let inbox = client.inbox(50).await.expect("inbox");

    assert_eq!(inbox.total, 2);
    assert_eq!(inbox.unread, 1);
    assert_eq!(inbox.messages.len(), 2);

    let first = &inbox.messages[0];
    assert_eq!(first.id, "1827969f40763c0b286a01e26e30ba51");
    assert!(!first.read);
    assert_eq!(first.from.address, "app@myapp.test");
    assert_eq!(first.from.name, "My App");
    assert_eq!(first.subject, "Welcome!");
    assert_eq!(first.attachments, 1);
    assert_eq!(first.tags, vec!["welcome"]);

    // A `null` From normalizes to an empty address rather than an error.
    let second = &inbox.messages[1];
    assert_eq!(second.from.address, "");
    assert_eq!(second.from.name, "");
    assert_eq!(second.tags, Vec::<String>::new());
}

#[tokio::test]
async fn message_fetches_full_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/message/1827969f40763c0b286a01e26e30ba51"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "ID": "1827969f40763c0b286a01e26e30ba51",
            "MessageID": "8ea1f0f5-8b3b-4a0b-9f4e-1b0d3b6a2c01",
            "From": { "Name": "My App", "Address": "app@myapp.test" },
            "To": [{ "Name": "", "Address": "user@example.com" }],
            "Cc": [{ "Name": "", "Address": "cc@example.com" }],
            "Bcc": [],
            "ReplyTo": [],
            "ReturnPath": "app@myapp.test",
            "Subject": "Welcome!",
            "Date": "2026-09-12T10:29:00+02:00",
            "Tags": ["welcome"],
            "Size": 5120,
            "Text": "Thanks for signing up.",
            "HTML": "<p>Thanks for signing up.</p>",
            "Inline": [],
            "Attachments": [{
                "PartID": "2",
                "FileName": "invoice.pdf",
                "ContentType": "application/pdf",
                "ContentID": "",
                "Size": 1400,
                "Checksums": { "MD5": "x", "SHA1": "y", "SHA256": "z" }
            }]
        })))
        .mount(&server)
        .await;

    let client = MailpitClient::new("127.0.0.1", server.address().port());
    let message = client
        .message("1827969f40763c0b286a01e26e30ba51")
        .await
        .expect("message");

    assert_eq!(message.subject, "Welcome!");
    assert_eq!(message.text.as_deref(), Some("Thanks for signing up."));
    assert_eq!(
        message.html.as_deref(),
        Some("<p>Thanks for signing up.</p>")
    );
    assert_eq!(message.cc.len(), 1);
    assert_eq!(message.bcc, Vec::new());
    assert_eq!(message.attachments.len(), 1);
    assert_eq!(message.attachments[0].file_name, "invoice.pdf");
    assert_eq!(message.attachments[0].content_type, "application/pdf");
}

#[tokio::test]
async fn delete_sends_ids_and_clear_sends_empty() {
    let server = MockServer::start().await;
    // Scoped mocks verify their `expect` counts when the guard drops.
    let expect_one = Mock::given(method("DELETE"))
        .and(path("/api/v1/messages"))
        .and(body_json(serde_json::json!({ "ids": ["abc"] })))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let expect_all = Mock::given(method("DELETE"))
        .and(path("/api/v1/messages"))
        .and(body_json(serde_json::json!({ "ids": [] })))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .expect(1)
        .mount_as_scoped(&server)
        .await;

    let client = MailpitClient::new("127.0.0.1", server.address().port());

    client
        .delete(&["abc".to_owned()])
        .await
        .expect("delete one");
    client.delete(&[]).await.expect("delete all");
    // Dropping the guards verifies the `expect(1)` counts.
    drop(expect_one);
    drop(expect_all);
}

#[tokio::test]
async fn set_read_puts_read_flag() {
    let server = MockServer::start().await;
    let expect = Mock::given(method("PUT"))
        .and(path("/api/v1/messages"))
        .and(body_json(
            serde_json::json!({ "ids": ["a", "b"], "read": true }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .expect(1)
        .mount_as_scoped(&server)
        .await;

    let client = MailpitClient::new("127.0.0.1", server.address().port());
    client
        .set_read(&["a".to_owned(), "b".to_owned()], true)
        .await
        .expect("set read");
    drop(expect);
}

#[tokio::test]
async fn a_stopped_server_surfaces_as_a_network_error() {
    // Nothing listens on the port; reqwest fails to connect.
    let client = MailpitClient::new("127.0.0.1", 1);
    let err = client.inbox(10).await.expect_err("must fail");

    assert_eq!(err.code, devx_core::ErrorCode::Network);
}
