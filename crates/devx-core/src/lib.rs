//! # devx-core
//!
//! Domain model, configuration and orchestration for DevX, a developer
//! environment manager for Windows.
//!
//! This crate holds no Tauri or Windows API dependencies so the domain logic
//! stays unit-testable: platform probing lives in `devx-sys`, privileged
//! operations in `devx-privileged`, process supervision in `devx-proc`, and the
//! UI shell in `apps/desktop/src-tauri`.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod config;
pub mod doctor;
pub mod error;
pub mod fsx;
pub mod meta;
pub mod paths;

pub use config::{Config, ConfigStore, DnsMode, PhpPools, Site, Theme, CURRENT_SCHEMA_VERSION};
pub use doctor::{Check, CheckStatus, ConfigHealth, DoctorReport, SystemProbe};
pub use error::{Error, ErrorCode, Result};
pub use meta::AppInfo;
pub use paths::AppPaths;
