//! Events pushed from the backend to the frontend.
//!
//! Long-running work (downloads, extraction) reports progress through events
//! rather than a command return value, so the UI can show a live progress bar.
//! Events are declared here, registered in [`crate::ipc`], and typed on the
//! frontend through the generated `bindings.ts`.

use serde::{Deserialize, Serialize};
use tauri_specta::Event;

/// Where an install currently is, mirrored from
/// [`devx_provision::InstallStage`] into an IPC-friendly shape.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum InstallPhase {
    /// Resolving a separately-published checksum.
    ResolvingChecksum,
    /// Downloading, with byte counts.
    Downloading {
        /// Bytes fetched so far.
        #[specta(type = specta_typescript::Number)]
        downloaded: u64,
        /// Total bytes, when the server reports a length.
        #[specta(type = Option<specta_typescript::Number>)]
        total: Option<u64>,
    },
    /// Verifying the SHA-256.
    Verifying,
    /// Extracting the archive.
    Extracting,
    /// Promoting the staged directory into place.
    Finalising,
    /// Complete.
    Done,
}

impl From<devx_provision::InstallStage> for InstallPhase {
    fn from(stage: devx_provision::InstallStage) -> Self {
        use devx_provision::InstallStage as S;
        match stage {
            S::ResolvingChecksum => Self::ResolvingChecksum,
            S::Downloading(progress) => Self::Downloading {
                downloaded: progress.downloaded,
                total: progress.total,
            },
            S::Verifying => Self::Verifying,
            S::Extracting => Self::Extracting,
            S::Finalising => Self::Finalising,
            S::Done => Self::Done,
        }
    }
}

/// Progress of a component installation.
///
/// One install emits a stream of these, keyed by `component_id` and `version`
/// so the UI can route them to the right row when several run at once.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct InstallProgress {
    /// Component being installed.
    pub component_id: String,
    /// Version being installed.
    pub version: String,
    /// Current phase.
    pub phase: InstallPhase,
}

/// One chunk of output from a terminal command run.
///
/// The backend streams lines as they are written instead of returning the
/// whole output at the end, so long-running commands feel live.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct TerminalOutput {
    /// Which run the line belongs to.
    pub run_id: u32,
    /// Which stream it came from: `out` or `err`.
    pub stream: String,
    /// The line text, without its newline.
    pub text: String,
}

/// A state transition of a supervised service.
///
/// Mirrors [`devx_proc::ServiceEvent`] so the frontend can update status
/// badges and log tails the moment something happens instead of waiting for
/// the next poll.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct ServiceEventUpdate {
    /// The transition.
    pub event: devx_proc::ServiceEvent,
}
