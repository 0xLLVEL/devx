//! # devx-ipc
//!
//! The wire protocol between the DevX desktop app and its privileged helper
//! service, shared by both sides so they can never drift apart.
//!
//! Requests and responses are plain JSON values framed as
//! `4-byte little-endian length + bytes` (see [`codec`]). The framing exists
//! because named pipes are a byte stream with no message boundaries; a length
//! prefix makes one request unambiguously one frame, and a hard cap rejects
//! absurd sizes before allocating.
//!
//! Everything in this crate is pure data plus pure functions: no Windows API,
//! no I/O. The pipe client lives in `devx-privileged`, the server in
//! `devx-helper`.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod codec;
pub mod protocol;

pub use codec::{read_frame, read_frame_sync, write_frame, write_frame_sync, MAX_FRAME_BYTES};
pub use protocol::{
    validate_ca_name, validate_hostname, validate_ip, validate_namespace, validate_pem_block,
    HostsEntry, PrivilegedRequest, PrivilegedResponse, PROTOCOL_VERSION,
};
