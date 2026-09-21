//! Local certificate authority and per-site TLS certificates.
//!
//! Browsers refuse `https://myapp.test` unless the certificate chain reaches
//! a root the machine trusts. DevX therefore runs its own miniature PKI:
//!
//! 1. one local **root CA** (`ca.crt` + `ca.key.pem`) generated on first use
//!    and kept under `data/certs`;
//! 2. one **server certificate per HTTPS site**, signed by that CA, covering
//!    the site's hostname;
//! 3. installation of the root into the machine trust store via the
//!    privileged helper (Task 8's pipe) — the user process can never do that
//!    itself.
//!
//! Everything here is pure crypto plus explicit file writes; the Windows
//! certificate store lives in `devx-helper`.

use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};

/// Name under which the CA is registered in the Windows trust store and in
/// `certmgr.msc`. Shared with the helper calls so lookups stay consistent.
pub const CA_FRIENDLY_NAME: &str = "DevX Local CA";

/// The on-disk CA: certificate PEM plus the signing key PEM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCa {
    /// CA certificate, PEM.
    pub cert_pem: String,
    /// CA private key, PEM (PKCS#8). Never leaves the DevX data directory.
    pub key_pem: String,
}

/// Loads the local CA from `certs_dir`, or `None` when it was never created.
///
/// A partially written CA (cert without key) is reported as an error rather
/// than regenerated: silently minting a second CA would strand every
/// certificate already trusted by the machine.
pub fn load_ca(certs_dir: &Path) -> Result<Option<LocalCa>> {
    let cert_path = certs_dir.join("ca.crt");
    let key_path = certs_dir.join("ca.key.pem");

    let cert = std::fs::read_to_string(&cert_path);
    let key = std::fs::read_to_string(&key_path);

    match (cert, key) {
        (Ok(cert_pem), Ok(key_pem)) if !cert_pem.is_empty() && !key_pem.is_empty() => {
            Ok(Some(LocalCa { cert_pem, key_pem }))
        }
        (Err(cert_err), Err(_)) if cert_err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        (_, key_result) => {
            // One file missing, empty, or unreadable: the CA is broken and
            // must not be silently replaced.
            let detail = match key_result {
                Ok(_) => "the CA key is missing or unreadable".to_owned(),
                Err(err) => format!("the CA files are incomplete: {err}"),
            };
            Err(Error::new(
                ErrorCode::Io,
                format!(
                    "the local CA at {} is broken: {detail}",
                    certs_dir.display()
                ),
            )
            .with_hint("remove the certs directory and reinstall the DevX CA to start over"))
        }
    }
}

/// Creates a new local CA in `certs_dir` unless one already exists.
///
/// Existing CAs are returned untouched: re-minting a CA invalidates every
/// server certificate signed by the old one and breaks the trust the user
/// already installed.
pub fn ensure_ca(certs_dir: &Path) -> Result<LocalCa> {
    if let Some(existing) = load_ca(certs_dir)? {
        return Ok(existing);
    }

    let ca = generate_ca()?;
    write_ca(certs_dir, &ca)?;
    Ok(ca)
}

/// Generates a fresh self-signed CA usable for issuing server certificates.
fn generate_ca() -> Result<LocalCa> {
    use rcgen::{
        BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
        KeyUsagePurpose,
    };

    let key = KeyPair::generate().map_err(pk_error("CA key generation failed"))?;

    let mut params =
        CertificateParams::new(Vec::new()).map_err(pk_error("CA parameters are invalid"))?;
    params
        .distinguished_name
        .push(DnType::CommonName, CA_FRIENDLY_NAME);
    params
        .distinguished_name
        .push(DnType::OrganizationName, "DevX");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

    let cert = params
        .self_signed(&key)
        .map_err(pk_error("CA self-signing failed"))?;

    Ok(LocalCa {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    })
}

/// Persists the CA atomically.
fn write_ca(certs_dir: &Path, ca: &LocalCa) -> Result<()> {
    std::fs::create_dir_all(certs_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", certs_dir.display()),
        )
    })?;
    devx_core::fsx::write_atomic(certs_dir.join("ca.crt"), &ca.cert_pem)?;
    devx_core::fsx::write_atomic(certs_dir.join("ca.key.pem"), &ca.key_pem)
}

/// Paths of one site's certificate and key on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateFiles {
    /// Server certificate (PEM).
    pub cert_path: PathBuf,
    /// Server private key (PEM).
    pub key_path: PathBuf,
}

/// Issues (or reuses) the server certificate for `hostname` + `aliases`.
///
/// SAN covers primary plus aliases. Reuses only when `sans.txt` matches the
/// requested set; otherwise reissues so a new alias never serves a stale cert.
pub fn ensure_site_cert(
    certs_dir: &Path,
    hostname: &str,
    aliases: &[String],
) -> Result<CertificateFiles> {
    devx_ipc::validate_hostname(hostname)?;
    for alias in aliases {
        devx_ipc::validate_hostname(alias)?;
    }

    let mut sans = vec![hostname.to_ascii_lowercase()];
    for alias in aliases {
        let lc = alias.to_ascii_lowercase();
        if !sans.contains(&lc) {
            sans.push(lc);
        }
    }
    sans.sort();

    let site_dir = certs_dir.join("sites").join(hostname.to_ascii_lowercase());
    let cert_path = site_dir.join("cert.pem");
    let key_path = site_dir.join("key.pem");
    let sans_path = site_dir.join("sans.txt");

    if cert_path.is_file() && key_path.is_file() {
        let stored = std::fs::read_to_string(&sans_path).unwrap_or_default();
        let mut prev: Vec<String> = stored.lines().map(|l| l.to_owned()).collect();
        prev.sort();
        if prev == sans {
            return Ok(CertificateFiles {
                cert_path,
                key_path,
            });
        }
    }

    let ca = load_ca(certs_dir)?.ok_or_else(|| {
        Error::not_found("no local CA exists yet")
            .with_hint("install the local CA first; it signs every site certificate")
    })?;

    let (cert_pem, key_pem) = issue_certificate(&ca, hostname, &sans)?;
    std::fs::create_dir_all(&site_dir).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to create {}: {err}", site_dir.display()),
        )
    })?;
    devx_core::fsx::write_atomic(&cert_path, &cert_pem)?;
    devx_core::fsx::write_atomic(&key_path, &key_pem)?;
    devx_core::fsx::write_atomic(&sans_path, sans.join("\n"))?;

    Ok(CertificateFiles {
        cert_path,
        key_path,
    })
}

/// Removes a site's certificate directory. Idempotent.
pub fn remove_site_cert(certs_dir: &Path, hostname: &str) {
    let dir = certs_dir.join("sites").join(hostname.to_ascii_lowercase());
    let _ = std::fs::remove_dir_all(dir);
}

/// Signs a short-lived server certificate for `hostname` with the local CA.
fn issue_certificate(ca: &LocalCa, hostname: &str, sans: &[String]) -> Result<(String, String)> {
    use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};

    let site_key = KeyPair::generate().map_err(pk_error("site key generation failed"))?;

    let mut params = CertificateParams::new(sans.to_vec())
        .map_err(pk_error("certificate parameters are invalid"))?;
    params.distinguished_name.push(DnType::CommonName, hostname);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

    // Re-derive the issuer from the stored CA material. `signed_by` consults
    // only the issuer's distinguished name, key-identifier method and usage
    // flags; the signature itself comes from `ca_key`, so the emitted
    // certificate chains to the CA PEM users actually install.
    let ca_cert = rcgen::CertificateParams::from_ca_cert_pem(&ca.cert_pem)
        .map_err(pk_error("the stored CA certificate is unreadable"))?;
    let ca_key =
        KeyPair::from_pem(&ca.key_pem).map_err(pk_error("the stored CA key is unreadable"))?;
    let ca_issuer = ca_cert
        .self_signed(&ca_key)
        .map_err(pk_error("the stored CA cannot be re-signed"))?;

    let cert = params
        .signed_by(&site_key, &ca_issuer, &ca_key)
        .map_err(pk_error("certificate signing failed"))?;

    Ok((cert.pem(), site_key.serialize_pem()))
}

/// Maps rcgen's error type into a DevX error with a stable message shape.
fn pk_error(context: &'static str) -> impl Fn(rcgen::Error) -> Error {
    move |err| Error::new(ErrorCode::Process, format!("{context}: {err}"))
}

/// Absolute certificate and key paths for `hostname`, forward slashes.
///
/// Points at where [`ensure_site_cert`] writes; does not create anything, so
/// renderers can reference the pair for servers whose config format differs
/// from nginx (Apache `SSLCertificateFile`, Caddy `tls`).
pub fn site_cert_files(certs_dir: &Path, hostname: &str) -> (String, String) {
    let dir = certs_dir
        .join("sites")
        .join(hostname.to_ascii_lowercase())
        .display()
        .to_string()
        .replace('\\', "/");
    (format!("{dir}/cert.pem"), format!("{dir}/key.pem"))
}

/// Renders the TLS additions to a site's nginx `server` block.
///
/// Returned by the sites renderer when a site has HTTPS enabled: the second
/// `listen` line plus the `ssl_*` directives pointing at the site's
/// certificate. The paths are absolute — nginx's prefix points at the
/// nginx *install* directory, so relative certificate paths would resolve
/// to the wrong place.
pub fn tls_listen_snippet(
    hostname: &str,
    https_port: u16,
    bind_ip: std::net::Ipv4Addr,
    certs_dir: &Path,
) -> String {
    let cert_dir = certs_dir
        .join("sites")
        .join(hostname.to_ascii_lowercase())
        .display()
        .to_string()
        .replace('\\', "/");
    format!(
        "    listen       {bind_ip}:{https_port} ssl;\n    ssl_certificate     {cert_dir}/cert.pem;\n    ssl_certificate_key {cert_dir}/key.pem;\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn temp_certs() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("certs");
        (dir, path)
    }

    #[test]
    fn ca_generation_produces_a_pem_pair() {
        let ca = generate_ca().expect("generate");

        assert!(ca.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(ca.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn ensure_ca_creates_then_reuses() {
        let (_dir, certs) = temp_certs();

        let first = ensure_ca(&certs).expect("first");
        assert!(certs.join("ca.crt").is_file());
        assert!(certs.join("ca.key.pem").is_file());

        let second = ensure_ca(&certs).expect("second");
        assert_eq!(first, second, "an existing CA must not be re-minted");
    }

    #[test]
    fn load_ca_tolerates_missing_but_not_broken() {
        let (_dir, certs) = temp_certs();

        assert!(load_ca(&certs).expect("nothing yet").is_none());

        std::fs::create_dir_all(&certs).expect("dir");
        std::fs::write(certs.join("ca.crt"), "half a CA").expect("cert only");
        let err = load_ca(&certs).expect_err("incomplete");
        assert_eq!(err.code, ErrorCode::Io);
    }

    #[test]
    fn site_certificates_are_issued_once_and_reused() {
        let (_dir, certs) = temp_certs();
        ensure_ca(&certs).expect("ca");

        let first = ensure_site_cert(&certs, "app.test", &[]).expect("issue");
        assert!(first.cert_path.is_file());
        assert!(first.key_path.is_file());

        let pem = std::fs::read_to_string(&first.cert_path).expect("read");
        assert!(pem.contains("BEGIN CERTIFICATE"), "{pem}");

        let again = ensure_site_cert(&certs, "app.test", &[]).expect("reuse");
        assert_eq!(first, again, "a second call must not reissue");
    }

    #[test]
    fn adding_an_alias_reissues_with_new_sans() {
        let (_dir, certs) = temp_certs();
        ensure_ca(&certs).expect("ca");

        ensure_site_cert(&certs, "app.test", &[]).expect("issue");
        let before = std::fs::read_to_string(certs.join("sites").join("app.test").join("cert.pem"))
            .expect("read");
        ensure_site_cert(&certs, "app.test", &["www.app.test".to_owned()]).expect("reissue");
        let after = std::fs::read_to_string(certs.join("sites").join("app.test").join("cert.pem"))
            .expect("read");
        assert_ne!(before, after, "new SAN set must reissue");
        let sans = std::fs::read_to_string(certs.join("sites").join("app.test").join("sans.txt"))
            .expect("sans");
        assert!(sans.contains("www.app.test"), "{sans}");
    }

    #[test]
    fn issuing_without_a_ca_is_a_clear_not_found() {
        let (_dir, certs) = temp_certs();
        let err = ensure_site_cert(&certs, "app.test", &[]).expect_err("no CA");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn hostile_hostnames_never_reach_the_key_pipeline() {
        let (_dir, certs) = temp_certs();
        ensure_ca(&certs).expect("ca");

        assert!(ensure_site_cert(&certs, "*.evil", &[]).is_err());
        assert!(ensure_site_cert(&certs, "", &[]).is_err());
    }

    #[test]
    fn tls_snippet_points_at_the_site_certificate() {
        let certs = std::path::Path::new("C:/devx/certs");
        let snippet = tls_listen_snippet(
            "MyApp.test",
            443,
            std::net::Ipv4Addr::new(127, 0, 0, 2),
            certs,
        );
        assert!(
            snippet.contains("listen       127.0.0.2:443 ssl;"),
            "{snippet}"
        );
        assert!(
            snippet.contains("C:/devx/certs/sites/myapp.test/cert.pem;"),
            "{snippet}"
        );
        assert!(snippet.contains("ssl_certificate_key"), "{snippet}");
    }
}
