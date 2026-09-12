//! Rotating log file for a supervised process.
//!
//! Each service appends its combined output to `<name>.log`. When that file
//! passes a size threshold it is rotated to `<name>.log.1` (displacing any
//! previous `.1`), keeping one generation of history without unbounded growth.
//! Rotation on a single backup is deliberate: these are development logs, not
//! an audit trail, and the in-memory ring already serves the live tail.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};

/// Appends log lines to a file, rotating it past a size limit.
#[derive(Debug)]
pub struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    file: File,
    written: u64,
}

impl RotatingLog {
    /// Opens (creating if needed) the log at `path`, rotating past `max_bytes`.
    pub fn open(path: impl Into<PathBuf>, max_bytes: u64) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_error(err, parent, "create log directory"))?;
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|err| io_error(err, &path, "open log file"))?;
        let written = file
            .metadata()
            .map(|meta| meta.len())
            .map_err(|err| io_error(err, &path, "stat log file"))?;

        Ok(Self {
            path,
            max_bytes: max_bytes.max(1),
            file,
            written,
        })
    }

    /// Writes one line, appending a newline, rotating first if needed.
    pub fn write_line(&mut self, line: &str) -> Result<()> {
        let bytes = line.len() as u64 + 1;

        if self.written + bytes > self.max_bytes && self.written > 0 {
            self.rotate()?;
        }

        self.file
            .write_all(line.as_bytes())
            .and_then(|()| self.file.write_all(b"\n"))
            .map_err(|err| io_error(err, &self.path, "write log line"))?;
        self.written += bytes;
        Ok(())
    }

    /// Rotates the current file to `<path>.1` and starts a fresh one.
    fn rotate(&mut self) -> Result<()> {
        let backup = rotated_path(&self.path);

        // Drop the handle before renaming: Windows will not rename an open file
        // in every configuration.
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|err| io_error(err, &self.path, "reopen log file"))?;

        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&self.path, &backup)
            .map_err(|err| io_error(err, &self.path, "rotate log file"))?;

        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|err| io_error(err, &self.path, "create rotated log file"))?;
        self.written = 0;
        Ok(())
    }

    /// Path of the active log file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Backup path for a log file: `x.log` becomes `x.log.1`.
fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

/// Wraps an IO error with context.
fn io_error(err: std::io::Error, path: &Path, action: &str) -> Error {
    Error::new(
        ErrorCode::Io,
        format!("failed to {action} at {}: {err}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_lines_to_the_file() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("svc.log");
        let mut log = RotatingLog::open(&path, 1024).expect("open");

        log.write_line("first").expect("write");
        log.write_line("second").expect("write");

        let contents = std::fs::read_to_string(&path).expect("read");
        assert_eq!(contents, "first\nsecond\n");
    }

    #[test]
    fn rotates_past_the_size_limit() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("svc.log");
        // Small limit so a couple of lines trip it.
        let mut log = RotatingLog::open(&path, 8).expect("open");

        log.write_line("aaaa").expect("write"); // 5 bytes, under limit
        log.write_line("bbbb").expect("write"); // would exceed, rotates first

        let current = std::fs::read_to_string(&path).expect("read current");
        let backup = std::fs::read_to_string(rotated_path(&path)).expect("read backup");

        assert_eq!(backup, "aaaa\n", "the first line moved to the backup");
        assert_eq!(current, "bbbb\n", "the new line is in the fresh file");
    }

    #[test]
    fn reopening_appends_rather_than_truncates() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("svc.log");

        RotatingLog::open(&path, 1024)
            .expect("open")
            .write_line("one")
            .expect("write");
        RotatingLog::open(&path, 1024)
            .expect("reopen")
            .write_line("two")
            .expect("write");

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "one\ntwo\n");
    }

    #[test]
    fn rotated_path_appends_generation_suffix() {
        assert_eq!(
            rotated_path(Path::new("C:\\logs\\nginx.log")),
            PathBuf::from("C:\\logs\\nginx.log.1")
        );
    }
}
