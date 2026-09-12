//! Length-prefixed framing over a tokio byte stream.
//!
//! Named pipes deliver bytes without message boundaries, so both sides frame
//! every request and response as `u32 LE length + payload`. The cap rejects a
//! hostile or broken peer before a huge allocation happens: no legitimate
//! message in this protocol approaches a megabyte.

use devx_core::{Error, ErrorCode, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Largest accepted frame, 1 MiB.
///
/// Requests are a few hundred bytes; responses carry at most a hosts file's
/// worth of entries. Anything larger is a protocol violation, not big data.
pub const MAX_FRAME_BYTES: u32 = 1024 * 1024;

/// Serializes `value` as JSON and writes one frame.
///
/// Returns the number of payload bytes written.
pub async fn write_frame<S, T>(stream: &mut S, value: &T) -> Result<usize>
where
    S: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value).map_err(|err| {
        Error::new(
            ErrorCode::Internal,
            format!("failed to serialize protocol message: {err}"),
        )
    })?;

    let len = u32::try_from(payload.len()).map_err(|_| {
        Error::new(
            ErrorCode::Internal,
            format!("message exceeds frame limit: {} bytes", payload.len()),
        )
    })?;

    stream
        .write_all(&len.to_le_bytes())
        .await
        .map_err(frame_io("write frame length"))?;
    stream
        .write_all(&payload)
        .await
        .map_err(frame_io("write frame payload"))?;
    stream.flush().await.map_err(frame_io("flush frame"))?;

    Ok(payload.len())
}

/// Reads one frame and deserializes it as `T`.
///
/// A zero-length frame is a clean EOF (peer closed between messages) and maps
/// to `Ok(None)` so callers can distinguish an orderly shutdown from garbage.
pub async fn read_frame<S, T>(stream: &mut S) -> Result<Option<T>>
where
    S: AsyncReadExt + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(frame_io("read frame length")(err)),
    }

    let len = u32::from_le_bytes(len_buf);
    if len > MAX_FRAME_BYTES {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!("frame of {len} bytes exceeds the {MAX_FRAME_BYTES}-byte limit"),
        ));
    }

    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .await
        .map_err(frame_io("read frame payload"))?;

    serde_json::from_slice(&payload).map(Some).map_err(|err| {
        Error::new(
            ErrorCode::InvalidInput,
            format!("frame is not a valid protocol message: {err}"),
        )
    })
}

/// Wraps an IO error with what the codec was doing.
fn frame_io(action: &'static str) -> impl Fn(std::io::Error) -> Error {
    move |err| Error::new(ErrorCode::Io, format!("failed to {action}: {err}"))
}

/// Serializes `value` as JSON and writes one frame over a *synchronous*
/// stream.
///
/// The helper's blocking server loop uses this twin of [`write_frame`]; the
/// size cap and framing rules are identical.
pub fn write_frame_sync<W, T>(stream: &mut W, value: &T) -> Result<usize>
where
    W: std::io::Write,
    T: Serialize,
{
    let payload = serde_json::to_vec(value).map_err(|err| {
        Error::new(
            ErrorCode::Internal,
            format!("failed to serialize protocol message: {err}"),
        )
    })?;

    let len = u32::try_from(payload.len()).map_err(|_| {
        Error::new(
            ErrorCode::Internal,
            format!("message exceeds frame limit: {} bytes", payload.len()),
        )
    })?;

    stream
        .write_all(&len.to_le_bytes())
        .and_then(|()| stream.write_all(&payload))
        .and_then(|()| stream.flush())
        .map_err(frame_io("write synchronous frame"))?;

    Ok(payload.len())
}

/// Reads one frame from a *synchronous* stream and deserializes it as `T`.
///
/// Mirrors [`read_frame`]: clean EOF maps to `Ok(None)`, oversized frames and
/// garbage payloads are refused before trust is extended.
pub fn read_frame_sync<R, T>(stream: &mut R) -> Result<Option<T>>
where
    R: std::io::Read,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(frame_io("read frame length")(err)),
    }

    let len = u32::from_le_bytes(len_buf);
    if len > crate::MAX_FRAME_BYTES {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            format!(
                "frame of {len} bytes exceeds the {}-byte limit",
                crate::MAX_FRAME_BYTES
            ),
        ));
    }

    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(frame_io("read frame payload"))?;

    serde_json::from_slice(&payload).map(Some).map_err(|err| {
        Error::new(
            ErrorCode::InvalidInput,
            format!("frame is not a valid protocol message: {err}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HostsEntry, PrivilegedRequest, PROTOCOL_VERSION};
    use pretty_assertions::assert_eq;
    use tokio::io::DuplexStream;

    /// Splits a duplex stream into client and server halves.
    fn duplex() -> (DuplexStream, DuplexStream) {
        tokio::io::duplex(1024)
    }

    #[tokio::test]
    async fn frames_round_trip_through_a_stream() {
        let (mut client, mut server) = duplex();

        let writer = tokio::spawn(async move {
            write_frame(&mut client, &PrivilegedRequest::ListHostsEntries)
                .await
                .expect("write");
        });

        let request: PrivilegedRequest =
            read_frame(&mut server).await.expect("read").expect("frame");
        writer.await.expect("writer task");
        assert_eq!(request, PrivilegedRequest::ListHostsEntries);
    }

    #[tokio::test]
    async fn closed_stream_is_a_clean_none() {
        let (client, mut server) = duplex();
        drop(client);

        let frame: Option<PrivilegedRequest> = read_frame(&mut server).await.expect("read");
        assert!(frame.is_none(), "EOF must map to None, not an error");
    }

    #[tokio::test]
    async fn oversized_length_is_rejected_before_allocating() {
        let (mut client, mut server) = duplex();

        // Write a length header that lies about a huge payload.
        let lie = (MAX_FRAME_BYTES + 1).to_le_bytes();
        client.write_all(&lie).await.expect("write header");
        drop(client);

        let err = read_frame::<_, PrivilegedRequest>(&mut server)
            .await
            .expect_err("an oversized frame must be refused");
        assert_eq!(err.code, devx_core::ErrorCode::InvalidInput);
        assert!(err.message.contains("exceeds"), "{}", err.message);
    }

    #[tokio::test]
    async fn garbage_payload_is_a_protocol_error() {
        let (mut client, mut server) = duplex();

        let payload = b"not json at all";
        client
            .write_all(&(payload.len() as u32).to_le_bytes())
            .await
            .expect("header");
        client.write_all(payload).await.expect("payload");
        drop(client);

        let err = read_frame::<_, PrivilegedRequest>(&mut server)
            .await
            .expect_err("garbage must be refused");
        assert_eq!(err.code, devx_core::ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn two_frames_do_not_bleed_into_each_other() {
        let (mut client, mut server) = duplex();

        write_frame(
            &mut client,
            &PrivilegedRequest::Hello {
                version: PROTOCOL_VERSION,
            },
        )
        .await
        .expect("first");
        write_frame(
            &mut client,
            &PrivilegedRequest::AddHostsEntry(HostsEntry {
                hostname: "a.test".into(),
                ip: "127.0.0.1".into(),
            }),
        )
        .await
        .expect("second");
        drop(client);

        let first: PrivilegedRequest = read_frame(&mut server).await.expect("read").expect("frame");
        let second: PrivilegedRequest =
            read_frame(&mut server).await.expect("read").expect("frame");

        assert_eq!(
            first,
            PrivilegedRequest::Hello {
                version: PROTOCOL_VERSION
            }
        );
        assert_eq!(
            second,
            PrivilegedRequest::AddHostsEntry(HostsEntry {
                hostname: "a.test".into(),
                ip: "127.0.0.1".into(),
            })
        );
    }

    #[test]
    fn cap_is_documented_and_sane() {
        assert_eq!(MAX_FRAME_BYTES, 1024 * 1024);
    }
}
