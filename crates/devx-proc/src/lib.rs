//! # devx-proc
//!
//! Process supervision for DevX.
//!
//! Every backing service (nginx, MariaDB, Redis, Mailpit, …) is a child process
//! that must start reliably, report when it is actually ready, have its output
//! captured, restart within limits when it crashes, and — above all — never
//! outlive DevX itself.
//!
//! The orphan-proofing is a Windows job object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (see [`job`]): a child assigned to the
//! job dies with the job handle, including when DevX crashes. The lifecycle
//! rules ([`state`]), log capture ([`logbuf`], [`logfile`]) and readiness checks
//! ([`health`]) are platform-independent and unit-tested on their own.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod health;
pub mod logbuf;
pub mod logfile;
pub mod registry;
pub mod state;
pub mod supervisor;

#[cfg(windows)]
pub mod job;

pub use health::HealthCheck;
pub use logbuf::{LogLine, LogRing, LogStream};
pub use registry::ServiceRegistry;
pub use state::{ExitReason, RestartPolicy, ServiceState};
pub use supervisor::{ProcessSpec, Supervisor};
