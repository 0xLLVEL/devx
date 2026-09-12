//! Request and response types of the helper protocol.
//!
//! Both sides deserialize the same enums, so adding a variant is a compile
//! error everywhere it matters until both ends agree. `specta` types are
//! derived even though these never cross the Tauri boundary directly: the
//! privileged *status* command exposes one response shape to the UI, and
//! keeping the type shared forces that exposure to stay accurate.

use serde::{Deserialize, Serialize};

/// Protocol version a peer must speak to be trusted.
///
/// Bumped on any incompatible change to the request or response shape; the
/// helper refuses a client with a different version rather than guessing.
pub const PROTOCOL_VERSION: u32 = 1;

/// One `hosts`-file mapping, validated before it is ever applied.
///
/// Inetpub-style attacks and cache poisoning start with a hostile hosts file,
/// so both fields are validated in [`HostsEntry::validate`] and again at the
/// helper boundary: a request that fails validation is never written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct HostsEntry {
    /// Host name to map, e.g. `myapp.test`. Single DNS label or FQDN of
    /// letters, digits and hyphens.
    pub hostname: String,
    /// IP address the host name resolves to, e.g. `127.0.0.1`.
    pub ip: String,
}

impl HostsEntry {
    /// Validates the entry's shape.
    ///
    /// Split from the helper so the desktop side can reject nonsense before a
    /// round trip, and tests can exercise the rule without a pipe.
    pub fn validate(&self) -> Result<(), devx_core::Error> {
        validate_hostname(&self.hostname)?;
        validate_ip(&self.ip)
    }
}

/// A request the desktop app can ask of the privileged helper.
///
/// Every variant is an operation that genuinely needs elevation; anything the
/// user process can do itself stays out of this enum on purpose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum PrivilegedRequest {
    /// Handshake: the client proves it speaks this protocol version.
    Hello {
        /// The protocol version the client was built against.
        version: u32,
    },
    /// Reads the current `hosts` entries that carry the DevX marker.
    ListHostsEntries,
    /// Adds (or updates) one marked `hosts` entry.
    AddHostsEntry(HostsEntry),
    /// Removes one marked `hosts` entry by host name.
    RemoveHostsEntry {
        /// Host name whose mapping should disappear.
        hostname: String,
    },
    /// Installs `cert_pem` into the machine's trusted-root store under the
    /// given friendly name. The certificate must be a self-signed CA.
    InstallCa {
        /// The CA certificate in PEM form, exactly as DevX rendered it.
        cert_pem: String,
        /// Name shown in `certmgr.msc` and the Windows certificate UI.
        friendly_name: String,
    },
    /// Reports whether a root CA with `friendly_name` is trusted.
    CheckCa {
        /// Friendly name to look up, e.g. `DevX Local CA`.
        friendly_name: String,
    },
    /// Removes the trusted root CA with `friendly_name`, if present.
    RemoveCa {
        /// Friendly name to look up, e.g. `DevX Local CA`.
        friendly_name: String,
    },
    /// Points the `.test` suffix at the DevX resolver via an NRPT rule,
    /// routed to the resolver listening on `port`.
    SetNrptRule {
        /// The DNS namespace the rule covers, e.g. `.test`.
        namespace: String,
        /// Port the DevX resolver listens on, on loopback.
        port: u16,
    },
    /// Removes the NRPT rule covering `namespace`, if present.
    RemoveNrptRule {
        /// The DNS namespace the rule covered, e.g. `.test`.
        namespace: String,
    },
}

/// The helper's reply to one [`PrivilegedRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum PrivilegedResponse {
    /// Handshake accepted.
    Hello {
        /// The protocol version the helper speaks.
        version: u32,
    },
    /// The current marked `hosts` entries.
    HostsEntries(Vec<HostsEntry>),
    /// The mutation was applied and the hosts file flushed.
    Applied,
    /// The answer to [`PrivilegedRequest::CheckCa`]: whether the named CA is
    /// already trusted by the machine.
    CaInstalled {
        /// `true` when a root certificate with the requested name exists.
        installed: bool,
    },
    /// The request was understood but refused (validation, version mismatch).
    Rejected {
        /// Why it was refused, for the UI.
        reason: String,
    },
}

/// Validates a host name for the hosts file.
///
/// Accepts a single label or dot-separated FQDN of letters, digits and
/// hyphens (no leading or trailing hyphen, no empty label, 253 bytes max).
/// Everything else — wildcards, underscores, whitespace, control characters,
/// trailing dots — is refused, because the helper writes this value verbatim
/// into a file the whole OS parses.
pub fn validate_hostname(hostname: &str) -> Result<(), devx_core::Error> {
    const MAX_NAME_BYTES: usize = 253;

    if hostname.is_empty() {
        return Err(devx_core::Error::invalid_input(
            "hostname must not be empty",
        ));
    }

    if hostname.len() > MAX_NAME_BYTES {
        return Err(devx_core::Error::invalid_input(format!(
            "hostname must be at most {MAX_NAME_BYTES} bytes"
        )));
    }

    if hostname.ends_with('.') {
        return Err(devx_core::Error::invalid_input(
            "hostname must not end with a dot",
        ));
    }

    let valid_label = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };

    if !hostname.split('.').all(valid_label) {
        return Err(devx_core::Error::invalid_input(format!(
            "`{hostname}` is not a valid host name"
        ))
        .with_hint("use letters, digits and hyphens, e.g. `myapp.test`"));
    }

    Ok(())
}

/// Validates an IPv4 address for the hosts file.
///
/// IPv6 is deliberately out for now: hosts-file IPv6 needs `::1` style
/// entries and DevX binds loopback IPv4 everywhere (Task 10 will revisit).
pub fn validate_ip(ip: &str) -> Result<(), devx_core::Error> {
    let octets: Option<Vec<u8>> = ip.split('.').map(|part| part.parse::<u8>().ok()).collect();

    match octets {
        Some(octets) if octets.len() == 4 => Ok(()),
        _ => Err(
            devx_core::Error::invalid_input(format!("`{ip}` is not a valid IPv4 address"))
                .with_hint("DevX maps local sites to 127.0.0.1"),
        ),
    }
}

/// Validates an NRPT namespace.
///
/// Only single-suffix form is accepted (`.test`, stored without the leading
/// dot), because that is all DevX ever needs and it keeps the registry
/// values boring. A hostile namespace could redirect arbitrary traffic, so
/// the shape is fixed here and re-checked by the helper.
pub fn validate_namespace(namespace: &str) -> Result<(), devx_core::Error> {
    let name = namespace.strip_prefix('.').unwrap_or(namespace);
    // One label only: DevX routes one suffix, and a single-label rule keeps
    // the NRPT entry (and this validation) unambiguous.
    if name.contains('.') {
        return Err(devx_core::Error::invalid_input(format!(
            "`{namespace}` must be a single suffix such as `test`"
        )));
    }
    validate_hostname(name)?;
    Ok(())
}

/// Validates a root-CA friendly name.
///
/// The name ends up in the machine-wide certificate store, so it is confined
/// to short printable text with no control characters or path separators —
/// enough for `DevX Local CA`, hostile to surprises.
pub fn validate_ca_name(name: &str) -> Result<(), devx_core::Error> {
    const MAX_NAME_BYTES: usize = 128;

    if name.is_empty() {
        return Err(devx_core::Error::invalid_input("CA name must not be empty"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(devx_core::Error::invalid_input(format!(
            "CA name must be at most {MAX_NAME_BYTES} bytes"
        )));
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '|' | '"'))
    {
        return Err(devx_core::Error::invalid_input(format!(
            "`{name}` is not a usable CA name"
        )));
    }
    Ok(())
}

/// Validates that `pem` is exactly one PEM block of kind `label`.
///
/// The helper imports whatever it receives into the machine root store, so
/// the desktop side validates first (fail fast) and the helper validates
/// again (never trust the pipe). Only one certificate per request is accepted:
/// a bundle would smuggle in more trust than the UI showed the user.
pub fn validate_pem_block(pem: &str, label: &str) -> Result<(), devx_core::Error> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");

    let begins = pem.matches(&begin).count();
    let ends = pem.matches(&end).count();
    if begins != 1 || ends != 1 {
        return Err(devx_core::Error::invalid_input(format!(
            "expected exactly one {label} PEM block"
        )));
    }

    // The body between the markers must be non-empty base64-ish text.
    let body = pem
        .split(&begin)
        .nth(1)
        .and_then(|rest| rest.split(&end).next())
        .unwrap_or("");
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    if body.is_empty()
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return Err(devx_core::Error::invalid_input(format!(
            "the {label} PEM body is not valid certificate text"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn well_formed_entries_validate() {
        let entry = HostsEntry {
            hostname: "myapp.test".to_owned(),
            ip: "127.0.0.1".to_owned(),
        };
        assert!(entry.validate().is_ok());
    }

    #[test]
    fn hostnames_accept_labels_and_fqdns_but_nothing_hostile() {
        for good in ["localhost", "myapp", "my-app.test", "a.b.c", "api1.dev2"] {
            validate_hostname(good).unwrap_or_else(|err| panic!("{good} rejected: {err}"));
        }

        for bad in [
            "",
            ".test",
            "my app.test",
            "my_app.test",
            "*.test",
            "-leading.test",
            "trailing-.test",
            "double..dot",
            "trailing.",
            "café.test",
            "semi;colon",
        ] {
            assert!(
                validate_hostname(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }

        // 64-character label exceeds the DNS limit.
        let long = "a".repeat(64);
        assert!(validate_hostname(&long).is_err());
        assert!(validate_hostname(&"a".repeat(63)).is_ok());
    }

    #[test]
    fn ips_must_be_complete_ipv4() {
        for good in ["127.0.0.1", "10.0.0.255", "0.0.0.0"] {
            validate_ip(good).unwrap_or_else(|err| panic!("{good} rejected: {err}"));
        }

        for bad in [
            "",
            "127.0.0",
            "127.0.0.256",
            "1.2.3.4.5",
            "localhost",
            "::1",
        ] {
            assert!(validate_ip(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn namespaces_are_single_suffixes() {
        assert!(validate_namespace("test").is_ok());
        assert!(validate_namespace(".test").is_ok(), "leading dot stripped");
        assert!(validate_namespace("").is_err());
        assert!(validate_namespace(".two.labels").is_err());
        assert!(validate_namespace("*.wild").is_err());
    }

    #[test]
    fn ca_names_are_printable_and_bounded() {
        assert!(validate_ca_name("DevX Local CA").is_ok());
        assert!(validate_ca_name("").is_err());
        assert!(validate_ca_name("bad\\name").is_err());
        assert!(validate_ca_name("bad/name").is_err());
        assert!(validate_ca_name("line\nbreak").is_err());
        assert!(validate_ca_name(&"x".repeat(129)).is_err());
    }

    #[test]
    fn pem_validation_accepts_one_certificate_and_nothing_else() {
        let cert = "-----BEGIN CERTIFICATE-----\nabc+/=\n-----END CERTIFICATE-----\n";
        assert!(validate_pem_block(cert, "CERTIFICATE").is_ok());

        // Empty body.
        assert!(validate_pem_block(
            "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
            "CERTIFICATE"
        )
        .is_err());
        // Two bundles in one request.
        assert!(validate_pem_block(&format!("{cert}{cert}"), "CERTIFICATE").is_err());
        // Wrong label.
        assert!(validate_pem_block(cert, "PRIVATE KEY").is_err());
        // No markers at all.
        assert!(validate_pem_block("hello", "CERTIFICATE").is_err());
        // Body with hostile characters.
        assert!(validate_pem_block(
            "-----BEGIN CERTIFICATE-----\nnot base64!!\n-----END CERTIFICATE-----\n",
            "CERTIFICATE"
        )
        .is_err());
    }

    #[test]
    fn requests_and_responses_round_trip_through_json() {
        let request = PrivilegedRequest::AddHostsEntry(HostsEntry {
            hostname: "myapp.test".to_owned(),
            ip: "127.0.0.1".to_owned(),
        });
        let json = serde_json::to_string(&request).expect("serialize");
        let back: PrivilegedRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, request);

        let response = PrivilegedResponse::HostsEntries(vec![HostsEntry {
            hostname: "b.test".to_owned(),
            ip: "127.0.0.2".to_owned(),
        }]);
        let json = serde_json::to_string(&response).expect("serialize");
        let back: PrivilegedResponse = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, response);
    }

    #[test]
    fn unknown_request_kinds_are_rejected_not_ignored() {
        let json = r#"{"kind":"reformat_disk","payload":true}"#;
        let parsed: Result<PrivilegedRequest, _> = serde_json::from_str(json);
        assert!(parsed.is_err(), "an unknown variant must not parse");
    }
}
