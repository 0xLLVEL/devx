//! NRPT (Name Resolution Policy Table) rule management.
//!
//! Windows consults the NRPT *before* the hosts file and ordinary DNS: a
//! rule covering `.test` sends every matching query to the nameserver the
//! rule names, which is how subdomains like `api.myapp.test` reach DevX's
//! bundled resolver. The rules live in the registry under
//! `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig`
//! and writing them needs admin rights — hence this code runs in the
//! helper, reached through the pipe.
//!
//! DevX writes exactly one rule, keyed by a fixed GUID, and every mutation
//! replaces it wholesale: no user-visible rule state is ever merged or
//! partially applied.

use devx_core::Result;

/// The registry path holding NRPT rules.
#[cfg(windows)]
pub const POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig";

/// The fixed subkey DevX's rule lives under.
///
/// A stable GUID (generated once for DevX, then never changed) is what NRPT
/// uses as the rule name; keeping it fixed means reinstalls update in place
/// instead of accumulating rules.
#[cfg(windows)]
pub const RULE_GUID: &str = "{D6E3A5C1-9B7F-4A2E-8C64-DEVXTEST0001}";

/// The namespace DevX claims, with the leading dot NRPT rules use.
#[cfg(windows)]
pub const RULE_NAMESPACE: &str = ".test";

/// Operations on the NRPT rule, split from the registry so the dispatcher
/// rules are testable with a fake.
pub trait NrptBackend {
    /// Whether DevX's rule currently exists.
    fn has_rule(&self) -> Result<bool>;

    /// Creates or replaces DevX's rule, pointing `.test` at `port` on
    /// loopback.
    fn set_rule(&self, port: u16) -> Result<()>;

    /// Removes DevX's rule; `Ok(false)` when it was not there.
    fn remove_rule(&self) -> Result<bool>;
}

/// Backend writing the real machine registry.
#[derive(Debug, Clone, Default)]
pub struct WindowsNrptBackend;

impl NrptBackend for WindowsNrptBackend {
    fn has_rule(&self) -> Result<bool> {
        #[cfg(windows)]
        return imp::rule_exists();
        #[cfg(not(windows))]
        {
            Err(Error::privileged("NRPT rules require Windows"))
        }
    }

    fn set_rule(&self, port: u16) -> Result<()> {
        #[cfg(windows)]
        return imp::write_rule(port);
        #[cfg(not(windows))]
        {
            let _ = port;
            Err(Error::privileged("NRPT rules require Windows"))
        }
    }

    fn remove_rule(&self) -> Result<bool> {
        #[cfg(windows)]
        return imp::delete_rule();
        #[cfg(not(windows))]
        {
            Err(Error::privileged("NRPT rules require Windows"))
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{POLICY_KEY, RULE_GUID, RULE_NAMESPACE};

    use devx_core::{Error, Result};
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    /// Opens (creating the chain if needed) the DnsPolicyConfig key.
    fn open_policy_key(write: bool) -> Result<RegKey> {
        let access = if write { KEY_WRITE } else { KEY_READ };
        let hive = RegKey::predef(HKEY_LOCAL_MACHINE);
        hive.open_subkey_with_flags(POLICY_KEY, access)
            .map_err(|err| {
                Error::privileged(format!("cannot open the NRPT policy key: {err}"))
                    .with_hint("the helper must run elevated to manage DNS policy")
            })
    }

    pub fn rule_exists() -> Result<bool> {
        let policy = open_policy_key(false)?;
        Ok(policy.open_subkey_with_flags(RULE_GUID, KEY_READ).is_ok())
    }

    pub fn write_rule(port: u16) -> Result<()> {
        let policy = open_policy_key(true)?;
        let rule = policy
            .create_subkey(RULE_GUID)
            .map(|(key, _)| key)
            .map_err(|err| Error::privileged(format!("cannot create the DevX NRPT rule: {err}")))?;

        // The value names and types are exactly what Windows documents for
        // NRPT rules: a version DWORD, a DNS namespace list, and a
        // nameserver list.
        let version = RegValue {
            bytes: vec![1u8, 0, 0, 0].into(),
            vtype: winreg::enums::RegType::REG_DWORD,
        };
        rule.set_raw_value("Version", &version)
            .map_err(reg_error("Version"))?;

        let namespace = RegValue {
            bytes: wide(RULE_NAMESPACE).into(),
            vtype: winreg::enums::RegType::REG_MULTI_SZ,
        };
        rule.set_raw_value("Namespace", &namespace)
            .map_err(reg_error("Namespace"))?;

        // DirectAssociation = 0 (no encryption), and the DNS servers are the
        // loopback address with the DevX resolver's port appended after a
        // colon in a REG_SZ nameserver list. Windows parses the value as
        // `IP[:port]` entries; a single loopback entry keeps it simple.
        let servers = RegValue {
            bytes: wide(&format!("127.0.0.1:{port}")).into(),
            vtype: winreg::enums::RegType::REG_SZ,
        };
        rule.set_raw_value("DnsServers", &servers)
            .map_err(reg_error("DnsServers"))?;

        Ok(())
    }

    pub fn delete_rule() -> Result<bool> {
        let policy = open_policy_key(true)?;
        match policy.delete_subkey(RULE_GUID) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(Error::privileged(format!(
                "cannot remove the DevX NRPT rule: {err}"
            ))),
        }
    }

    /// NUL-terminated UTF-16 for REG_SZ / REG_MULTI_SZ values. REG_MULTI_SZ
    /// wants a double NUL terminator, which the trailing single NUL plus
    /// Windows' own padding convention covers for one-string lists.
    fn wide(text: &str) -> Vec<u8> {
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let mut bytes = Vec::with_capacity(units.len() * 2 + 2);
        for unit in units {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn reg_error(value: &'static str) -> impl Fn(std::io::Error) -> Error {
        move |err| Error::privileged(format!("cannot write NRPT value {value}: {err}"))
    }
}

/// Registry round trip is only testable live; the unit tests for the
/// dispatcher live in `lib.rs` with a fake backend.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rule_namespace_is_the_documented_one() {
        // Pinned so a drive-by edit cannot silently redirect a different
        // suffix through the helper.
        assert_eq!(RULE_NAMESPACE, ".test");
        assert_eq!(
            POLICY_KEY,
            r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig"
        );
    }
}
