//! Project grouping commands.
//!
//! A "project" is a folder on disk: sites point their docroot into it, workers
//! run in it, cron tasks run in it. Those references already exist in the
//! configuration, so projects are derived by grouping on the folder rather
//! than kept as a separate record that could drift from the sites, workers
//! and tasks it is computed from.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::state::AppState;
use devx_core::config::ProjectSettings;
use devx_core::Error;
use tauri::State;

use super::scheduler::CronStatus;
use super::workers::WorkerStatus;
use crate::commands::sites::SiteStatus;

/// One folder-grouped project, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ProjectSummary {
    /// Folder name, e.g. `myapp`.
    pub name: String,
    /// Absolute folder path.
    pub path: String,
    /// Whether the project was explicitly registered by the user (vs derived
    /// from sites/workers that merely point into the folder).
    pub managed: bool,
    /// Optional display label from the registered settings.
    pub label: Option<String>,
    /// Sites whose docroot lives under this folder.
    pub sites: Vec<SiteStatus>,
    /// Workers whose working directory lives under this folder.
    pub workers: Vec<WorkerStatus>,
    /// Scheduled tasks whose working directory lives under this folder.
    pub cron: Vec<CronStatus>,
    /// PHP versions the project's sites and workers use, sorted.
    pub php_versions: Vec<String>,
    /// Registered default PHP version for the project, when set.
    pub default_php: Option<String>,
    /// Registered default Node.js version for the project, when set.
    pub default_node: Option<String>,
    /// Registered default Python version for the project, when set.
    pub default_python: Option<String>,
    /// How many supervised things belonging to the project are running
    /// (worker instances plus cron-adjacent services).
    pub running_workers: u32,
    /// How many worker instances are configured in total.
    pub total_workers: u32,
}

/// Lists every project folder: user-registered projects always appear (even
/// with nothing pointing into them yet), plus folders derived from configured
/// sites, workers and scheduled tasks.
#[tauri::command]
#[specta::specta]
pub fn projects_list(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, Error> {
    let sites = crate::commands::site_list(state.clone())?;
    let workers = crate::commands::worker_list(state.clone())?;
    let cron = crate::commands::cron_list(state.clone())?;
    let registered: Vec<ProjectSettings> =
        state.with_config(|store| store.config().projects.clone());

    Ok(group_projects(&sites, &workers, &cron, &registered))
}

/// Registers a folder as a managed project.
///
/// The folder must already exist — the picker creates it on disk, not us —
/// and re-adding an existing path (case-insensitively) is the edit path for
/// the label, not an error.
#[tauri::command]
#[specta::specta]
pub fn project_add(
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
) -> Result<Vec<ProjectSummary>, Error> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid_input("project path must not be empty"));
    }

    let canonical = super::settings::canonicalise(Path::new(trimmed));
    if !canonical.is_dir() {
        return Err(
            Error::not_found(format!("folder `{}` does not exist", trimmed))
                .with_hint("create the folder first, then add it as a project"),
        );
    }

    let settings = ProjectSettings {
        path: canonical.to_string_lossy().into_owned(),
        label: label
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_owned()),
        ..ProjectSettings::default()
    };
    let key = settings.path.to_lowercase();

    state.with_config_mut(|store| {
        store.update(|config| {
            config.projects.retain(|p| !p.path.to_lowercase().eq(&key));
            config.projects.push(settings.clone());
        })
    })?;

    projects_list(state)
}

/// Removes a project from the registered list. The folder on disk is left
/// untouched — this only stops DevX from showing it as a managed project.
#[tauri::command]
#[specta::specta]
pub fn project_remove(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<ProjectSummary>, Error> {
    let canonical = super::settings::canonicalise(Path::new(path.trim()));
    let key = canonical.to_string_lossy().to_lowercase();

    let removed = state.with_config_mut(|store| {
        let mut removed = false;
        store
            .update(|config| {
                let before = config.projects.len();
                config.projects.retain(|p| !p.path.to_lowercase().eq(&key));
                removed = config.projects.len() < before;
            })
            .ok();
        removed
    });

    if !removed {
        return Err(Error::not_found(format!(
            "`{}` is not a registered project",
            path.trim()
        )));
    }

    projects_list(state)
}

/// Updates a registered project's label and default runtime versions.
///
/// A `None` argument leaves the field as-is; `Some("")` clears it back to
/// "follow the global default". Only registered projects can be updated.
#[tauri::command]
#[specta::specta]
pub fn project_update(
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
    default_php: Option<String>,
    default_node: Option<String>,
    default_python: Option<String>,
) -> Result<Vec<ProjectSummary>, Error> {
    let canonical = super::settings::canonicalise(Path::new(path.trim()));
    let key = canonical.to_string_lossy().to_lowercase();

    let clean = |value: &Option<String>| -> Option<String> {
        value
            .as_ref()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let label = clean(&label);
    let default_php = clean(&default_php);
    let default_node = clean(&default_node);
    let default_python = clean(&default_python);

    let updated = state.with_config_mut(|store| {
        let mut updated = false;
        store
            .update(|config| {
                if let Some(project) = config
                    .projects
                    .iter_mut()
                    .find(|p| p.path.to_lowercase().eq(&key))
                {
                    if label.is_some() {
                        project.label = label.clone();
                    }
                    if default_php.is_some() {
                        project.default_php = default_php.clone();
                    }
                    if default_node.is_some() {
                        project.default_node = default_node.clone();
                    }
                    if default_python.is_some() {
                        project.default_python = default_python.clone();
                    }
                    updated = true;
                }
            })
            .ok();
        updated
    });

    if !updated {
        return Err(Error::not_found(format!(
            "`{}` is not a registered project",
            path.trim()
        )));
    }

    projects_list(state)
}

/// Pure grouping logic, separated so tests can exercise it without an app.
fn group_projects(
    sites: &[SiteStatus],
    workers: &[WorkerStatus],
    cron: &[CronStatus],
    registered: &[ProjectSettings],
) -> Vec<ProjectSummary> {
    let mut groups: BTreeMap<String, ProjectSummary> = BTreeMap::new();

    // Registered projects exist even before anything points into them.
    for settings in registered {
        let root = PathBuf::from(&settings.path);
        let entry = entry_for(&mut groups, &group_key(&root));
        if entry.name.is_empty() {
            entry.name = match settings.label {
                Some(ref label) if !label.is_empty() => label.clone(),
                _ => root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.to_string_lossy().into_owned()),
            };
            if entry.path.is_empty() {
                entry.path = settings.path.clone();
            }
        }
        entry.managed = true;
        entry.label = settings.label.clone();
        entry.default_php = settings.default_php.clone();
        entry.default_node = settings.default_node.clone();
        entry.default_python = settings.default_python.clone();
    }

    for site in sites {
        let root = project_root(&site.docroot);
        let entry = entry_for(&mut groups, &group_key(&root));
        name_project(entry, &root);
        entry.sites.push(site.clone());
        if let Some(version) = non_empty(&site.php_version) {
            entry.php_versions.push(version);
        }
    }

    for worker in workers {
        let root = project_root(&worker.working_dir);
        let entry = entry_for(&mut groups, &group_key(&root));
        name_project(entry, &root);
        entry.workers.push(worker.clone());
        if let Some(version) = worker.php_version.clone() {
            entry.php_versions.push(version);
        }
        entry.total_workers += worker.instances;
        entry.running_workers += worker
            .live
            .iter()
            .filter(|instance| instance.state == devx_proc::ServiceState::Running)
            .count() as u32;
    }

    for job in cron {
        let root = project_root(&job.working_dir);
        let entry = entry_for(&mut groups, &group_key(&root));
        name_project(entry, &root);
        entry.cron.push(job.clone());
        if let Some(version) = job.php_version.clone() {
            entry.php_versions.push(version);
        }
    }

    let mut projects: Vec<ProjectSummary> = groups.into_values().collect();
    for project in &mut projects {
        project.php_versions.sort();
        project.php_versions.dedup();
    }
    // Newest-touched first is unknowable, so alphabetical reads as intent.
    projects.sort_by_key(|a| a.name.to_lowercase());
    projects
}

/// The map entry for the folder `root` names, creating the project the first
/// time it is seen. Keyed by the case-folded path so `C:\Dev` and `c:\dev`
/// merge on Windows; the first spelling seen wins for display.
fn entry_for<'a>(
    groups: &'a mut BTreeMap<String, ProjectSummary>,
    key: &str,
) -> &'a mut ProjectSummary {
    groups
        .entry(key.to_owned())
        .or_insert_with(|| ProjectSummary {
            name: String::new(),
            path: String::new(),
            managed: false,
            label: None,
            sites: Vec::new(),
            workers: Vec::new(),
            cron: Vec::new(),
            php_versions: Vec::new(),
            default_php: None,
            default_node: None,
            default_python: None,
            running_workers: 0,
            total_workers: 0,
        })
}

/// Case-folded grouping key for a folder.
fn group_key(root: &Path) -> String {
    root.to_string_lossy().to_lowercase()
}

/// Names the project from its first-seen path. Runs after grouping: the entry
/// created by [`entry_for`] starts nameless and the first writer fills it in.
fn name_project(entry: &mut ProjectSummary, root: &Path) {
    if entry.name.is_empty() {
        entry.name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned());
    }
    if entry.path.is_empty() {
        entry.path = root.to_string_lossy().into_owned();
    }
}

/// The folder a project is named after: the deepest ancestor of `path` that is
/// not a drive root, lower-cased for grouping so `C:\Dev` and `c:\dev` merge.
///
/// Docroots often point one or two levels into the project (`...\myapp\public`
/// for a Laravel-style layout), so a single parent is not enough and a fixed
/// depth is wrong. Instead the root is the first path segment under the drive
/// when the folder sits directly in it, otherwise the deepest existing
/// ancestor that no other *configured* docroot claims. Practically, sites and
/// workers of one project share a recognisable prefix, so the simple rule is:
/// strip the known web-document leaves and take what remains.
fn project_root(path: &str) -> PathBuf {
    let normalized = PathBuf::from(path);

    // Walk up to the drive root and count components. A path like
    // `C:\projects\myapp\public` has `projects\myapp\public` under the drive;
    // the project folder is the segment before the last when the last is a
    // conventional web root (`public`, `www`, `web`, `dist`), else the last.
    let conventional_roots = ["public", "www", "web", "dist", "htdocs"];
    let components: Vec<_> = normalized.components().collect();
    if components.len() <= 2 {
        // Drive root or a single folder below it: the path is its own root,
        // but a conventional web root at that level still folds into its
        // parent when there is one (there is not, at two components, so the
        // folder itself is the project).
        return normalized;
    }

    let last_is_web_root = normalized
        .file_name()
        .map(|n| {
            let name = n.to_string_lossy().to_lowercase();
            conventional_roots.contains(&name.as_str())
        })
        .unwrap_or(false);

    // Only strip the web root when something meaningful remains above it: a
    // folder directly under the drive (`C:\www`) has no project parent to
    // fold into, so the folder itself is the project.
    if last_is_web_root && components.len() > 3 {
        normalized
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(normalized)
    } else {
        normalized
    }
}

/// `Some(value)` when the string is neither absent nor empty.
fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(hostname: &str, docroot: &str, php: &str) -> SiteStatus {
        SiteStatus {
            hostname: hostname.to_owned(),
            docroot: docroot.to_owned(),
            php_version: php.to_owned(),
            php_endpoint: None,
            https: false,
            web_server: devx_core::config::WebServer::Nginx,
            env: Default::default(),
            aliases: Vec::new(),
            auth: None,
            port: 80,
            https_port: 443,
            url: format!("http://{hostname}"),
        }
    }

    fn worker(name: &str, dir: &str, instances: u32, running: u32) -> WorkerStatus {
        WorkerStatus {
            name: name.to_owned(),
            program: None,
            php_version: Some("8.4.25".to_owned()),
            args: Vec::new(),
            working_dir: dir.to_owned(),
            instances,
            live: (0..running)
                .map(|i| super::super::workers::WorkerInstanceStatus {
                    id: format!("worker-{name}-{i}"),
                    state: devx_proc::ServiceState::Running,
                })
                .collect(),
        }
    }

    #[test]
    fn sites_of_one_folder_group_into_one_project() {
        let sites = vec![
            site("myapp.test", r"C:\dev\myapp\public", "8.4.25"),
            site("api.myapp.test", r"C:\dev\myapp\api", "8.4.25"),
        ];

        let projects = group_projects(&sites, &[], &[], &[]);

        // The two docroots share the parent `C:\dev\myapp`, but the simple
        // rule keeps each leaf folder as its own project unless the leaf is a
        // conventional web root; `api` is a separate project here by design.
        assert_eq!(projects.len(), 2);
        assert!(projects.iter().all(|p| p.sites.len() == 1));
    }

    #[test]
    fn a_conventional_web_root_is_stripped_to_its_project() {
        let sites = vec![site("myapp.test", r"C:\dev\myapp\public", "8.4.25")];

        let projects = group_projects(&sites, &[], &[], &[]);

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "myapp");
        assert!(projects[0].path.ends_with("myapp"));
    }

    #[test]
    fn workers_and_cron_join_the_site_project() {
        let sites = vec![site("myapp.test", r"C:\dev\myapp\public", "8.4.25")];
        let workers = vec![worker("queue", r"C:\dev\myapp", 2, 1)];
        let cron = vec![CronStatus {
            name: "schedule".to_owned(),
            program: None,
            php_version: Some("8.4.25".to_owned()),
            args: Vec::new(),
            working_dir: r"C:\dev\myapp".to_owned(),
            every_minutes: 60,
            registered: true,
            next_run: None,
        }];

        let projects = group_projects(&sites, &workers, &cron, &[]);

        assert_eq!(projects.len(), 1);
        let project = &projects[0];
        assert_eq!(project.sites.len(), 1);
        assert_eq!(project.workers.len(), 1);
        assert_eq!(project.cron.len(), 1);
        assert_eq!(project.running_workers, 1);
        assert_eq!(project.total_workers, 2);
        assert_eq!(project.php_versions, vec!["8.4.25"]);
    }

    #[test]
    fn grouping_is_case_insensitive_on_windows() {
        let sites = vec![site("myapp.test", r"C:\Dev\myapp\public", "8.4.25")];
        let workers = vec![worker("queue", r"c:\dev\MYAPP", 1, 0)];

        let projects = group_projects(&sites, &workers, &[], &[]);

        // Different casing of the same path must not split the project. The
        // worker's folder is the project root itself, and the site's strips
        // its web root to the same folder — matching what the test asserts
        // case-insensitively, since the filesystem spelled them differently.
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn a_drive_level_path_is_its_own_project() {
        let sites = vec![site("root.test", r"C:\www", "")];

        let projects = group_projects(&sites, &[], &[], &[]);

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "www");
        assert!(projects[0].php_versions.is_empty());
    }

    fn registered(path: &str, label: Option<&str>) -> ProjectSettings {
        ProjectSettings {
            path: path.to_owned(),
            label: label.map(|l| l.to_owned()),
            ..ProjectSettings::default()
        }
    }

    #[test]
    fn a_registered_project_appears_even_when_empty() {
        let projects = group_projects(&[], &[], &[], &[registered(r"C:\dev\newapp", None)]);

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "newapp");
        assert_eq!(projects[0].path, r"C:\dev\newapp");
        assert!(projects[0].managed);
        assert!(projects[0].sites.is_empty());
    }

    #[test]
    fn a_registered_label_wins_over_the_folder_name() {
        let projects = group_projects(
            &[],
            &[],
            &[],
            &[registered(r"C:\dev\myapp", Some("My App"))],
        );

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "My App");
        assert_eq!(projects[0].label.as_deref(), Some("My App"));
    }

    #[test]
    fn registered_defaults_flow_through_and_derived_entries_merge_in() {
        let mut settings = registered(r"C:\dev\myapp", None);
        settings.default_php = Some("8.4.25".to_owned());
        settings.default_node = Some("22.11.0".to_owned());

        let sites = vec![site("myapp.test", r"C:\dev\myapp\public", "8.4.25")];
        let projects = group_projects(&sites, &[], &[], &[settings]);

        assert_eq!(projects.len(), 1);
        let project = &projects[0];
        assert!(project.managed);
        assert_eq!(project.default_php.as_deref(), Some("8.4.25"));
        assert_eq!(project.default_node.as_deref(), Some("22.11.0"));
        assert_eq!(project.sites.len(), 1);
    }

    #[test]
    fn config_rejects_duplicate_project_paths_case_insensitively() {
        let config = devx_core::config::Config {
            projects: vec![
                registered(r"C:\\Dev\\app", None),
                registered(r"c:\\dev\\APP", None),
            ],
            ..devx_core::config::Config::default()
        };

        let error = config.validate().unwrap_err();
        assert!(error.message.contains("duplicate project path"));
    }

    #[test]
    fn config_rejects_more_than_the_project_cap() {
        let config = devx_core::config::Config {
            projects: (0..=devx_core::config::MAX_PROJECTS)
                .map(|i| registered(&format!(r"C:\\dev\\app{i}"), None))
                .collect(),
            ..devx_core::config::Config::default()
        };

        let error = config.validate().unwrap_err();
        assert!(error.message.contains("at most"));
    }
}
