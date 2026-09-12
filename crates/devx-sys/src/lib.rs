//! # devx-sys
//!
//! Unprivileged Windows system probes used by DevX: WebView2 detection, volume
//! free space and write-access checks.
//!
//! Everything here runs as the signed-in user. Operations that need elevation
//! (hosts file, certificate store, NRPT, service control) live in
//! `devx-privileged` and are executed by the helper service.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod ports;
pub mod probe;

pub use ports::{listening_ports, owner_of, PortOwner};
pub use probe::WindowsProbe;
