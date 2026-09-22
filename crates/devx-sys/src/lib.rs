//! # devx-sys
//!
//! Unprivileged Windows system probes used by DevX: WebView2 detection, volume
//! free space and write-access checks. It also owns the one process operation
//! the UI performs on a process DevX did not start (see [`process`]).
//!
//! Everything here runs as the signed-in user. Operations that need elevation
//! (hosts file, certificate store, NRPT, service control) live in
//! `devx-privileged` and are executed by the helper service.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod ports;
pub mod probe;
pub mod process;

pub use ports::{listening_ports, owner_of, try_listening_ports, PortOwner};
pub use probe::{taskbar_uses_light_theme, WindowsProbe};
