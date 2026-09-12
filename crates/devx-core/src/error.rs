//! Domain error type shared across DevX crates.
//!
//! Errors are designed to cross the Tauri IPC boundary: every variant carries a
//! stable machine-readable `code` plus a human message, so the UI can branch on
//! the code and still show something useful when it does not recognise it.

use serde::Serialize;
use std::fmt;

/// Result alias used throughout DevX.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Stable, machine-readable error classification.
///
/// The string form is part of the IPC contract with the frontend; do not rename
/// variants without updating the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Input failed validation before any side effect was attempted.
    InvalidInput,
    /// A required file, directory, component or record does not exist.
    NotFound,
    /// The requested change conflicts with existing state.
    Conflict,
    /// Filesystem-level failure.
    Io,
    /// Configuration could not be read, parsed or migrated.
    Config,
    /// Network failure while talking to an upstream service.
    Network,
    /// A downloaded artifact failed integrity verification.
    Integrity,
    /// Failure while starting, stopping or supervising a process.
    Process,
    /// The privileged helper is unavailable or refused the request.
    Privileged,
    /// Something failed that we could not classify.
    Internal,
}

impl ErrorCode {
    /// Stable string form, matching the serialized representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Io => "io",
            Self::Config => "config",
            Self::Network => "network",
            Self::Integrity => "integrity",
            Self::Process => "process",
            Self::Privileged => "privileged",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A DevX error: a classification, a message, and optional operator guidance.
///
/// Renamed for TypeScript so the generated binding does not shadow the global
/// `Error`. `hint` is always serialized (rather than skipped when absent) to
/// keep a single shape on the wire.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename = "DevxError")]
pub struct Error {
    /// Machine-readable classification.
    pub code: ErrorCode,
    /// Human-readable description of what went wrong.
    pub message: String,
    /// Optional actionable next step shown to the user.
    pub hint: Option<String>,
}

impl Error {
    /// Construct an error with the given code and message.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }

    /// Attach an actionable hint for the user.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Shorthand for [`ErrorCode::InvalidInput`].
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    /// Shorthand for [`ErrorCode::NotFound`].
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    /// Shorthand for [`ErrorCode::Conflict`].
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    /// Shorthand for [`ErrorCode::Config`].
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Config, message)
    }

    /// Shorthand for [`ErrorCode::Internal`].
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// Shorthand for [`ErrorCode::Privileged`].
    ///
    /// Used when the privileged helper is unreachable, refuses a request, or
    /// reports an elevation failure.
    pub fn privileged(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Privileged, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if let Some(hint) = &self.hint {
            write!(f, " ({hint})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        let code = match value.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::AlreadyExists => ErrorCode::Conflict,
            _ => ErrorCode::Io,
        };
        Self::new(code, value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn error_code_string_form_matches_serialization() {
        // The `as_str` helper and serde must not drift apart, because the UI
        // branches on the serialized value.
        for code in [
            ErrorCode::InvalidInput,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Io,
            ErrorCode::Config,
            ErrorCode::Network,
            ErrorCode::Integrity,
            ErrorCode::Process,
            ErrorCode::Privileged,
            ErrorCode::Internal,
        ] {
            let serialized = serde_json::to_string(&code).expect("serialize code");
            assert_eq!(serialized, format!("\"{}\"", code.as_str()));
        }
    }

    #[test]
    fn io_error_kind_maps_to_domain_code() {
        let not_found = Error::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "missing.toml",
        ));
        assert_eq!(not_found.code, ErrorCode::NotFound);

        let exists = Error::from(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "already there",
        ));
        assert_eq!(exists.code, ErrorCode::Conflict);

        let other = Error::from(std::io::Error::other("disk on fire"));
        assert_eq!(other.code, ErrorCode::Io);
    }

    #[test]
    fn display_includes_code_and_hint() {
        let err = Error::invalid_input("domain is empty").with_hint("use something like app.test");
        assert_eq!(
            err.to_string(),
            "[invalid_input] domain is empty (use something like app.test)"
        );
    }
}
