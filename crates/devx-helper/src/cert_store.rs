//! Windows certificate-store operations for the DevX local CA.
//!
//! Only the machine **Root** store is touched, only with the friendly name
//! DevX uses, and only through the three operations the protocol exposes:
//! check, install (replace), remove. Anything else a service running as
//! LocalSystem could do to the store stays out of reach by construction.
//!
//! The store is opened `CERT_SYSTEM_STORE_LOCAL_MACHINE` because browser
//! certificate trust for every user of the machine — not just the account
//! that happened to click the button — is what makes `https://app.test`
//! work.

use devx_core::{Error, Result};

/// Friendly name DevX registers its CA under; mirrors `devx_provision::pki`.
pub const CA_FRIENDLY_NAME: &str = "DevX Local CA";

/// Decodes the first DER body out of a PEM `-----BEGIN label-----` block.
///
/// Pure text wrangling so tests can exercise it without a certificate at
/// hand; callers validate the outer shape with
/// [`devx_ipc::validate_pem_block`] first.
pub fn pem_to_der(pem: &str, label: &str) -> Result<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");

    let body = pem
        .split(&begin)
        .nth(1)
        .and_then(|rest| rest.split(&end).next())
        .ok_or_else(|| Error::invalid_input(format!("no {label} PEM block found")))?;

    let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|err| Error::invalid_input(format!("the PEM body is not valid base64: {err}")))
}

/// Encodes `text` as NUL-terminated UTF-16, the shape the crypto APIs want.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
mod imp {
    use super::*;

    use windows::Win32::Foundation::CRYPT_E_NOT_FOUND;
    use windows::Win32::Security::Cryptography::{
        sz_CERT_STORE_PROV_SYSTEM_W, CertAddCertificateContextToStore, CertCloseStore,
        CertCreateCertificateContext, CertDeleteCertificateFromStore, CertEnumCertificatesInStore,
        CertFreeCertificateContext, CertGetCertificateContextProperty, CertOpenStore,
        CertSetCertificateContextProperty, CERT_CONTEXT, CERT_FRIENDLY_NAME_PROP_ID,
        CERT_OPEN_STORE_FLAGS, CERT_QUERY_ENCODING_TYPE, CERT_STORE_ADD_REPLACE_EXISTING,
        CERT_STORE_MAXIMUM_ALLOWED_FLAG, CERT_SYSTEM_STORE_LOCAL_MACHINE, CRYPT_INTEGER_BLOB,
        HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    };

    /// Opens the machine Root store with read/write access.
    fn open_root_store() -> Result<HCERTSTORE> {
        let name = wide("ROOT");
        // Read/write plus CERT_SYSTEM_STORE_LOCAL_MACHINE: the store every
        // user of the machine trusts, which is what browser HTTPS needs.
        let flags = CERT_STORE_MAXIMUM_ALLOWED_FLAG.0 | CERT_SYSTEM_STORE_LOCAL_MACHINE;
        // SAFETY: `name` stays alive for the call; the returned store is
        // closed on every exit path of the callers.
        unsafe {
            CertOpenStore(
                sz_CERT_STORE_PROV_SYSTEM_W,
                CERT_QUERY_ENCODING_TYPE(X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0),
                None,
                CERT_OPEN_STORE_FLAGS(flags),
                Some(name.as_ptr().cast()),
            )
        }
        .map_err(|err| Error::privileged(format!("cannot open the machine Root store: {err}")))
    }

    /// Copies the friendly-name property off a certificate context.
    fn friendly_name_of(context: *const CERT_CONTEXT) -> Option<String> {
        let mut size = 0u32;
        // SAFETY: `context` is a live context returned by the store APIs and
        // freed by the caller.
        let ok = unsafe {
            CertGetCertificateContextProperty(context, CERT_FRIENDLY_NAME_PROP_ID, None, &mut size)
        };
        if !ok.is_ok() || size == 0 {
            return None;
        }

        let mut buffer = vec![0u8; size as usize];
        // SAFETY: `buffer` is sized to what the query above reported.
        let ok = unsafe {
            CertGetCertificateContextProperty(
                context,
                CERT_FRIENDLY_NAME_PROP_ID,
                Some(buffer.as_mut_ptr().cast()),
                &mut size,
            )
        };
        if !ok.is_ok() {
            return None;
        }

        let utf16: Vec<u16> = buffer[..size as usize]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&unit| unit != 0)
            .collect();
        String::from_utf16(&utf16).ok()
    }

    /// Iterates every certificate in the store, yielding friendly names.
    fn each_friendly_name(store: HCERTSTORE) -> Vec<String> {
        let mut names = Vec::new();
        // SAFETY: enumeration in a loop; each returned context is freed
        // before the next call, as the API requires.
        let mut context: *const CERT_CONTEXT = std::ptr::null();
        loop {
            context = unsafe { CertEnumCertificatesInStore(store, Some(context)) };
            if context.is_null() {
                break;
            }
            if let Some(name) = friendly_name_of(context) {
                names.push(name);
            }
        }
        names
    }

    pub fn has_root_ca(friendly_name: &str) -> Result<bool> {
        let store = open_root_store()?;
        let found = each_friendly_name(store)
            .into_iter()
            .any(|name| name == friendly_name);
        let _ = unsafe { CertCloseStore(Some(store), 0) };
        Ok(found)
    }

    pub fn install_root_ca(cert_der: &[u8], friendly_name: &str) -> Result<()> {
        let store = open_root_store()?;

        // SAFETY: `cert_der` is only read by the call; a null return means
        // the bytes were not a certificate and are reported as invalid input.
        let context = unsafe {
            CertCreateCertificateContext(
                CERT_QUERY_ENCODING_TYPE(X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0),
                cert_der,
            )
        };
        if context.is_null() {
            let _ = unsafe { CertCloseStore(Some(store), 0) };
            return Err(Error::invalid_input(
                "the certificate payload is not a valid X.509 certificate",
            ));
        }

        // Name the certificate before it lands so the store entry is
        // immediately recognisable in certmgr.msc.
        let name = wide(friendly_name);
        let blob = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(name.len() * 2).unwrap_or(0),
            pbData: name.as_ptr().cast_mut().cast(),
        };
        // SAFETY: `context` is live and owned here; `blob` borrows `name`
        // which outlives the call.
        if let Err(err) = unsafe {
            CertSetCertificateContextProperty(
                context,
                CERT_FRIENDLY_NAME_PROP_ID,
                0,
                Some(&blob as *const CRYPT_INTEGER_BLOB as *const core::ffi::c_void),
            )
        } {
            unsafe {
                let _ = CertFreeCertificateContext(Some(context));
                let _ = CertCloseStore(Some(store), 0);
            }
            return Err(Error::privileged(format!(
                "cannot name the DevX CA certificate: {err}"
            )));
        }

        let added = unsafe {
            CertAddCertificateContextToStore(
                Some(store),
                context,
                CERT_STORE_ADD_REPLACE_EXISTING,
                None,
            )
        };
        let _ = unsafe { CertFreeCertificateContext(Some(context)) };
        let _ = unsafe { CertCloseStore(Some(store), 0) };

        added.map_err(|err| {
            Error::privileged(format!("cannot add the DevX CA to the Root store: {err}"))
        })
    }

    pub fn remove_root_ca(friendly_name: &str) -> Result<bool> {
        let store = open_root_store()?;

        // SAFETY: enumeration in a loop; the found context is deleted (which
        // also frees it) and every non-matching one is freed explicitly.
        let mut context: *const CERT_CONTEXT = std::ptr::null();
        let mut removed = false;
        loop {
            context = unsafe { CertEnumCertificatesInStore(store, Some(context)) };
            if context.is_null() {
                break;
            }
            if friendly_name_of(context).as_deref() != Some(friendly_name) {
                continue;
            }

            match unsafe { CertDeleteCertificateFromStore(context) } {
                Ok(()) => removed = true,
                Err(err) if err.code() == CRYPT_E_NOT_FOUND => {} // already gone
                Err(err) => {
                    let _ = unsafe { CertCloseStore(Some(store), 0) };
                    return Err(Error::privileged(format!(
                        "cannot remove the DevX CA: {err}"
                    )));
                }
            }
            break; // The context is gone; do not continue enumerating it.
        }

        let _ = unsafe { CertCloseStore(Some(store), 0) };
        Ok(removed)
    }
}

/// Reports whether the DevX CA is trusted by the machine.
pub fn ca_is_installed(friendly_name: &str) -> Result<bool> {
    #[cfg(windows)]
    return imp::has_root_ca(friendly_name);
    #[cfg(not(windows))]
    {
        let _ = friendly_name;
        Err(Error::privileged("certificate stores require Windows"))
    }
}

/// Imports `cert_der` into the machine Root store under `friendly_name`.
pub fn ca_install(cert_der: &[u8], friendly_name: &str) -> Result<()> {
    #[cfg(windows)]
    return imp::install_root_ca(cert_der, friendly_name);
    #[cfg(not(windows))]
    {
        let _ = (cert_der, friendly_name);
        Err(Error::privileged("certificate stores require Windows"))
    }
}

/// Removes the DevX CA from the machine Root store; `Ok(false)` when absent.
pub fn ca_remove(friendly_name: &str) -> Result<bool> {
    #[cfg(windows)]
    return imp::remove_root_ca(friendly_name);
    #[cfg(not(windows))]
    {
        let _ = friendly_name;
        Err(Error::privileged("certificate stores require Windows"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devx_core::ErrorCode;
    use pretty_assertions::assert_eq;

    const CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n";

    #[test]
    fn pem_bodies_decode_to_der() {
        assert_eq!(pem_to_der(CERT_PEM, "CERTIFICATE").expect("der"), b"abc");
    }

    #[test]
    fn malformed_pem_bodies_are_invalid_input() {
        assert_eq!(pem_to_der(CERT_PEM, "CERTIFICATE").expect("der").len(), 3);
        let err = pem_to_der(
            "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----",
            "CERTIFICATE",
        )
        .expect_err("not base64");
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(pem_to_der("nothing here", "CERTIFICATE").is_err());
    }
}
