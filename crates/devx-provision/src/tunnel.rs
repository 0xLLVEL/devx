//! Quick tunnel sharing: put a local site on a public URL with cloudflared.
//!
//! Task 14 uses Cloudflare's *quick tunnels* (`trycloudflare.com`): no
//! account, no config file — `cloudflared tunnel --url <local>` prints the
//! assigned `https://…trycloudflare.com` URL on stdout once the tunnel is
//! live. DevX runs one cloudflared process per shared site through the
//! ordinary supervisor, so lifecycle, logging and crash handling are all
//! inherited rather than reinvented.
//!
//! This module holds the two pure pieces the desktop layer needs: the exact
//! cloudflared invocation for a site, and the parser that digs the assigned
//! URL out of the process log (Cloudflare changes log line shapes between
//! releases, so matching is deliberately permissive and *tested*).
//!
//! ```no_run
//! # fn main() -> devx_core::Result<()> {
//! let args = devx_provision::tunnel::tunnel_args("http://127.0.0.1:8080");
//! assert!(args.iter().any(|a| a == "--url"));
//! # Ok(())
//! # }
//! ```

use once_cell::sync::Lazy;
use regex::Regex;

/// The well-known host suffix of quick-tunnel URLs.
pub const QUICK_TUNNEL_SUFFIX: &str = "trycloudflare.com";

/// Builds the `cloudflared` argument list that forwards a quick tunnel to
/// `local_url` (e.g. `http://127.0.0.1:80`).
///
/// The URL must be loopback or localhost — a share is a bridge to something
/// DevX itself serves, never a proxy for an arbitrary remote.
pub fn tunnel_args(local_url: &str) -> Vec<String> {
    let lowered = local_url.to_ascii_lowercase();
    let loopback = {
        let after_scheme = lowered
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&lowered);
        let host = after_scheme.split(['/', ':']).next().unwrap_or_default();
        host == "127.0.0.1" || host == "localhost" || host == "::1"
    };
    if !loopback {
        // The desktop layer validates further; this is the last-line check.
        return Vec::new();
    }

    vec![
        "tunnel".to_owned(),
        "--url".to_owned(),
        local_url.to_owned(),
        "--no-autoupdate".to_owned(),
    ]
}

/// Extracts the assigned quick-tunnel URL from cloudflared's log output.
///
/// Quick tunnels announce themselves on a line like
/// `+-----------------------------------------------------------...`
/// followed by `|  https://something-words-1234.trycloudflare.com  |` inside
/// an ASCII box, or on plain `https://…trycloudflare.com` occurrences in
/// other log shapes. This returns the *first* URL whose host ends in the
/// quick-tunnel suffix, which is the freshly assigned one.
pub fn extract_tunnel_url(log_text: &str) -> Option<String> {
    static URL_RE: Lazy<Regex> = Lazy::new(|| {
        // `\b` boundaries and a relaxed host charset keep this independent of
        // the box-drawing characters that may surround the URL.
        Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").expect("valid regex")
    });

    URL_RE
        .find_iter(log_text)
        .map(|m| m.as_str().to_owned())
        .next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn tunnel_args_forward_the_local_url() {
        let args = tunnel_args("http://127.0.0.1:8080");
        assert_eq!(
            args,
            vec![
                "tunnel",
                "--url",
                "http://127.0.0.1:8080",
                "--no-autoupdate",
            ]
        );
    }

    #[test]
    fn tunnel_args_accept_localhost() {
        let args = tunnel_args("http://localhost:80");
        assert!(args.contains(&"--url".to_owned()));
        assert!(args.contains(&"http://localhost:80".to_owned()));
    }

    #[test]
    fn tunnel_args_refuse_non_loopback_targets() {
        assert!(tunnel_args("http://example.com").is_empty());
        assert!(tunnel_args("http://10.1.2.3:9000").is_empty());
    }

    #[test]
    fn extract_url_reads_the_boxed_announcement() {
        // The real shape cloudflared prints (box + padding + words).
        let log = "\
2026-09-12T10:00:00Z INF +--------------------------------------------------------------------+
2026-09-12T10:00:00Z |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-12T10:00:00Z |  https://slowest-words-here-9876.trycloudflare.com  |
2026-09-12T10:00:00Z +--------------------------------------------------------------------+";
        assert_eq!(
            extract_tunnel_url(log).as_deref(),
            Some("https://slowest-words-here-9876.trycloudflare.com")
        );
    }

    #[test]
    fn extract_url_reads_a_plain_line_too() {
        let log =
            "2026-09-12T10:00:00Z INF Registered tunnel connection url=https://abc-def-123.trycloudflare.com";
        assert_eq!(
            extract_tunnel_url(log).as_deref(),
            Some("https://abc-def-123.trycloudflare.com")
        );
    }

    #[test]
    fn extract_url_returns_none_without_a_tunnel_url() {
        assert_eq!(extract_tunnel_url("no urls here"), None);
        // Other cloudflared URLs (dashboard, metrics) must not match.
        assert_eq!(
            extract_tunnel_url("https://api.cloudflare.com/client/v4"),
            None
        );
    }
}
