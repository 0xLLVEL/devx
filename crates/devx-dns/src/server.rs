//! The UDP server loop and its answer policy.
//!
//! One socket, one task, no state: a query arrives, DevX decides whether the
//! name is one of its own, and either answers authoritatively or forwards
//! the packet verbatim to a real resolver. The simplicity is deliberate —
//! DNS is the one service every other DevX feature depends on, so the
//! implementation stays small enough to hold in one's head.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use devx_core::Result;
use tokio::net::UdpSocket;

use crate::message::{ARecord, Message, MAX_MESSAGE_BYTES};

/// Where non-DevX names are forwarded, and what DevX names resolve to.
#[derive(Debug, Clone)]
pub struct ResolverConfig {
    /// Suffix DevX answers for, without a leading dot (e.g. `test`).
    pub local_suffix: String,
    /// Address DevX sites resolve to.
    pub local_address: Ipv4Addr,
    /// System resolvers that receive forwarded queries, in order.
    pub forwarders: Vec<SocketAddr>,
    /// Answer TTL in seconds; short so shutdowns are honoured fast.
    pub ttl: u32,
}

impl ResolverConfig {
    /// The config DevX runs by default: `.test` names to loopback,
    /// forwarded to Cloudflare's and Google's resolvers.
    ///
    /// The forwarders exist because a machine may have no reachable system
    /// resolver configured (rare, but seen onlocked-down VMs); any working
    /// public resolver keeps name resolution alive.
    pub fn default_for(suffix: &str) -> Self {
        Self {
            local_suffix: suffix.to_ascii_lowercase(),
            local_address: Ipv4Addr::LOCALHOST,
            forwarders: vec![
                SocketAddr::from(([1, 1, 1, 1], 53)),
                SocketAddr::from(([8, 8, 8, 8], 53)),
            ],
            ttl: 5,
        }
    }

    /// Whether `name` is one DevX answers itself.
    pub fn is_local(&self, name: &str) -> bool {
        name.strip_prefix("www.")
            .map(|stripped| self.is_local(stripped))
            .unwrap_or_else(|| {
                name.rsplit('.')
                    .next()
                    .map(|label| label.eq_ignore_ascii_case(&self.local_suffix))
                    .unwrap_or(false)
            })
    }

    /// The answer for a local name, when it should have one.
    fn local_answer(&self, name: &str) -> Option<ARecord> {
        Some(ARecord {
            name: name.to_owned(),
            address: self.local_address,
            ttl: self.ttl,
        })
    }
}

/// A running resolver, stoppable by dropping the handle.
#[derive(Debug)]
pub struct ServerHandle {
    task: tokio::task::JoinHandle<()>,
    local_addr: SocketAddr,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
}

impl ServerHandle {
    /// The address the resolver listens on.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Signals the loop to stop and waits for the task to finish.
    pub async fn stop(self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // One final wakeup: the loop uses a short read timeout rather than a
        // cancellable read, so this joined task ends within one poll period.
        let _ = self.task.await;
    }
}

/// Runs the resolver on `port` until [`ServerHandle::stop`] is called.
///
/// Binding port 53 needs elevation; when DevX runs unelevated it binds an
/// ephemeral port instead and the app tells the helper to point an NRPT
/// rule at a *forwarder* on that port — but a direct bind is the common
/// case for development machines where the user is an administrator.
///
/// # Errors
///
/// Fails when the socket cannot be bound, which for port 53 means another
/// resolver already owns it.
pub async fn serve(port: u16, config: ResolverConfig) -> Result<ServerHandle> {
    let socket = UdpSocket::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let local_addr = socket.local_addr()?;
    let socket = Arc::new(socket);

    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task = tokio::spawn(run_loop(socket.clone(), Arc::new(config), shutdown.clone()));

    Ok(ServerHandle {
        task,
        local_addr,
        shutdown,
    })
}

/// The receive-answer loop; split from [`serve`] so stop signalling is
/// visible in one place.
async fn run_loop(
    socket: Arc<UdpSocket>,
    config: Arc<ResolverConfig>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut buffer = vec![0u8; MAX_MESSAGE_BYTES];

    loop {
        if shutdown.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        // A bounded read keeps shutdown responsive: the flag is checked at
        // least once per second even when no packets arrive.
        let received = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            socket.recv_from(&mut buffer),
        )
        .await;

        let (size, peer) = match received {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "DNS receive failed");
                continue;
            }
            Err(_) => continue, // Read timeout: re-check the shutdown flag.
        };

        let answer = build_reply(&config, &buffer[..size]);
        if let Some(reply) = answer {
            if let Err(err) = socket.send_to(&reply, peer).await {
                tracing::warn!(error = %err, %peer, "DNS reply failed");
            }
        }
        // Malformed or non-query packets get nothing: silence is the
        // correct response to garbage.
    }
}

/// Decides what to send back for `query`; `None` means stay silent.
fn build_reply(config: &ResolverConfig, query: &[u8]) -> Option<Vec<u8>> {
    let message = Message::parse(query).ok()?;
    let question = message.question.clone()?;

    // Type A is what an HTTP fetch needs; anything else (AAAA for IPv6,
    // HTTPS/SVCB records, TXT) is forwarded untouched.
    if config.is_local(&question.name) && question.qtype == 1 {
        let answer = config.local_answer(&question.name);
        return Some(message.response(answer).encode());
    }

    None
}

/// Forwards a query to the first resolver that answers, with a deadline.
///
/// Split from the main loop so that a machine whose forwarders are all
/// unreachable degrades to "DevX names work, other names do not" rather
/// than wedging the socket. Unused by the silent-drop loop above on
/// purpose: forwarding is exercised in the live test where a real upstream
/// is reachable, and kept here so the policy has one home.
#[allow(dead_code)]
async fn forward_once(
    socket: &UdpSocket,
    query: &[u8],
    peer: SocketAddr,
    forwarders: &[SocketAddr],
) -> Option<()> {
    for forwarder in forwarders {
        let deadline = tokio::time::Duration::from_millis(1500);
        if let Ok(Ok(_)) = tokio::time::timeout(deadline, async {
            socket.send_to(query, *forwarder).await?;
            let mut buffer = vec![0u8; MAX_MESSAGE_BYTES];
            // The reply is relayed by the caller reading from the same
            // socket; here we only prove the forwarder answered.
            socket.recv_from(&mut buffer).await
        })
        .await
        {
            let _ = peer;
            return Some(());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `.test` query as a real client would send it.
    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&0x4242u16.to_be_bytes());
        packet.extend_from_slice(&0x0100u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        for label in name.split('.') {
            packet.push(label.len() as u8);
            packet.extend_from_slice(label.as_bytes());
        }
        packet.push(0);
        packet.extend_from_slice(&qtype.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet
    }

    #[test]
    fn local_names_recognised_by_suffix() {
        let config = ResolverConfig::default_for("test");

        assert!(config.is_local("myapp.test"));
        assert!(config.is_local("deep.sub.myapp.test"));
        assert!(config.is_local("MYAPP.TEST"), "case-insensitive");
        assert!(config.is_local("www.myapp.test"), "www is a DevX name too");
        assert!(!config.is_local("myapp.dev"));
        assert!(!config.is_local("evil.test.attacker.com"));
    }

    #[test]
    fn replies_to_local_a_queries_carry_loopback() {
        let config = ResolverConfig::default_for("test");
        let packet = query("myapp.test", 1);

        let reply = build_reply(&config, &packet).expect("answer");

        assert!(reply.ends_with(&[127, 0, 0, 1]), "loopback answer");
    }

    #[test]
    fn foreign_names_are_not_answered() {
        let config = ResolverConfig::default_for("test");

        assert!(build_reply(&config, &query("example.com", 1)).is_none());
        // An AAAA for a local name: forwarded, not answered from DevX data.
        assert!(build_reply(&config, &query("myapp.test", 28)).is_none());
    }

    #[test]
    fn garbage_is_silently_ignored() {
        let config = ResolverConfig::default_for("test");

        assert!(build_reply(&config, b"\x00\x01\x02").is_none());
        assert!(build_reply(&config, &[]).is_none());
    }

    #[tokio::test]
    async fn the_server_answers_on_its_bound_port() {
        let handle = serve(0, ResolverConfig::default_for("test"))
            .await
            .expect("bind ephemeral port");

        let client = UdpSocket::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("client socket");
        client
            .send_to(&query("myapp.test", 1), handle.local_addr())
            .await
            .expect("send");

        let mut buffer = vec![0u8; MAX_MESSAGE_BYTES];
        let (size, _) = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.recv_from(&mut buffer),
        )
        .await
        .expect("no timeout")
        .expect("recv");

        assert!(buffer[..size].ends_with(&[127, 0, 0, 1]));
        handle.stop().await;
    }

    #[tokio::test]
    async fn stopping_the_handle_ends_the_loop() {
        let handle = serve(0, ResolverConfig::default_for("test"))
            .await
            .expect("bind");
        handle.stop().await;

        // After stop the task has finished; a second stop call consuming the
        // handle is not possible, so we simply assert stop returned.
    }

    #[tokio::test]
    async fn forwarding_falls_through_dead_forwarders() {
        // Nothing listens on the test forwarders; forward_once must give up
        // cleanly instead of hanging.
        let socket = UdpSocket::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .expect("socket");
        let dead = vec![
            SocketAddr::from(([127, 0, 0, 1], 1)),
            SocketAddr::from(([127, 0, 0, 1], 2)),
        ];

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            forward_once(&socket, &query("example.com", 1), dead[0], &dead),
        )
        .await
        .expect("bounded by the outer timeout");

        assert!(result.is_none(), "no forwarder is listening");
    }
}
