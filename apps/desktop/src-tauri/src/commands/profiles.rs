//! Named configuration profiles: point-in-time snapshots of the whole
//! configuration that the user can apply later.
//!
//! A profile is a full, validated TOML document stored under
//! `config/profiles/<name>.toml`. Applying one runs the same
//! parse-migrate-validate path as an import, so a profile can never put the
//! running configuration into an invalid state. Profiles are explicit
//! snapshots only — DevX never writes the live config into a profile
//! implicitly, and deleting or applying one never touches another.

use crate::state::AppState;
use devx_core::{AppPaths, Config, Error};
use tauri::State;

/// One saved configuration profile.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ProfileEntry {
    /// Profile name, also the file stem on disk.
    pub name: String,
    /// Last modification as Unix seconds; `null` when unavailable.
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_unix: Option<u64>,
}

/// Lists the saved profiles, alphabetically.
#[tauri::command]
#[specta::specta]
pub fn profile_list(state: State<'_, AppState>) -> Result<Vec<ProfileEntry>, Error> {
    let dir = profiles_dir(&state.paths);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut profiles = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = file_name.strip_suffix(".toml") else {
            continue;
        };
        if !valid_profile_name(name) {
            continue;
        }
        let metadata = entry.metadata().ok();
        let modified_unix = metadata.and_then(|m| m.modified().ok()).and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        });
        profiles.push(ProfileEntry {
            name: name.to_string(),
            modified_unix,
        });
    }

    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

/// Saves the current configuration as a named profile, overwriting an
/// existing profile of the same name on purpose.
#[tauri::command]
#[specta::specta]
pub fn profile_save(state: State<'_, AppState>, name: String) -> Result<Vec<ProfileEntry>, Error> {
    if !valid_profile_name(&name) {
        return Err(Error::invalid_input(
            "profile names may only contain letters, digits, dashes and underscores",
        ));
    }

    let config = state.with_config(|store| store.config().clone());
    let body = devx_core::serialize_config(&config)?;

    let dir = profiles_dir(&state.paths);
    std::fs::create_dir_all(&dir).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to create {}: {err}", dir.display()),
        )
    })?;
    devx_core::fsx::write_atomic(dir.join(format!("{name}.toml")), body)?;

    profile_list(state)
}

/// Applies a profile: validates it first, then replaces the running
/// configuration. Services pick the change up through their normal
/// re-plan paths, exactly as after an import.
#[tauri::command]
#[specta::specta]
pub fn profile_apply(state: State<'_, AppState>, name: String) -> Result<Config, Error> {
    if !valid_profile_name(&name) {
        return Err(Error::invalid_input("unknown profile name"));
    }
    let path = profiles_dir(&state.paths).join(format!("{name}.toml"));
    let body = std::fs::read_to_string(&path)
        .map_err(|_| Error::not_found(format!("profile `{name}` does not exist")))?;

    let imported = devx_core::parse_config(&body)?;

    state.with_config_mut(|store| store.replace(imported))?;
    state.mark_config_healthy();

    Ok(state.with_config(|store| store.config().clone()))
}

/// Deletes a saved profile. The running configuration is untouched.
#[tauri::command]
#[specta::specta]
pub fn profile_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<ProfileEntry>, Error> {
    if !valid_profile_name(&name) {
        return Err(Error::invalid_input("unknown profile name"));
    }
    let path = profiles_dir(&state.paths).join(format!("{name}.toml"));
    // A missing file is already the desired state.
    let _ = std::fs::remove_file(&path);

    profile_list(state)
}

/// The directory holding saved profiles.
fn profiles_dir(paths: &AppPaths) -> std::path::PathBuf {
    paths.config_dir.join("profiles")
}

/// Profile names become file names: keep them filename-safe and short.
fn valid_profile_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_names_reject_traversal_and_junk() {
        assert!(valid_profile_name("clean-setup"));
        assert!(valid_profile_name("Client_A_2"));
        assert!(!valid_profile_name(""));
        assert!(!valid_profile_name("../escape"));
        assert!(!valid_profile_name("has space"));
        assert!(!valid_profile_name("dot.toml"));
        assert!(!valid_profile_name(&"x".repeat(65)));
    }
}
