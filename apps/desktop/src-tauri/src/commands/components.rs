//! Component catalog and install pipeline commands.

use crate::events::{InstallPhase, InstallProgress};
use crate::state::AppState;
use devx_core::Error;
use devx_provision::{ComponentSummary, VersionListing};
use tauri::State;
use tauri_specta::Event as _;

/// A version of a component that is installed on disk.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct InstalledVersion {
    /// Component identifier.
    pub component_id: String,
    /// Installed version string.
    pub version: String,
    /// Absolute install directory.
    pub path: String,
}

/// Lists the components DevX can install.
#[tauri::command]
#[specta::specta]
pub fn catalog_list(state: State<'_, AppState>) -> Result<Vec<ComponentSummary>, Error> {
    Ok(state
        .catalog
        .components
        .iter()
        .map(ComponentSummary::from)
        .collect())
}

/// Lists the installable versions of one component.
///
/// Hits the component's upstream through a revalidating cache, so repeated calls
/// are cheap and a network failure returns the last known list marked stale
/// rather than an error.
#[tauri::command]
#[specta::specta]
pub async fn component_versions(
    state: State<'_, AppState>,
    component_id: String,
) -> Result<VersionListing, Error> {
    let component = state.catalog.component(&component_id)?.clone();
    state.resolver.list_versions(&component).await
}

/// Installs a component version, emitting [`InstallProgress`] events.
///
/// Returns the install directory on success. Progress is delivered through
/// events keyed by component and version so the UI can update the right row.
#[tauri::command]
#[specta::specta]
pub async fn component_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<String, Error> {
    let component = state.catalog.component(&component_id)?.clone();
    let listing = state.resolver.list_versions(&component).await?;

    let target = listing
        .versions
        .into_iter()
        .find(|candidate| candidate.version == version)
        .ok_or_else(|| {
            Error::not_found(format!(
                "{component_id} {version} is not an available version"
            ))
        })?;

    let emit_id = component_id.clone();
    let emit_version = version.clone();
    let install_dir = state
        .installer
        .install(&target, &component.layout, move |stage| {
            // A failed emit only costs a progress update, never the install.
            let _ = InstallProgress {
                component_id: emit_id.clone(),
                version: emit_version.clone(),
                phase: InstallPhase::from(stage),
            }
            .emit(&app);
        })
        .await?;

    Ok(install_dir.to_string_lossy().into_owned())
}

/// Removes an installed component version.
#[tauri::command]
#[specta::specta]
pub fn component_uninstall(
    state: State<'_, AppState>,
    component_id: String,
    version: String,
) -> Result<(), Error> {
    state.installer.uninstall(&component_id, &version)
}

/// Lists the component ids that DevX can supervise as background services.
#[tauri::command]
#[specta::specta]
pub fn service_component_ids() -> Result<Vec<String>, Error> {
    Ok(devx_provision::service_ids()
        .into_iter()
        .map(str::to_owned)
        .collect())
}

/// Lists every installed component version found on disk.
#[tauri::command]
#[specta::specta]
pub fn installed_versions(state: State<'_, AppState>) -> Result<Vec<InstalledVersion>, Error> {
    let mut installed = Vec::new();
    let runtimes = state.paths.runtimes_dir();

    let Ok(components) = std::fs::read_dir(&runtimes) else {
        // No runtimes directory yet means nothing is installed.
        return Ok(installed);
    };

    for component in components.flatten() {
        if !component.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let component_id = component.file_name().to_string_lossy().into_owned();

        let Ok(versions) = std::fs::read_dir(component.path()) else {
            continue;
        };
        for version in versions.flatten() {
            let version_str = version.file_name().to_string_lossy().into_owned();
            if state.installer.is_installed(&component_id, &version_str) {
                installed.push(InstalledVersion {
                    component_id: component_id.clone(),
                    version: version_str,
                    path: version.path().to_string_lossy().into_owned(),
                });
            }
        }
    }

    Ok(installed)
}
