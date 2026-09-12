//! SHA-256 verification of downloaded artifacts.
//!
//! Two checksum shapes reach us. Some upstreams give the digest inline in their
//! version metadata; others publish a `sha256sum`-style file listing
//! `<hex>  <file name>` for every artifact in a release. Both resolve to the
//! same thing: a lowercase hex digest to compare against.

use std::path::Path;

use devx_core::{Error, ErrorCode, Result};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::catalog::is_sha256_hex;

/// Computes the SHA-256 of a file, reading it in bounded chunks.
///
/// Streaming keeps memory flat regardless of artifact size (PostgreSQL is
/// ~54 MB, some archives more), which matters when several installs run at once.
pub async fn sha256_file(path: impl AsRef<Path>) -> Result<String> {
    let path = path.as_ref();
    let mut file = tokio::fs::File::open(path).await.map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to open {} for hashing: {err}", path.display()),
        )
    })?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];

    loop {
        let read = file.read(&mut buffer).await.map_err(|err| {
            Error::new(
                ErrorCode::Io,
                format!("failed to read {} while hashing: {err}", path.display()),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex_lower(&hasher.finalize()))
}

/// Verifies that `path` hashes to `expected_hex`.
///
/// # Errors
///
/// Returns [`ErrorCode::Integrity`] on mismatch, with both digests in the
/// message so a report is actionable.
pub async fn verify_sha256(path: impl AsRef<Path>, expected_hex: &str) -> Result<()> {
    let path = path.as_ref();
    let expected = expected_hex.trim().to_ascii_lowercase();

    if !is_sha256_hex(&expected) {
        return Err(Error::new(
            ErrorCode::Integrity,
            format!("expected hash `{expected_hex}` is not a valid SHA-256"),
        ));
    }

    let actual = sha256_file(path).await?;

    if actual != expected {
        return Err(Error::new(
            ErrorCode::Integrity,
            format!(
                "checksum mismatch for {}: expected {expected}, computed {actual}",
                path.display()
            ),
        )
        .with_hint("the download may be corrupt or tampered with; DevX will not install it"));
    }

    Ok(())
}

/// Extracts one file's digest from a `sha256sum`-style document.
///
/// Handles both layouts seen in the wild:
///
/// * multi-line `<hex>  <name>` files (Node's `SHASUMS256.txt`, MariaDB's
///   `sha256sums.txt`), where names may carry a `./` or `*` prefix;
/// * single-entry files where the name is the artifact and only its hash is
///   listed (theseus-rs PostgreSQL `.sha256`, which pairs one file to one sums
///   document).
///
/// A single-line document with just a bare hash is accepted as belonging to the
/// requested file, since that is exactly how the per-artifact `.sha256` files
/// are published.
pub fn parse_sums_document(document: &str, file_name: &str) -> Result<String> {
    let mut only_line_hash: Option<String> = None;
    let mut lines = 0usize;

    for line in document.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        lines += 1;

        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else { continue };
        let hash = hash.to_ascii_lowercase();

        // The name may be absent (bare-hash file), and can be prefixed with
        // `*` (binary mode) or `./` (relative path).
        if let Some(name) = parts.next() {
            let name = name.trim_start_matches('*').trim_start_matches("./");
            if name == file_name && is_sha256_hex(&hash) {
                return Ok(hash);
            }
        } else if is_sha256_hex(&hash) {
            only_line_hash = Some(hash);
        }
    }

    // A file containing a single bare hash is the per-artifact `.sha256` form.
    if lines == 1 {
        if let Some(hash) = only_line_hash {
            return Ok(hash);
        }
    }

    Err(Error::new(
        ErrorCode::Integrity,
        format!("no SHA-256 for `{file_name}` found in the checksum document"),
    )
    .with_hint("the upstream may have renamed the artifact; check for a DevX update"))
}

/// Lowercase hex encoding of a byte slice.
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[tokio::test]
    async fn hashes_a_known_input() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("empty");
        tokio::fs::write(&path, b"").await.expect("write");

        assert_eq!(sha256_file(&path).await.expect("hash"), EMPTY_SHA256);
    }

    #[tokio::test]
    async fn verify_accepts_a_match_and_is_case_insensitive() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("empty");
        tokio::fs::write(&path, b"").await.expect("write");

        verify_sha256(&path, EMPTY_SHA256).await.expect("lowercase");
        verify_sha256(&path, &EMPTY_SHA256.to_uppercase())
            .await
            .expect("uppercase is normalised");
    }

    #[tokio::test]
    async fn verify_rejects_a_mismatch_with_an_integrity_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("data");
        tokio::fs::write(&path, b"not empty").await.expect("write");

        let err = verify_sha256(&path, EMPTY_SHA256)
            .await
            .expect_err("must reject");
        assert_eq!(err.code, ErrorCode::Integrity);
        assert!(err.message.contains("mismatch"), "{}", err.message);
    }

    #[tokio::test]
    async fn verify_rejects_a_malformed_expected_hash() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("data");
        tokio::fs::write(&path, b"x").await.expect("write");

        let err = verify_sha256(&path, "not-a-hash")
            .await
            .expect_err("must reject");
        assert_eq!(err.code, ErrorCode::Integrity);
    }

    #[test]
    fn parses_a_multi_entry_shasums_file() {
        // Trimmed from a real Node SHASUMS256.txt.
        let document = "\
5b0b...  node-v26.5.0-headers.tar.gz
aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888  node-v26.5.0-win-x64.zip
9999...  node-v26.5.0-win-arm64.zip
";
        let hash = parse_sums_document(document, "node-v26.5.0-win-x64.zip").expect("found");
        assert_eq!(
            hash,
            "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888"
        );
    }

    #[test]
    fn parses_names_with_star_and_dot_slash_prefixes() {
        let star = format!("{}  *artifact.zip", "a".repeat(64));
        assert_eq!(
            parse_sums_document(&star, "artifact.zip").expect("star"),
            "a".repeat(64)
        );

        let dot = format!("{}  ./artifact.zip", "b".repeat(64));
        assert_eq!(
            parse_sums_document(&dot, "artifact.zip").expect("dot"),
            "b".repeat(64)
        );
    }

    #[test]
    fn parses_a_bare_single_hash_file() {
        // theseus-rs publishes one `.sha256` per artifact containing just the
        // hash (sometimes followed by the name, sometimes not).
        let bare = "c".repeat(64);
        assert_eq!(
            parse_sums_document(&bare, "postgresql-18.6.0-x86_64-pc-windows-msvc.zip")
                .expect("bare"),
            "c".repeat(64)
        );
    }

    #[test]
    fn missing_entry_is_an_integrity_error() {
        let document = format!("{}  other-file.zip", "d".repeat(64));
        let err = parse_sums_document(&document, "wanted.zip").expect_err("must fail");
        assert_eq!(err.code, ErrorCode::Integrity);
    }

    #[test]
    fn a_bare_hash_is_not_assumed_when_several_lines_exist() {
        // Two bare hashes are ambiguous; without a name match this must fail
        // rather than guess.
        let document = format!("{}\n{}", "e".repeat(64), "f".repeat(64));
        assert!(parse_sums_document(&document, "wanted.zip").is_err());
    }
}
