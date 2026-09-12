//! # devx-dns
//!
//! DevX's bundled DNS resolver: a small UDP server that answers `A` queries
//! for names under the configured local suffix (`.test`) with the loopback
//! address, and forwards everything else to the system's real resolvers.
//!
//! ## Why it exists
//!
//! The hosts file maps exactly the names it lists. A resolver can answer
//! `anything.myapp.test`, which is what wildcard subdomains — multi-tenant
//! apps, preview deployments — need. Windows routes `.test` queries to this
//! resolver through an NRPT rule installed by the privileged helper
//! (Task 8's pipe), while every other name keeps using the normal system
//! path, so corporate DNS and VPN setups are untouched.
//!
//! The wire format implemented here is the small, classic subset of
//! RFC 1035: single-question queries, `A` answers, no compression of
//! *outgoing* names (simple and correct; incoming names are parsed with
//! compression-pointer support because real clients send them).

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod message;
pub mod server;

pub use message::{parse_name, NameError};
pub use server::{serve, ResolverConfig, ServerHandle};
