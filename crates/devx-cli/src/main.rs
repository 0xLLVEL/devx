//! `devx` — the command-line companion to the DevX desktop app.
//!
//! The CLI manages everything that is *state on disk*: configuration, sites
//! (config plus rendered nginx blocks), installed component versions and
//! environment diagnostics. Process lifecycle stays with the desktop app,
//! because supervised children belong to the app's job objects — a `devx
//! service stop` that reached past the app would fight it over port
//! allocation and config writes, so the CLI simply does not offer that.
//!
//! Both frontends deliberately share the same on-disk contract
//! (`devx-core::ConfigStore`, `devx-provision::sites`), which keeps them
//! consistent without talking to each other.

// The CLI legitimately prints to stdout/stderr, so the console stays.

#![warn(clippy::all, missing_docs)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod cmd;

/// DevX command-line companion.
#[derive(Debug, Parser)]
#[command(name = "devx", version, about, propagate_version = true)]
struct Cli {
    /// DevX data/config root to operate on instead of the discovered one.
    ///
    /// Mirrors the `DEVX_HOME` environment variable used by the desktop app's
    /// test harness; the flag wins when both are set.
    #[arg(long, global = true)]
    home: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

/// DevX subcommands.
#[derive(Debug, Subcommand)]
enum Command {
    /// Run environment diagnostics and print the report.
    Doctor,
    /// Print the resolved DevX directory layout as JSON.
    Paths,
    /// Manage local `.test` sites (config and nginx blocks).
    Sites {
        #[command(subcommand)]
        command: SitesCommand,
    },
    /// Manage installed component versions (download and verification only).
    Install {
        /// Component id from the catalog, e.g. `php`.
        component_id: String,
        /// Version to install, e.g. `8.4.12`.
        version: String,
    },
    /// Remove an installed component version.
    Uninstall {
        /// Component id from the catalog, e.g. `php`.
        component_id: String,
        /// Version to remove, e.g. `8.4.12`.
        version: String,
    },
    /// List installed component versions.
    Installed,
}

/// Site management subcommands.
#[derive(Debug, Subcommand)]
enum SitesCommand {
    /// List configured sites as JSON.
    List,
    /// Add or replace a site and render its nginx block.
    Add {
        /// Host name to serve, e.g. `myapp.test`.
        hostname: String,
        /// Absolute path of the folder nginx serves.
        docroot: PathBuf,
        /// PHP version whose pool serves the site (omit for a static site).
        #[arg(long)]
        php: Option<String>,
        /// Also serve the site over HTTPS with the local CA's certificate.
        #[arg(long)]
        https: bool,
    },
    /// Remove a site and prune its nginx block.
    Remove {
        /// Host name of the site to remove.
        hostname: String,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("building the tokio runtime");

    match runtime.block_on(cmd::dispatch(&cli)) {
        Ok(code) => code,
        Err(err) => {
            // One honest line per failure, on stderr, nothing else: the CLI is
            // meant to be consumed by humans and scripts alike.
            eprintln!("error: {err}");
            for source in anyhow::Error::chain(&err).skip(1) {
                eprintln!("  caused by: {source}");
            }
            ExitCode::FAILURE
        }
    }
}
