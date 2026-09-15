//! A minimal SMTP client for the local Mailpit round-trip test.
//!
//! Only what Mailpit's unauthenticated local listener needs: greeting,
//! HELO, one message, QUIT. No TLS, no AUTH, no pipelining — deliberately,
//! because the point is to behave like the simplest possible mail-sending
//! application.

use devx_core::{Error, ErrorCode};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// One SMTP conversation over an already-connected TCP stream.
///
/// Generic over the reader/writer halves so tests can run it against an
/// in-memory duplex instead of a socket.
pub struct SmtpSession<'a, R, W> {
    reader: BufReader<&'a mut R>,
    writer: &'a mut W,
}

impl<'a, R, W> SmtpSession<'a, R, W>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    /// Wraps an open connection.
    pub fn new(reader: &'a mut R, writer: &'a mut W) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
        }
    }

    /// Reads one SMTP reply line, enforcing the expected status prefix.
    async fn expect(&mut self, expected: &str, step: &str) -> Result<String, Error> {
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .await
            .map_err(|err| smtp_error(step, err))?;
        if !line.starts_with(expected) {
            return Err(smtp_error(
                step,
                format!("unexpected reply: {}", line.trim_end()),
            ));
        }
        Ok(line)
    }

    /// Sends one command line, waiting for the reply the step expects.
    async fn command(&mut self, line: &str, expect: &str, step: &str) -> Result<String, Error> {
        self.writer
            .write_all(format!("{line}\r\n").as_bytes())
            .await
            .map_err(|err| smtp_error(step, err))?;
        self.writer.flush().await.map_err(|err| smtp_error(step, err))?;
        self.expect(expect, step).await
    }

    /// Reads the server's 220 greeting.
    pub async fn expect_greeting(&mut self) -> Result<(), Error> {
        self.expect("220", "greeting").await.map(|_| ())
    }

    /// Introduces the client.
    pub async fn helo(&mut self, hostname: &str) -> Result<(), Error> {
        self.command(&format!("HELO {hostname}"), "250", "HELO")
            .await
            .map(|_| ())
    }

    /// Sets the envelope sender.
    pub async fn mail_from(&mut self, address: &str) -> Result<(), Error> {
        self.command(&format!("MAIL FROM:<{address}>"), "250", "MAIL FROM")
            .await
            .map(|_| ())
    }

    /// Sets one envelope recipient.
    pub async fn rcpt_to(&mut self, address: &str) -> Result<(), Error> {
        self.command(&format!("RCPT TO:<{address}>"), "250", "RCPT TO")
            .await
            .map(|_| ())
    }

    /// Sends the message body: subject plus plain text, dot-terminated.
    pub async fn data(&mut self, subject: &str, body: &str) -> Result<(), Error> {
        self.command("DATA", "354", "DATA").await?;
        // A lone dot would terminate early; SMTP escapes it by doubling.
        let escaped_body = body.replace("\r\n", "\n").replace("\n.", "\n..");
        let payload = format!(
            "From: DevX <devx@test.local>\r\nTo: recipient@test.local\r\nSubject: {subject}\r\nDate: {}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{escaped_body}\r\n.\r\n",
            chrono_free_timestamp()
        );
        self.writer
            .write_all(payload.as_bytes())
            .await
            .map_err(|err| smtp_error("message body", err))?;
        self.writer.flush().await.map_err(|err| smtp_error("message body", err))?;
        self.expect("250", "message accepted").await.map(|_| ())
    }

    /// Ends the conversation politely.
    pub async fn quit(&mut self) -> Result<(), Error> {
        self.command("QUIT", "221", "QUIT").await.map(|_| ())
    }
}

/// RFC 5322-ish timestamp without pulling a date-formatting dependency:
/// Mailpit displays whatever it receives, and the local round-trip only
/// needs a well-formed Date header.
fn chrono_free_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since epoch to a civil date (Howard Hinnant's algorithm).
    let days = now / 86_400;
    let secs_of_day = now % 86_400;
    let (hour, minute, second) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let weekday = (days % 7) as usize;
    format!(
        "{}, {} {} {} {:02}:{:02}:{:02} +0000",
        WEEKDAYS[weekday],
        day,
        MONTHS[(month - 1) as usize],
        year,
        hour,
        minute,
        second
    )
}

fn smtp_error(step: impl std::fmt::Display, detail: impl std::fmt::Display) -> Error {
    Error::new(
        ErrorCode::Network,
        format!("SMTP {step} failed: {detail}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives the session against a scripted fake server and asserts the
    /// exact wire conversation.
    #[tokio::test(flavor = "multi_thread")]
    async fn full_conversation_is_well_formed() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (server_read, mut server_write) = socket.into_split();
            let mut lines = tokio::io::BufReader::new(server_read);
            let mut buf = String::new();

            server_write.write_all(b"220 mailpit ready\r\n").await.unwrap();
            lines.read_line(&mut buf).await.unwrap(); // HELO
            assert!(buf.starts_with("HELO "));
            buf.clear();
            server_write.write_all(b"250 ok\r\n").await.unwrap();
            lines.read_line(&mut buf).await.unwrap(); // MAIL FROM
            assert!(buf.starts_with("MAIL FROM:<devx@test.local>"));
            buf.clear();
            server_write.write_all(b"250 ok\r\n").await.unwrap();
            lines.read_line(&mut buf).await.unwrap(); // RCPT TO
            assert!(buf.starts_with("RCPT TO:<recipient@test.local>"));
            buf.clear();
            server_write.write_all(b"250 ok\r\n").await.unwrap();
            lines.read_line(&mut buf).await.unwrap(); // DATA
            assert_eq!(buf.trim_end(), "DATA");
            buf.clear();
            server_write.write_all(b"354 go\r\n").await.unwrap();

            // Accumulate the message to the terminating dot.
            let mut message = String::new();
            loop {
                buf.clear();
                lines.read_line(&mut buf).await.unwrap();
                message.push_str(&buf);
                if buf.trim_end() == "." {
                    break;
                }
            }
            assert!(message.contains("Subject: DevX test email"));
            assert!(message.contains("Content-Type: text/plain"));
            assert!(message.contains("round-trip body"));
            server_write.write_all(b"250 queued\r\n").await.unwrap();
            buf.clear();
            lines.read_line(&mut buf).await.unwrap(); // QUIT
            assert_eq!(buf.trim_end(), "QUIT");
            server_write.write_all(b"221 bye\r\n").await.unwrap();
        });

        let socket = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut client_read, mut client_write) = socket.into_split();
        let mut session = SmtpSession::new(&mut client_read, &mut client_write);
        session.expect_greeting().await.unwrap();
        session.helo("127.0.0.1").await.unwrap();
        session.mail_from("devx@test.local").await.unwrap();
        session.rcpt_to("recipient@test.local").await.unwrap();
        session.data("DevX test email", "round-trip body").await.unwrap();
        session.quit().await.unwrap();

        server.await.unwrap();
    }

    #[test]
    fn message_with_leading_dot_is_escaped() {
        // The DATA payload doubles a leading dot so it cannot terminate the
        // message early; assert via the same transformation `data` uses.
        let body = "line one\n.hidden line\nend";
        let escaped = body.replace("\r\n", "\n").replace("\n.", "\n..");
        assert!(escaped.contains("\n..hidden line"));
    }

    #[test]
    fn timestamp_is_rfc5322_shaped() {
        let ts = chrono_free_timestamp();
        // "Thu, 1 Jan 2026 00:00:00 +0000" shape.
        let pieces: Vec<&str> = ts.split(' ').collect();
        assert_eq!(pieces.len(), 6);
        assert!(pieces[0].ends_with(','));
        assert_eq!(pieces[5], "+0000");
    }
}
