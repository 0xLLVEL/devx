//! The privileged helper service: pipe server and request dispatcher.
//!
//! The helper is a small, boring program that runs elevated and does exactly
//! what [`PrivilegedRequest`] says — no more. Its safety rests on three legs:
//!
//! 1. **A minimal operation set.** Hosts-file entries with the DevX marker;
//!    everything else is a `Rejected` answer, never a guess.
//! 2. **Validation at the boundary.** Every request is validated again here
//!    even though the client validated it too.
//! 3. **An allow-listed pipe.** The pipe is created with the DACL from
//!    `devx_privileged::descriptor`, so only the interactive user and
//!    administrators can even open it.

use std::path::PathBuf;

use devx_core::Result;
use devx_ipc::{HostsEntry, PrivilegedRequest, PrivilegedResponse, PROTOCOL_VERSION};

use crate::nrpt::NrptBackend;

pub mod cert_store;
pub mod hosts;
pub mod nrpt;
pub mod server;

/// Operations the running helper performs against the real machine.
///
/// Split from the dispatcher so tests can run every protocol rule against a
/// temporary file instead of the real hosts file.
pub trait HostsBackend {
    /// Lists the DevX-managed entries.
    fn list(&self) -> Result<Vec<HostsEntry>>;

    /// Adds or updates one managed entry.
    fn add(&self, entry: &HostsEntry) -> Result<()>;

    /// Removes the managed entry for `hostname`.
    fn remove(&self, hostname: &str) -> Result<()>;
}

/// Backend editing the hosts file at `path`.
#[derive(Debug, Clone)]
pub struct FileHostsBackend {
    path: PathBuf,
}

impl FileHostsBackend {
    /// A backend for the default hosts location.
    pub fn system() -> Self {
        Self {
            path: hosts::default_hosts_path(),
        }
    }

    /// A backend for an explicit path; the seam tests use.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl HostsBackend for FileHostsBackend {
    fn list(&self) -> Result<Vec<HostsEntry>> {
        hosts::list_entries(&self.path)
    }

    fn add(&self, entry: &HostsEntry) -> Result<()> {
        hosts::add_entry(&self.path, entry)
    }

    fn remove(&self, hostname: &str) -> Result<()> {
        hosts::remove_entry(&self.path, hostname)
    }
}

/// Certificate-store operations the helper performs against the real
/// machine.
///
/// Mirrors [`HostsBackend`]: a narrow trait so the dispatcher can be tested
/// with a fake while the Windows implementation lives in [`cert_store`].
pub trait CaBackend {
    /// Whether a root CA named `friendly_name` is trusted.
    fn has(&self, friendly_name: &str) -> Result<bool>;

    /// Imports `cert_der` as a root CA named `friendly_name`.
    fn install(&self, cert_der: &[u8], friendly_name: &str) -> Result<()>;

    /// Removes the root CA named `friendly_name`; `Ok(false)` when absent.
    fn remove(&self, friendly_name: &str) -> Result<bool>;
}

/// Backend operating on the real machine Root store.
#[derive(Debug, Clone, Default)]
pub struct WindowsCaBackend;

impl CaBackend for WindowsCaBackend {
    fn has(&self, friendly_name: &str) -> Result<bool> {
        cert_store::ca_is_installed(friendly_name)
    }

    fn install(&self, cert_der: &[u8], friendly_name: &str) -> Result<()> {
        cert_store::ca_install(cert_der, friendly_name)
    }

    fn remove(&self, friendly_name: &str) -> Result<bool> {
        cert_store::ca_remove(friendly_name)
    }
}

/// The full set of privileged backends a helper session serves.
///
/// Grouped in one struct so the pipe server needs exactly one argument and
/// new operation families extend it without touching the call sites.
pub struct Backends {
    /// Hosts-file operations.
    pub hosts: Box<dyn HostsBackend + Send + Sync>,
    /// Certificate-store operations.
    pub ca: Box<dyn CaBackend + Send + Sync>,
    /// NRPT rule operations.
    pub nrpt: Box<dyn NrptBackend + Send + Sync>,
}

impl Backends {
    /// Backends against the real machine.
    pub fn system() -> Self {
        Self {
            hosts: Box::new(FileHostsBackend::system()),
            ca: Box::new(WindowsCaBackend),
            nrpt: Box::new(nrpt::WindowsNrptBackend),
        }
    }

    /// The dispatcher's answer to a [`PrivilegedRequest::InstallCa`].
    fn handle_install_ca(&self, cert_pem: &str, friendly_name: &str) -> PrivilegedResponse {
        if let Err(err) = devx_ipc::validate_ca_name(friendly_name) {
            return rejected(err);
        }
        if let Err(err) = devx_ipc::validate_pem_block(cert_pem, "CERTIFICATE") {
            return rejected(err);
        }

        let der = match cert_store::pem_to_der(cert_pem, "CERTIFICATE") {
            Ok(der) => der,
            Err(err) => return rejected(err),
        };

        match self.ca.install(&der, friendly_name) {
            Ok(()) => PrivilegedResponse::Applied,
            Err(err) => rejected(err),
        }
    }
}

/// Wraps an error into a protocol rejection.
fn rejected(err: devx_core::Error) -> PrivilegedResponse {
    PrivilegedResponse::Rejected {
        reason: err.to_string(),
    }
}

/// Whether `namespace` (with or without the leading dot) is DevX's suffix.
fn is_devx_suffix(namespace: &str) -> bool {
    let with_dot = format!(".{namespace}");
    nrpt::RULE_NAMESPACE.eq_ignore_ascii_case(namespace)
        || nrpt::RULE_NAMESPACE.eq_ignore_ascii_case(&with_dot)
}

/// Answers one request against `backends`.
///
/// Pure dispatch: no I/O of its own beyond what the backends do, so the
/// protocol rules are testable end to end with temp files and fakes.
pub fn handle(backends: &Backends, request: &PrivilegedRequest) -> PrivilegedResponse {
    let Backends { hosts, ca, nrpt } = backends;
    match request {
        PrivilegedRequest::Hello { version } => {
            if *version == PROTOCOL_VERSION {
                PrivilegedResponse::Hello {
                    version: PROTOCOL_VERSION,
                }
            } else {
                PrivilegedResponse::Rejected {
                    reason: format!(
                        "client speaks protocol {version}, helper speaks {PROTOCOL_VERSION}"
                    ),
                }
            }
        }
        PrivilegedRequest::ListHostsEntries => match hosts.list() {
            Ok(entries) => PrivilegedResponse::HostsEntries(entries),
            Err(err) => rejected(err),
        },
        PrivilegedRequest::AddHostsEntry(entry) => {
            // Validate again at the boundary even though `hosts::add_entry`
            // re-checks: a reject here is cheap and keeps the protocol honest.
            if let Err(err) = entry.validate() {
                return PrivilegedResponse::Rejected {
                    reason: err.to_string(),
                };
            }
            match hosts.add(entry) {
                Ok(()) => PrivilegedResponse::Applied,
                Err(err) => rejected(err),
            }
        }
        PrivilegedRequest::RemoveHostsEntry { hostname } => match hosts.remove(hostname) {
            Ok(()) => PrivilegedResponse::Applied,
            Err(err) => rejected(err),
        },
        PrivilegedRequest::InstallCa {
            cert_pem,
            friendly_name,
        } => backends.handle_install_ca(cert_pem, friendly_name),
        PrivilegedRequest::CheckCa { friendly_name } => {
            if let Err(err) = devx_ipc::validate_ca_name(friendly_name) {
                return rejected(err);
            }
            match ca.has(friendly_name) {
                Ok(installed) => PrivilegedResponse::CaInstalled { installed },
                Err(err) => rejected(err),
            }
        }
        PrivilegedRequest::RemoveCa { friendly_name } => {
            if let Err(err) = devx_ipc::validate_ca_name(friendly_name) {
                return rejected(err);
            }
            match ca.remove(friendly_name) {
                Ok(_) => PrivilegedResponse::Applied,
                Err(err) => rejected(err),
            }
        }
        PrivilegedRequest::SetNrptRule { namespace, port } => {
            if let Err(err) = devx_ipc::validate_namespace(namespace) {
                return rejected(err);
            }
            // The helper only ever manages its own documented suffix; a
            // client asking for anything else is refused outright.
            if !is_devx_suffix(namespace) {
                return PrivilegedResponse::Rejected {
                    reason: format!("DevX only manages the `{}` suffix", nrpt::RULE_NAMESPACE),
                };
            }
            if *port == 0 {
                return rejected(devx_core::Error::invalid_input(
                    "resolver port must not be 0",
                ));
            }
            match nrpt.set_rule(*port) {
                Ok(()) => PrivilegedResponse::Applied,
                Err(err) => rejected(err),
            }
        }
        PrivilegedRequest::RemoveNrptRule { namespace } => {
            if let Err(err) = devx_ipc::validate_namespace(namespace) {
                return rejected(err);
            }
            if !is_devx_suffix(namespace) {
                return PrivilegedResponse::Rejected {
                    reason: format!("DevX only manages the `{}` suffix", nrpt::RULE_NAMESPACE),
                };
            }
            match nrpt.remove_rule() {
                Ok(_) => PrivilegedResponse::Applied,
                Err(err) => rejected(err),
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    /// In-memory hosts backend (the seam the old TempBackend used).
    struct TempHosts {
        path: PathBuf,
    }

    impl TempHosts {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp");
            let path = dir.path().join("hosts");
            std::fs::write(&path, "127.0.0.1 localhost\n").expect("seed");
            // Leak the temp dir for the lifetime of the test process: simple
            // and correct for the handful of tests that use it.
            let path = path.into_os_string().into_string().expect("utf8");
            std::mem::forget(dir);
            Self {
                path: PathBuf::from(path),
            }
        }
    }

    impl HostsBackend for TempHosts {
        fn list(&self) -> Result<Vec<HostsEntry>> {
            hosts::list_entries(&self.path)
        }

        fn add(&self, entry: &HostsEntry) -> Result<()> {
            hosts::add_entry(&self.path, entry)
        }

        fn remove(&self, hostname: &str) -> Result<()> {
            hosts::remove_entry(&self.path, hostname)
        }
    }

    /// In-memory CA backend recording what the dispatcher asked for.
    struct FakeCa {
        installed: std::sync::Mutex<Vec<String>>,
        fail: bool,
    }

    impl FakeCa {
        fn new() -> Self {
            Self {
                installed: std::sync::Mutex::new(Vec::new()),
                fail: false,
            }
        }

        fn failing() -> Self {
            Self {
                installed: std::sync::Mutex::new(Vec::new()),
                fail: true,
            }
        }
    }

    impl CaBackend for FakeCa {
        fn has(&self, friendly_name: &str) -> Result<bool> {
            if self.fail {
                return Err(devx_core::Error::privileged("store unavailable"));
            }
            Ok(self
                .installed
                .lock()
                .expect("lock")
                .iter()
                .any(|n| n == friendly_name))
        }

        fn install(&self, _cert_der: &[u8], friendly_name: &str) -> Result<()> {
            if self.fail {
                return Err(devx_core::Error::privileged("store unavailable"));
            }
            self.installed
                .lock()
                .expect("lock")
                .push(friendly_name.to_owned());
            Ok(())
        }

        fn remove(&self, friendly_name: &str) -> Result<bool> {
            if self.fail {
                return Err(devx_core::Error::privileged("store unavailable"));
            }
            let mut guard = self.installed.lock().expect("lock");
            let before = guard.len();
            guard.retain(|n| n != friendly_name);
            Ok(guard.len() != before)
        }
    }

    /// In-memory NRPT backend recording the configured port.
    struct FakeNrpt {
        port: std::sync::Mutex<Option<u16>>,
    }

    impl FakeNrpt {
        fn new() -> Self {
            Self {
                port: std::sync::Mutex::new(None),
            }
        }
    }

    impl NrptBackend for FakeNrpt {
        fn has_rule(&self) -> Result<bool> {
            Ok(self.port.lock().expect("lock").is_some())
        }

        fn set_rule(&self, port: u16) -> Result<()> {
            *self.port.lock().expect("lock") = Some(port);
            Ok(())
        }

        fn remove_rule(&self) -> Result<bool> {
            Ok(self.port.lock().expect("lock").take().is_some())
        }
    }

    fn backends(hosts: TempHosts, ca: FakeCa) -> Backends {
        Backends {
            hosts: Box::new(hosts),
            ca: Box::new(ca),
            nrpt: Box::new(FakeNrpt::new()),
        }
    }

    const CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n";

    #[test]
    fn hello_accepts_the_current_protocol_version() {
        let b = backends(TempHosts::new(), FakeCa::new());
        let response = handle(
            &b,
            &PrivilegedRequest::Hello {
                version: PROTOCOL_VERSION,
            },
        );
        assert_eq!(
            response,
            PrivilegedResponse::Hello {
                version: PROTOCOL_VERSION
            }
        );
    }

    #[test]
    fn hello_rejects_a_foreign_protocol_version() {
        let b = backends(TempHosts::new(), FakeCa::new());
        let response = handle(&b, &PrivilegedRequest::Hello { version: 999 });
        assert_eq!(
            response,
            PrivilegedResponse::Rejected {
                reason: "client speaks protocol 999, helper speaks 1".to_owned()
            }
        );
    }

    #[test]
    fn add_list_remove_round_trips_through_the_dispatcher() {
        let b = backends(TempHosts::new(), FakeCa::new());

        let response = handle(
            &b,
            &PrivilegedRequest::AddHostsEntry(HostsEntry {
                hostname: "app.test".into(),
                ip: "127.0.0.1".into(),
            }),
        );
        assert_eq!(response, PrivilegedResponse::Applied);

        let response = handle(&b, &PrivilegedRequest::ListHostsEntries);
        assert_eq!(
            response,
            PrivilegedResponse::HostsEntries(vec![HostsEntry {
                hostname: "app.test".into(),
                ip: "127.0.0.1".into(),
            }])
        );

        let response = handle(
            &b,
            &PrivilegedRequest::RemoveHostsEntry {
                hostname: "app.test".into(),
            },
        );
        assert_eq!(response, PrivilegedResponse::Applied);

        let response = handle(&b, &PrivilegedRequest::ListHostsEntries);
        assert_eq!(response, PrivilegedResponse::HostsEntries(Vec::new()));
    }

    #[test]
    fn hostile_entries_are_rejected_not_applied() {
        let b = backends(TempHosts::new(), FakeCa::new());

        let response = handle(
            &b,
            &PrivilegedRequest::AddHostsEntry(HostsEntry {
                hostname: "*.evil".into(),
                ip: "127.0.0.1".into(),
            }),
        );
        assert!(
            matches!(response, PrivilegedResponse::Rejected { .. }),
            "{response:?}"
        );

        // And nothing landed in the file.
        let response = handle(&b, &PrivilegedRequest::ListHostsEntries);
        assert_eq!(response, PrivilegedResponse::HostsEntries(Vec::new()));
    }

    #[test]
    fn io_failures_come_back_as_rejections_not_panics() {
        // A path that cannot exist as a file.
        let b = Backends {
            hosts: Box::new(FileHostsBackend::at(std::path::Path::new(
                "Q:\\no\\such\\hosts",
            ))),
            ca: Box::new(FakeCa::new()),
            nrpt: Box::new(FakeNrpt::new()),
        };
        let response = handle(&b, &PrivilegedRequest::ListHostsEntries);
        assert!(
            matches!(response, PrivilegedResponse::Rejected { .. }),
            "{response:?}"
        );
    }

    #[test]
    fn ca_install_check_remove_round_trips() {
        let b = backends(TempHosts::new(), FakeCa::new());

        let response = handle(
            &b,
            &PrivilegedRequest::CheckCa {
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert_eq!(
            response,
            PrivilegedResponse::CaInstalled { installed: false }
        );

        let response = handle(
            &b,
            &PrivilegedRequest::InstallCa {
                cert_pem: CERT_PEM.into(),
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert_eq!(response, PrivilegedResponse::Applied);

        let response = handle(
            &b,
            &PrivilegedRequest::CheckCa {
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert_eq!(
            response,
            PrivilegedResponse::CaInstalled { installed: true }
        );

        let response = handle(
            &b,
            &PrivilegedRequest::RemoveCa {
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert_eq!(response, PrivilegedResponse::Applied);
    }

    #[test]
    fn hostile_ca_requests_never_reach_the_store() {
        let b = backends(TempHosts::new(), FakeCa::new());

        // Bad name.
        let response = handle(
            &b,
            &PrivilegedRequest::InstallCa {
                cert_pem: CERT_PEM.into(),
                friendly_name: "bad\\name".into(),
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));

        // Not a certificate PEM.
        let response = handle(
            &b,
            &PrivilegedRequest::InstallCa {
                cert_pem: "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----".into(),
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));

        // Two certificates in one request: more trust than asked for.
        let response = handle(
            &b,
            &PrivilegedRequest::InstallCa {
                cert_pem: format!("{CERT_PEM}{CERT_PEM}"),
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));

        // A bad name on Check too.
        let response = handle(
            &b,
            &PrivilegedRequest::CheckCa {
                friendly_name: String::new(),
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));
    }

    #[test]
    fn nrpt_rules_set_and_remove_through_the_dispatcher() {
        let b = backends(TempHosts::new(), FakeCa::new());

        let response = handle(
            &b,
            &PrivilegedRequest::SetNrptRule {
                namespace: "test".into(),
                port: 9353,
            },
        );
        assert_eq!(response, PrivilegedResponse::Applied);

        let response = handle(
            &b,
            &PrivilegedRequest::RemoveNrptRule {
                namespace: ".test".into(),
            },
        );
        assert_eq!(response, PrivilegedResponse::Applied);
    }

    #[test]
    fn nrpt_requests_are_confined_to_the_devx_suffix() {
        let b = backends(TempHosts::new(), FakeCa::new());

        // A different suffix would redirect arbitrary traffic.
        let response = handle(
            &b,
            &PrivilegedRequest::SetNrptRule {
                namespace: "com".into(),
                port: 9353,
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));

        // Port zero would point the suffix at nothing.
        let response = handle(
            &b,
            &PrivilegedRequest::SetNrptRule {
                namespace: "test".into(),
                port: 0,
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));
    }

    #[test]
    fn backend_failures_surface_as_rejections() {
        let b = backends(TempHosts::new(), FakeCa::failing());
        let response = handle(
            &b,
            &PrivilegedRequest::CheckCa {
                friendly_name: "DevX Local CA".into(),
            },
        );
        assert!(matches!(response, PrivilegedResponse::Rejected { .. }));
    }
}
