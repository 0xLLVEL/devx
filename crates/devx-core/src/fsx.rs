//! Filesystem helpers with the durability properties DevX needs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{Error, ErrorCode, Result};

/// Writes `contents` to `path` atomically.
///
/// The data lands in a sibling temporary file which is flushed and synced before
/// being renamed over the destination. A crash therefore leaves either the old
/// file or the new one, never a truncated mix. On Windows `fs::rename` replaces
/// an existing destination, so no separate delete step is required.
///
/// The temporary file is removed if any step fails, leaving the destination
/// untouched.
pub fn write_atomic(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| {
        Error::invalid_input(format!("{} has no parent directory", path.display()))
    })?;

    fs::create_dir_all(parent).map_err(|err| io_error(err, parent, "create directory"))?;

    let temp_path = temp_sibling(path);

    // Scope the handle so it is closed before the rename: Windows refuses to
    // rename a file that still has an open writable handle in some configs.
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(contents.as_ref())?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error(err, &temp_path, "write temporary file"));
    }

    if let Err(err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error(err, path, "replace file"));
    }

    Ok(())
}

/// Builds a temporary sibling path that will not collide across processes.
fn temp_sibling(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "devx".to_owned());

    path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()))
}

/// Wraps an IO error with the path and operation that produced it.
///
/// The bare `io::Error` messages ("Access is denied") are useless in a log
/// without this context.
fn io_error(err: std::io::Error, path: &Path, action: &str) -> Error {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::Io,
        _ => ErrorCode::Io,
    };

    Error::new(
        code,
        format!("failed to {action} {}: {err}", path.display()),
    )
}

/// Reports whether `path` is writable by creating and removing a probe file.
///
/// Checking permissions by inspecting ACLs is unreliable on Windows; actually
/// attempting the write is the only trustworthy answer.
pub fn is_writable(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    if fs::create_dir_all(path).is_err() {
        return false;
    }

    let probe = path.join(format!(".devx-write-probe-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn writes_new_file_and_leaves_no_temporary_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("nested").join("config.toml");

        write_atomic(&target, b"hello = 1\n").expect("write");

        assert_eq!(fs::read_to_string(&target).expect("read"), "hello = 1\n");
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
    }

    #[test]
    fn replaces_existing_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("config.toml");
        fs::write(&target, "old = true\n").expect("seed");

        write_atomic(&target, b"new = true\n").expect("write");

        assert_eq!(fs::read_to_string(&target).expect("read"), "new = true\n");
    }

    #[test]
    fn failed_replacement_keeps_original_content() {
        let dir = tempfile::tempdir().expect("temp dir");
        let target = dir.path().join("config.toml");
        fs::write(&target, "original = true\n").expect("seed");

        // A read-only destination makes the rename fail, which stands in for an
        // interrupted save.
        let mut perms = fs::metadata(&target).expect("metadata").permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).expect("set readonly");

        let result = write_atomic(&target, b"replacement = true\n");

        // Restore write access before asserting so the temp dir can clean up.
        // `set_readonly(false)` is the only way back on Windows; clippy's
        // portability warning does not apply to a Windows-only project.
        let mut perms = fs::metadata(&target).expect("metadata").permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&target, perms).expect("clear readonly");

        assert!(result.is_err(), "expected the replacement to fail");
        assert_eq!(
            fs::read_to_string(&target).expect("read"),
            "original = true\n",
            "the original file must survive a failed write"
        );
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temporary file must be cleaned up: {leftovers:?}"
        );
    }

    #[test]
    fn detects_writable_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(is_writable(dir.path()));
        assert!(is_writable(dir.path().join("created-on-demand")));
    }
}
