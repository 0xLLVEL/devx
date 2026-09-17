//! Flushing the Windows DNS client resolver cache.
//!
//! Windows keeps every answer it has already looked up, including the ones it
//! read from the hosts file. A name that resolved once therefore keeps
//! resolving to the old address for the cache's lifetime even after the file
//! says otherwise, which is why §111's "Flush DNS" is a first-class action
//! rather than a footnote on save.
//!
//! The flush runs in the helper because the documented command needs
//! elevation: `ipconfig /flushdns` is the supported interface, and it is what
//! the Windows UI itself calls. Nothing here touches the hosts file.

use devx_core::Result;

/// Operations on the resolver cache, split from the process so the dispatcher
/// rules are testable without dropping a real machine's cache.
pub trait DnsCacheBackend {
    /// Drops every entry in the machine's resolver cache.
    fn flush(&self) -> Result<()>;
}

/// Backend running the real `ipconfig /flushdns`.
#[derive(Debug, Clone, Default)]
pub struct WindowsDnsCache;

impl DnsCacheBackend for WindowsDnsCache {
    fn flush(&self) -> Result<()> {
        imp::flush()
    }
}

/// Turns one finished `ipconfig` run into a result.
///
/// Pure, so the verdict and the message shape are testable without spawning
/// anything: the exit code decides, and the tool's own words are carried into
/// the failure instead of being replaced by a generic sentence.
fn flush_outcome(code: Option<i32>, stdout: &str, stderr: &str) -> Result<()> {
    if code == Some(0) {
        return Ok(());
    }

    let said = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    let reason = if said.is_empty() {
        match code {
            Some(code) => format!("`ipconfig /flushdns` exited with code {code}"),
            None => "`ipconfig /flushdns` was ended before it reported a result".to_owned(),
        }
    } else {
        format!("`ipconfig /flushdns` said: {said}")
    };

    Err(devx_core::Error::privileged(reason)
        .with_hint("the DNS cache can only be flushed by an elevated process"))
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt as _;

    use devx_core::{Error, Result};

    use super::flush_outcome;

    /// CREATE_NO_WINDOW: the helper runs hidden, and a console flashing up on
    /// every flush would be a visible side effect the user did not ask for.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn flush() -> Result<()> {
        let output = std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|err| Error::privileged(format!("could not run ipconfig /flushdns: {err}")))?;

        flush_outcome(
            output.status.code(),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        )
    }
}

/// Off Windows there is no resolver cache to drop.
#[cfg(not(windows))]
mod imp {
    use devx_core::{Error, Result};

    pub fn flush() -> Result<()> {
        Err(Error::privileged("flushing the DNS cache requires Windows"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn a_zero_exit_is_the_only_success() {
        assert!(flush_outcome(Some(0), "Successfully flushed the DNS Resolver Cache.", "").is_ok());
        // The success text alone is not the verdict; a non-zero exit with the
        // same words is still a failure.
        assert!(
            flush_outcome(Some(1), "Successfully flushed the DNS Resolver Cache.", "").is_err()
        );
    }

    #[test]
    fn a_failure_says_what_the_tool_said() {
        let err = flush_outcome(Some(1), "", "The requested operation requires elevation.")
            .expect_err("non-zero exit");
        assert_eq!(err.code, devx_core::ErrorCode::Privileged);
        assert!(
            err.message.contains("requires elevation"),
            "the tool's own words must survive: {err}"
        );
        assert!(err.hint.is_some(), "a failure must say what to do instead");
    }

    #[test]
    fn stderr_wins_but_an_empty_stderr_falls_back_to_stdout() {
        let both = flush_outcome(Some(2), "stdout line", "stderr line").expect_err("failure");
        assert!(both.message.contains("stderr line"), "{both}");
        assert!(!both.message.contains("stdout line"), "{both}");

        let stdout_only = flush_outcome(Some(2), "exit detail", "").expect_err("failure");
        assert!(stdout_only.message.contains("exit detail"), "{stdout_only}");
    }

    #[test]
    fn silence_still_names_the_exit_code() {
        let err = flush_outcome(Some(3), "", "").expect_err("failure");
        assert!(err.message.contains('3'), "{err}");

        let killed = flush_outcome(None, "", "").expect_err("a killed process is a failure");
        assert!(killed.message.contains("before it reported"), "{killed}");
    }
}
