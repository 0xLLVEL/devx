//! Tauri commands exposed to the DevX frontend.
//
//! Every command is annotated with `#[specta::specta]` so that `tauri-specta`
//! can generate the TypeScript client in `src/bindings.ts`. Never call `invoke`
//! by hand from the frontend: use the generated client so renames break the
//! build instead of failing at runtime.
//
//! The commands live in per-domain modules under `commands/`; this module
//! re-exports them so the `crate::commands::*` paths (and the specta
//! registry) are unchanged.

pub mod components;
pub mod core;
pub mod databases;
pub mod dns;
pub mod hosts;
pub mod logs;
pub mod mail;
pub mod notifications;
pub mod php;
pub mod pki;
pub mod profiles;
pub mod resources;
pub mod scheduler;
pub mod services;
pub mod settings;
pub mod share;
pub mod sites;
pub mod templates;
pub mod workers;

// Re-exports so `commands::app_info` style paths keep resolving.
pub use components::*;
pub use core::*;
pub use databases::*;
pub use dns::*;
pub use hosts::*;
pub use logs::*;
pub use mail::*;
pub use notifications::*;
pub use php::*;
pub use pki::*;
pub use profiles::*;
pub use resources::*;
pub use scheduler::*;
pub use services::*;
pub use settings::*;
#[allow(unused_imports)]
pub use share::*;
pub use sites::*;
pub use templates::*;
pub use workers::*;
