//! Site template scaffolding commands.

use super::sites::site_add;
use crate::state::AppState;
use devx_core::Error;
use tauri::State;

/// One scaffoldable site template, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TemplateInfo {
    /// Template identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// What the template sets up.
    pub description: String,
    /// Whether the files are generated locally, without downloading.
    pub local: bool,
}

/// Lists the site templates DevX can scaffold.
///
/// Templates follow the catalog's integrity policy: anything needing a
/// download without an obtainable checksum (WordPress publishes none for its
/// zip; Laravel scaffolds through composer) is not offered as a download —
/// the template only carries the suggested terminal command.
#[tauri::command]
#[specta::specta]
pub fn template_list() -> Result<Vec<TemplateInfo>, Error> {
    Ok(vec![
        TemplateInfo {
            id: "static".into(),
            name: "Static site".into(),
            description: "A single index.html page served as-is.".into(),
            local: true,
        },
        TemplateInfo {
            id: "php".into(),
            name: "PHP site".into(),
            description: "An index.php stub so the FastCGI pool has something to serve.".into(),
            local: true,
        },
        TemplateInfo {
            id: "wordpress".into(),
            name: "WordPress".into(),
            description: "Suggested terminal command; the upstream zip has no verifiable checksum, so DevX does not download it.".into(),
            local: false,
        },
        TemplateInfo {
            id: "laravel".into(),
            name: "Laravel".into(),
            description: "Suggested terminal command; scaffolding runs through composer and the PHP pool.".into(),
            local: false,
        },
        TemplateInfo {
            id: "git".into(),
            name: "Clone a Git repository".into(),
            description: "Clones a repository (git must be on PATH) into the docroot, then serves it.".into(),
            local: false,
        },
    ])
}

/// The suggested terminal command for templates DevX will not download.
fn template_command(template_id: &str) -> Option<String> {
    match template_id {
        "wordpress" => Some(
            "curl -L -o wordpress.zip https://wordpress.org/latest.zip && tar -xf wordpress.zip && move wordpress\\* . && del wordpress.zip"
                .to_owned(),
        ),
        "laravel" => Some("composer create-project laravel/laravel .".to_owned()),
        _ => None,
    }
}

/// The result of scaffolding a site from a template.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TemplateCreateResult {
    /// The site that was created.
    pub hostname: String,
    /// The suggested terminal command, when the template delegates to one.
    pub follow_up_command: Option<String>,
}

/// Scaffolds `template_id` into `docroot` and creates the site.
///
/// Local templates write their files into the (created) docroot and never
/// overwrite existing content; download-based templates only create the
/// folder and return their suggested command, to be run in the Terminal.
/// The `git` template clones `git_url` with the system git before the site
/// is registered, so the docroot already holds real content.
#[tauri::command]
#[specta::specta]
pub async fn template_create(
    state: State<'_, AppState>,
    template_id: String,
    hostname: String,
    docroot: String,
    php_version: String,
    https: bool,
    git_url: Option<String>,
) -> Result<TemplateCreateResult, Error> {
    let docroot_path = std::path::PathBuf::from(&docroot);
    if !docroot_path.is_absolute() {
        return Err(Error::invalid_input(format!(
            "`{docroot}` must be an absolute path"
        )));
    }
    if docroot_path.is_file() {
        return Err(Error::invalid_input(format!(
            "`{docroot}` is a file, not a directory"
        )));
    }

    let not_empty = docroot_path
        .is_dir()
        .then(|| std::fs::read_dir(&docroot_path).ok())
        .flatten()
        .and_then(|mut entries| entries.next().map(|_| ()))
        .is_some();
    if not_empty && template_id != "git" {
        return Err(Error::conflict(format!(
            "`{docroot}` already exists and is not empty"
        )));
    }

    let follow_up_command = template_command(&template_id);
    match template_id.as_str() {
        "static" | "php" | "wordpress" | "laravel" => {
            std::fs::create_dir_all(&docroot_path).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to create {}: {err}", docroot_path.display()),
                )
            })?;
        }
        "git" => {
            // The docroot parent must exist; git creates the clone directory
            // itself, and the site points at the repo's document root.
            let url = git_url.as_deref().map(str::trim).filter(|u| !u.is_empty())
                .ok_or_else(|| {
                    Error::invalid_input("the git template needs a repository URL")
                })?;
            if docroot_path.exists() {
                return Err(Error::conflict(format!(
                    "`{docroot}` already exists; git clone needs a fresh directory"
                )));
            }
            std::fs::create_dir_all(docroot_path.parent().unwrap_or(&docroot_path))
                .map_err(|err| {
                    Error::new(
                        devx_core::ErrorCode::Io,
                        format!("failed to create {}: {err}", docroot_path.display()),
                    )
                })?;

            let output = tokio::process::Command::new("git")
                .args(["clone", "--depth", "1", url])
                .arg(&docroot_path)
                .output()
                .await
                .map_err(|err| {
                    Error::new(
                        devx_core::ErrorCode::Process,
                        format!("git is not available: {err}"),
                    )
                    .with_hint("install git and make sure it is on PATH")
                })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(Error::new(
                    devx_core::ErrorCode::Process,
                    format!("git clone failed: {}", stderr.trim()),
                ));
            }
        }
        other => {
            return Err(Error::invalid_input(format!("unknown template `{other}`")));
        }
    }

    match template_id.as_str() {
        "static" => {
            let body = concat!(
                "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n",
                "  <title>New site</title>\n</head>\n<body>\n  <h1>New site</h1>\n",
                "  <p>Scaffolded by DevX. Replace this page with your own.</p>\n",
                "</body>\n</html>\n"
            );
            devx_core::fsx::write_atomic(docroot_path.join("index.html"), body)?;
        }
        "php" => {
            let body = concat!(
                "<?php\ndeclare(strict_types=1);\n\n",
                "echo 'New PHP site scaffolded by DevX.';\n"
            );
            devx_core::fsx::write_atomic(docroot_path.join("index.php"), body)?;
        }
        _ => {
            // Download-based templates leave the folder to the suggested command.
        }
    }

    // Reuse the site_add machinery: validate, persist, sync the block.
    let statuses =
        site_add(state, hostname.clone(), docroot, php_version, https, None).await?;

    let Some(created) = statuses
        .iter()
        .find(|site| site.hostname.eq_ignore_ascii_case(&hostname))
    else {
        return Err(Error::internal("the site was not created"));
    };
    tracing::info!(
        hostname = %created.hostname,
        template = %template_id,
        "site scaffolded from template"
    );

    Ok(TemplateCreateResult {
        hostname: created.hostname.clone(),
        follow_up_command,
    })
}
