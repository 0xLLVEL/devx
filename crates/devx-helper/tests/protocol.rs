//! End-to-end protocol test: drives the helper dispatcher through the exact
//! wire framing a real pipe carries, using in-memory duplex streams.
//!
//! This is the fastest test that catches "the two sides disagree" bugs without
//! elevation, which is why it lives outside `#[cfg(test)]` — it is the helper
//! side of the contract `devx-privileged`'s client assumes.
//!
//! Nothing here touches the machine: the hosts backend is a file under
//! `tempfile`, and the resolver-cache backend only counts. Neither
//! `C:\Windows\System32\drivers\etc\hosts` nor `ipconfig` is ever reached.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use devx_core::Result;
use devx_helper::dns_cache::DnsCacheBackend;
use devx_helper::nrpt::WindowsNrptBackend;
use devx_helper::{Backends, FileHostsBackend, WindowsCaBackend};
use devx_ipc::{
    read_frame, write_frame, HostsEntry, PrivilegedRequest, PrivilegedResponse, PROTOCOL_VERSION,
};

/// A resolver cache that records how often it was dropped instead of dropping
/// the machine's real one, so the flush request can be proven on the wire
/// without running `ipconfig` or needing elevation.
struct RecordingDnsCache {
    flushes: Arc<AtomicU32>,
}

impl DnsCacheBackend for RecordingDnsCache {
    fn flush(&self) -> Result<()> {
        self.flushes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// Builds the backend set over a fresh hosts file, seeded with one foreign
/// line; the CA backend is the real Windows one (checks only, nothing is
/// installed by these tests). The returned counter belongs to the fake
/// resolver cache.
fn temp_backends() -> (tempfile::TempDir, Backends, Arc<AtomicU32>) {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("hosts");
    std::fs::write(&path, "127.0.0.1 localhost\n").expect("seed");
    let flushes = Arc::new(AtomicU32::new(0));
    let backends = Backends {
        hosts: Box::new(FileHostsBackend::at(&path)),
        ca: Box::new(WindowsCaBackend),
        nrpt: Box::new(WindowsNrptBackend),
        dns_cache: Box::new(RecordingDnsCache {
            flushes: Arc::clone(&flushes),
        }),
    };
    (dir, backends, flushes)
}

#[tokio::test(flavor = "multi_thread")]
async fn wire_round_trip_adds_and_lists_entries() {
    let (_dir, backend, _flushes) = temp_backends();
    let backend = Arc::new(backend);

    // Server half: answer frames exactly as the pipe server does.
    let (mut server, mut client) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        // Handshake.
        let hello: PrivilegedRequest = read_frame(&mut server)
            .await
            .expect("read hello")
            .expect("hello frame");
        let response = devx_helper::handle(backend.as_ref(), &hello);
        write_frame(&mut server, &response).await.expect("reply");

        // Add.
        let request: PrivilegedRequest = read_frame(&mut server)
            .await
            .expect("read add")
            .expect("add frame");
        let response = devx_helper::handle(backend.as_ref(), &request);
        write_frame(&mut server, &response).await.expect("reply");

        // List.
        let request: PrivilegedRequest = read_frame(&mut server)
            .await
            .expect("read list")
            .expect("list frame");
        let response = devx_helper::handle(backend.as_ref(), &request);
        write_frame(&mut server, &response).await.expect("reply");
    });

    // Client half, speaking the same frames `devx-privileged` speaks.
    write_frame(
        &mut client,
        &PrivilegedRequest::Hello {
            version: PROTOCOL_VERSION,
        },
    )
    .await
    .expect("send hello");
    let hello: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read hello reply")
        .expect("hello reply");
    assert_eq!(
        hello,
        PrivilegedResponse::Hello {
            version: PROTOCOL_VERSION
        }
    );

    write_frame(
        &mut client,
        &PrivilegedRequest::AddHostsEntry(HostsEntry {
            hostname: "app.test".into(),
            ip: "127.0.0.1".into(),
        }),
    )
    .await
    .expect("send add");
    let applied: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read applied")
        .expect("applied frame");
    assert_eq!(applied, PrivilegedResponse::Applied);

    write_frame(&mut client, &PrivilegedRequest::ListHostsEntries)
        .await
        .expect("send list");
    let listing: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read listing")
        .expect("listing frame");
    assert_eq!(
        listing,
        PrivilegedResponse::HostsEntries(vec![HostsEntry {
            hostname: "app.test".into(),
            ip: "127.0.0.1".into(),
        }])
    );

    server_task.await.expect("server task");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hostile_client_cannot_smuggle_an_invalid_entry() {
    let (_dir, backend, _flushes) = temp_backends();
    let backend = Arc::new(backend);

    let (mut server, mut client) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        while let Some(request) = read_frame::<_, PrivilegedRequest>(&mut server)
            .await
            .expect("read")
        {
            let response = devx_helper::handle(backend.as_ref(), &request);
            write_frame(&mut server, &response).await.expect("reply");
        }
    });

    write_frame(
        &mut client,
        &PrivilegedRequest::AddHostsEntry(HostsEntry {
            hostname: "*.evil".into(),
            ip: "127.0.0.1".into(),
        }),
    )
    .await
    .expect("send hostile add");

    let rejected: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read rejection")
        .expect("rejection frame");
    assert!(
        matches!(rejected, PrivilegedResponse::Rejected { .. }),
        "{rejected:?}"
    );

    drop(client);
    server_task.await.expect("server task");
}

/// §111's Flush DNS, driven through the wire exactly as the desktop client
/// drives it: the helper must answer `Applied`, ask the resolver cache to drop
/// once, and leave the hosts file byte for byte as it was.
#[tokio::test(flavor = "multi_thread")]
async fn wire_round_trip_flushes_the_cache_without_touching_the_hosts_file() {
    let (dir, backend, flushes) = temp_backends();
    let hosts_path = dir.path().join("hosts");
    let before = std::fs::read_to_string(&hosts_path).expect("read seed");

    let backend = Arc::new(backend);
    let (mut server, mut client) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        while let Some(request) = read_frame::<_, PrivilegedRequest>(&mut server)
            .await
            .expect("read")
        {
            let response = devx_helper::handle(backend.as_ref(), &request);
            write_frame(&mut server, &response).await.expect("reply");
        }
    });

    write_frame(
        &mut client,
        &PrivilegedRequest::Hello {
            version: PROTOCOL_VERSION,
        },
    )
    .await
    .expect("send hello");
    let hello: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read hello reply")
        .expect("hello reply");
    assert_eq!(
        hello,
        PrivilegedResponse::Hello {
            version: PROTOCOL_VERSION
        },
        "a version 2 client must be accepted by a version 2 helper"
    );

    write_frame(&mut client, &PrivilegedRequest::FlushDns)
        .await
        .expect("send flush");
    let flushed: PrivilegedResponse = read_frame(&mut client)
        .await
        .expect("read flush reply")
        .expect("flush reply");
    assert_eq!(flushed, PrivilegedResponse::Applied);

    assert_eq!(
        flushes.load(Ordering::Relaxed),
        1,
        "the cache must be dropped exactly once"
    );
    assert_eq!(
        std::fs::read_to_string(&hosts_path).expect("read back"),
        before,
        "flushing is not a mutation"
    );

    drop(client);
    server_task.await.expect("server task");
}
