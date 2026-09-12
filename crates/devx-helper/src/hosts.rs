//! Editing the Windows `hosts` file — the only file the helper writes.
//!
//! Every mutation is confined to entries carrying the DevX marker comment.
//! The marker is what makes the helper safe to run elevated: it can add,
//! update and remove its own entries, but it can neither edit nor delete a
//! line it did not write, so a user's hand-crafted overrides survive DevX
//! (and, equally, the helper cannot be conned into rewriting them).
//!
//! ```text
//! 127.0.0.1  myapp.test  # devx-managed
//! ```
//!
//! All operations are whole-file rewrites through
//! [`devx_core::fsx::write_atomic`]: the hosts file is small, and an atomic
//! replace beats in-place edits for crash safety on a file the DNS cache
//! reads on demand.

use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};
use devx_ipc::HostsEntry;

/// Comment appended to every entry DevX manages.
///
/// The string is the ownership test: a hosts line is DevX-managed if and only
/// if it ends with this marker.
pub const MARKER: &str = "# devx-managed";

/// The default hosts-file location.
pub fn default_hosts_path() -> PathBuf {
    PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
}

/// One parsed hosts-file line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostsLine {
    /// Raw line as it appeared (or will appear) in the file, without newline.
    pub raw: String,
    /// Whether the line carries the DevX marker.
    pub managed: bool,
    /// Parsed host name and IP, when the line is a usable mapping.
    pub mapping: Option<(String, String)>,
}

/// Parses a hosts file into lines with ownership and mapping information.
pub fn parse_hosts(body: &str) -> Vec<HostsLine> {
    body.lines()
        .map(|raw| {
            let managed = raw.trim_end().ends_with(MARKER);
            let mapping = parse_mapping(raw);
            HostsLine {
                raw: raw.to_owned(),
                managed,
                mapping,
            }
        })
        .collect()
}

/// Extracts `(hostname, ip)` from a mapping line, ignoring comments.
///
/// Lines that are comments only, malformed, or carry no mapping parse as
/// `None` and are preserved verbatim on rewrite.
fn parse_mapping(raw: &str) -> Option<(String, String)> {
    let without_comment = raw.split('#').next()?.trim();
    let mut parts = without_comment.split_whitespace();
    let ip = parts.next()?;
    let hostname = parts.next()?;
    Some((hostname.to_owned(), ip.to_owned()))
}

/// Reads the current DevX-managed entries.
///
/// # Errors
///
/// Propagates read failures (the file always exists on Windows, so a missing
/// file is genuinely unexpected).
pub fn list_entries(path: &Path) -> Result<Vec<HostsEntry>> {
    let body = std::fs::read_to_string(path).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to read {}: {err}", path.display()),
        )
    })?;

    Ok(parse_hosts(&body)
        .into_iter()
        .filter(|line| line.managed)
        .filter_map(|line| line.mapping)
        .map(|(hostname, ip)| HostsEntry { hostname, ip })
        .collect())
}

/// Adds or updates one entry, confined to the DevX marker.
///
/// A host name that is already mapped by a *managed* line is updated in
/// place; a host name mapped by a foreign line is refused with
/// [`ErrorCode::Conflict`] rather than silently shadowed — the helper will
/// not fight the user over a line it does not own.
///
/// # Errors
///
/// Fails on invalid entries, foreign-line conflicts, and IO errors.
pub fn add_entry(path: &Path, entry: &HostsEntry) -> Result<()> {
    entry.validate()?;

    let body = std::fs::read_to_string(path).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to read {}: {err}", path.display()),
        )
    })?;

    let mut lines = parse_hosts(&body);
    let mut replaced = false;

    for line in &mut lines {
        let Some((name, _)) = &line.mapping else {
            continue;
        };
        if !name.eq_ignore_ascii_case(&entry.hostname) {
            continue;
        }
        if !line.managed {
            return Err(Error::conflict(format!(
                "`{}` is already mapped by a line outside DevX's control",
                entry.hostname
            ))
            .with_hint("remove the existing hosts entry manually, then let DevX manage it"));
        }
        // Managed line for the same host: rewrite it in place, preserving
        // position so the file stays diff-friendly.
        line.raw = render_entry(entry);
        replaced = true;
    }

    if !replaced {
        lines.push(HostsLine {
            raw: render_entry(entry),
            managed: true,
            mapping: Some((entry.hostname.clone(), entry.ip.clone())),
        });
    }

    write_lines(path, &lines)
}

/// Removes the managed entry for `hostname`.
///
/// Removing a host name that only exists as a foreign line is `Ok(())`: there
/// is nothing of DevX's to remove, and idempotent removal is what the caller
/// (and the UI) expects.
///
/// # Errors
///
/// Propagates IO failures.
pub fn remove_entry(path: &Path, hostname: &str) -> Result<()> {
    devx_ipc::validate_hostname(hostname)?;

    let body = std::fs::read_to_string(path).map_err(|err| {
        Error::new(
            ErrorCode::Io,
            format!("failed to read {}: {err}", path.display()),
        )
    })?;

    let lines: Vec<HostsLine> = parse_hosts(&body)
        .into_iter()
        .filter(|line| {
            // Keep foreign lines verbatim; drop managed lines matching the
            // host name only.
            if !line.managed {
                return true;
            }
            line.mapping
                .as_ref()
                .is_none_or(|(name, _)| !name.eq_ignore_ascii_case(hostname))
        })
        .collect();

    write_lines(path, &lines)
}

/// Renders one managed entry.
fn render_entry(entry: &HostsEntry) -> String {
    format!("{}\t{}\t{}", entry.ip, entry.hostname, MARKER)
}

/// Atomically rewrites the hosts file from parsed lines.
fn write_lines(path: &Path, lines: &[HostsLine]) -> Result<()> {
    let mut body = lines
        .iter()
        .map(|line| line.raw.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    devx_core::fsx::write_atomic(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const SAMPLE: &str = "# Copyright header preserved\n127.0.0.1 localhost\n10.0.0.5 corporate-thing\n127.0.0.1\tapp.test\t# devx-managed\n127.0.0.1\tdb.test\t# devx-managed\n";

    fn entry(hostname: &str, ip: &str) -> HostsEntry {
        HostsEntry {
            hostname: hostname.to_owned(),
            ip: ip.to_owned(),
        }
    }

    #[test]
    fn parsing_preserves_everything_and_finds_mappings() {
        let lines = parse_hosts(SAMPLE);

        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0].raw, "# Copyright header preserved");
        assert!(!lines[0].managed);
        assert!(lines[0].mapping.is_none());

        assert_eq!(
            lines[1].mapping,
            Some(("localhost".into(), "127.0.0.1".into()))
        );
        assert!(!lines[1].managed, "localhost is not ours");

        assert!(lines[3].managed);
        assert_eq!(
            lines[3].mapping,
            Some(("app.test".into(), "127.0.0.1".into()))
        );
    }

    #[test]
    fn listing_returns_only_managed_entries() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        let entries = list_entries(&path).expect("list");

        assert_eq!(
            entries,
            vec![
                entry("app.test", "127.0.0.1"),
                entry("db.test", "127.0.0.1"),
            ]
        );
    }

    #[test]
    fn adding_appends_a_marked_line() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        add_entry(&path, &entry("new.test", "127.0.0.1")).expect("add");

        let body = std::fs::read_to_string(&path).expect("read");
        assert!(
            body.contains("127.0.0.1\tnew.test\t# devx-managed"),
            "{body}"
        );
        // Everything else survives untouched, in order.
        assert!(body.starts_with("# Copyright header preserved\n"));
        assert!(body.contains("10.0.0.5 corporate-thing"));
    }

    #[test]
    fn updating_rewrites_only_the_managed_line_for_that_host() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        add_entry(&path, &entry("app.test", "127.0.0.99")).expect("update");

        let body = std::fs::read_to_string(&path).expect("read");
        assert!(
            body.contains("127.0.0.99\tapp.test\t# devx-managed"),
            "{body}"
        );
        assert!(!body.contains("127.0.0.1\tapp.test"), "{body}");
        // The db line must be untouched.
        assert!(body.contains("127.0.0.1\tdb.test\t# devx-managed"));
    }

    #[test]
    fn adding_over_a_foreign_mapping_is_a_conflict() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        let err = add_entry(&path, &entry("corporate-thing", "127.0.0.1"))
            .expect_err("a foreign line must not be shadowed");
        assert_eq!(err.code, ErrorCode::Conflict);

        // And the file is unchanged.
        assert_eq!(std::fs::read_to_string(&path).expect("read"), SAMPLE);
    }

    #[test]
    fn removal_is_confined_to_managed_lines_and_idempotent() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        remove_entry(&path, "app.test").expect("remove");
        let body = std::fs::read_to_string(&path).expect("read");
        assert!(!body.contains("app.test"), "{body}");
        assert!(body.contains("corporate-thing"), "foreign lines survive");
        assert!(body.contains("db.test"), "other managed lines survive");

        // Removing again is fine.
        remove_entry(&path, "app.test").expect("idempotent");

        // A foreign host is silently untouched.
        remove_entry(&path, "corporate-thing").expect("nothing to remove");
        assert!(std::fs::read_to_string(&path)
            .expect("read")
            .contains("corporate-thing"));
    }

    #[test]
    fn matching_hostnames_is_case_insensitive_everywhere() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");

        // Updating with different case must not create a duplicate.
        add_entry(&path, &entry("APP.TEST", "127.0.0.77")).expect("update");
        let body = std::fs::read_to_string(&path).expect("read");
        assert_eq!(
            body.lines()
                .filter(|l| l.to_ascii_lowercase().contains("app.test"))
                .count(),
            1,
            "{body}"
        );

        remove_entry(&path, "Db.Test").expect("remove");
        assert!(!std::fs::read_to_string(&path)
            .expect("read")
            .contains("db.test"));
    }

    #[test]
    fn invalid_entries_never_reach_the_file() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("hosts");
        std::fs::write(&path, SAMPLE).expect("seed");
        let before = std::fs::read_to_string(&path).expect("read");

        for bad in [
            entry("*.evil", "127.0.0.1"),
            entry("ok.test", "not-an-ip"),
            entry("", "127.0.0.1"),
        ] {
            assert!(add_entry(&path, &bad).is_err(), "{bad:?} must be refused");
        }

        assert_eq!(std::fs::read_to_string(&path).expect("read"), before);
    }
}
