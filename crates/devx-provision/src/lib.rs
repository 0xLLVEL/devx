//! # devx-provision
//!
//! Everything between "the user wants PHP 8.4" and "PHP 8.4 is installed and
//! verified": the component catalog, version resolution against upstream
//! metadata, and downloading, verifying, extracting and installing artifacts.
//!
//! Two rules hold throughout:
//!
//! 1. **Nothing is installed without a checksum.** A version whose hash cannot
//!    be obtained from the upstream is not offered, and the download pipeline
//!    refuses to extract an archive whose SHA-256 does not match.
//! 2. **Metadata failures degrade, they do not break.** Version lists come from
//!    a revalidating disk cache so a flaky network or a rate-limited API shows
//!    slightly stale data instead of an empty screen.
//!
//! Installs are atomic: work happens in a staging directory that is renamed into
//! `runtimes/<component>/<version>/` only once complete, so a half-installed
//! runtime can never be observed.

#![deny(missing_docs)]
#![warn(clippy::all)]

pub mod catalog;
pub mod download;
pub mod extract;
pub mod http;
pub mod install;
pub mod php_pool;
pub mod pki;
pub mod ports;
pub mod resolver;
pub mod service;
pub mod service_defs;
pub mod sites;
pub mod tunnel;
pub mod verify;
pub mod version;
pub mod worker;

pub use catalog::{Catalog, Component, ComponentKind, ComponentSummary, Layout, Source};
pub use download::{DownloadOptions, Downloader, Progress};
pub use http::HttpClient;
pub use install::{InstallStage, Installer};
pub use php_pool::{
    is_pool_id, list_php_extensions, plan_pool, pool_id, pool_listen_addr, validate_workers,
    version_of_pool, write_pool_files, PhpPoolPlan, PhpPoolSummary, PoolPlanOptions,
    DEFAULT_WORKERS, FIRST_POOL_PORT, MAX_WORKERS,
};
pub use pki::{
    ensure_ca, ensure_site_cert, load_ca, tls_listen_snippet, CertificateFiles, LocalCa,
    CA_FRIENDLY_NAME,
};
pub use ports::{PortAllocator, PortDecision};
pub use resolver::{Endpoints, Resolver, VersionListing};
pub use service::{LaunchPlan, Readiness, RenderContext, ServiceDefinition};
pub use service_defs::{definition_for, is_service, service_ids};
pub use sites::{
    pool_endpoint_for, prune_stale_blocks, remove_site_block, render_server_block, validate_spec,
    write_site_block, SiteSpec, SiteSyncReport,
};
pub use version::{Artifact, Checksum, ComponentVersion, ReleaseChannel};
pub use worker::{is_worker_id, plan_worker, plan_worker_instances, worker_id, WorkerPlan};
