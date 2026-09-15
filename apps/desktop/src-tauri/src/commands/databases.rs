//! Database browser, backup and restore commands.

use devx_core::{AppPaths, Error};
use tauri::State;

use super::sites::newest_installed_component;
use crate::state::AppState;

/// A connectable database server, as the UI's connection picker sees it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct DbServer {
    /// Engine behind the service.
    pub engine: devx_db::Engine,
    /// Service id (`mariadb`, `postgresql`, `redis`).
    pub service_id: String,
    /// Host the service binds.
    pub host: String,
    /// Port from the service's allocation.
    pub port: u16,
    /// Whether a TCP connection to the port succeeds right now.
    pub reachable: bool,
}

/// Lists the database servers DevX supervises and their reachability.
///
/// Ports come from each service's rendered state where available, falling
/// back to the definition's default port, so this works before first start
/// (unreachable) and after restarts (reassigned ports picked up live).
#[tauri::command]
#[specta::specta]
pub fn db_list_servers(state: State<'_, AppState>) -> Result<Vec<DbServer>, Error> {
    const DATABASE_SERVICES: &[(&str, devx_db::Engine)] = &[
        ("mariadb", devx_db::Engine::MariaDb),
        ("postgresql", devx_db::Engine::PostgreSql),
        ("redis", devx_db::Engine::Redis),
    ];

    let mut servers = Vec::new();
    for (service_id, engine) in DATABASE_SERVICES {
        let registry = &state.services;
        let default_port = match engine {
            devx_db::Engine::MariaDb => 3306,
            devx_db::Engine::PostgreSql => 5432,
            devx_db::Engine::Redis => 6379,
        };
        let port = registry.port_of(service_id).unwrap_or(default_port);

        let params = devx_db::ConnectionParams {
            engine: *engine,
            host: "127.0.0.1".to_owned(),
            port,
            username: None,
            password: None,
            database: None,
        };
        let reachable = devx_db::is_reachable(&params);

        servers.push(DbServer {
            engine: *engine,
            service_id: (*service_id).to_owned(),
            host: "127.0.0.1".to_owned(),
            port,
            reachable,
        });
    }

    Ok(servers)
}

/// Runs one read-only statement against `params` and renders a grid.
#[tauri::command]
#[specta::specta]
pub async fn db_query(
    params: devx_db::ConnectionParams,
    statement: String,
) -> Result<devx_db::DbResult, Error> {
    devx_db::query(&params, &statement).await
}

/// Imports a plain SQL dump file into the running service.
///
/// The file is replayed through the engine's own client, exactly like a
/// backup restore; Redis has no SQL import path. The service must be
/// running and the path must point to an existing `.sql` file.
#[tauri::command]
#[specta::specta]
pub async fn db_import_sql(
    state: State<'_, AppState>,
    service_id: String,
    file_path: String,
) -> Result<(), Error> {
    let engine = engine_of(&service_id)?;
    if engine == devx_db::Engine::Redis {
        return Err(Error::invalid_input(
            "redis has no SQL import; restore a snapshot instead",
        ));
    }

    let dump_path = std::path::PathBuf::from(&file_path);
    if !dump_path.is_file() {
        return Err(Error::not_found(format!(
            "`{file_path}` is not an existing file"
        )));
    }
    if dump_path.extension().and_then(|e| e.to_str()) != Some("sql") {
        return Err(Error::invalid_input(
            "only plain `.sql` dumps can be imported",
        ));
    }

    let params = db_params(&state, &service_id)?;
    if !devx_db::is_reachable(&params) {
        return Err(Error::conflict(format!(
            "{service_id} is not running; start it before importing"
        )));
    }
    let version = newest_installed_component(&state.paths, &service_id)?;
    let install_dir = state
        .paths
        .runtimes_dir()
        .join(&service_id)
        .join(version);
    let plan = devx_db::plan_restore(engine, &install_dir, params.port, &dump_path)?;
    devx_db::run_tool(&plan).await
}

/// Escapes one CSV field: quotes wrap fields with commas, quotes or newlines.
fn csv_field(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// Runs one read-only statement and writes the result grid to a CSV file.
///
/// The first line is the header row; NULL renders as an empty field, the
/// same convention the browser grid uses. Returns the exported row count.
#[tauri::command]
#[specta::specta]
pub async fn db_export_csv(
    params: devx_db::ConnectionParams,
    statement: String,
    file_path: String,
) -> Result<u32, Error> {
    let result = devx_db::query(&params, &statement).await?;
    let target = std::path::Path::new(&file_path);
    if target.extension().and_then(|e| e.to_str()) != Some("csv") {
        return Err(Error::invalid_input(
            "the export target must be a `.csv` file",
        ));
    }

    let mut out = String::new();
    out.push_str(
        &result
            .columns
            .iter()
            .map(|column| csv_field(&column.name))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in &result.rows {
        let fields: Vec<String> = row
            .iter()
            .map(|cell| match cell {
                devx_db::DbValue::Null => String::new(),
                devx_db::DbValue::Int(value) => value.to_string(),
                devx_db::DbValue::Float(value) => value.to_string(),
                devx_db::DbValue::Text(value) => csv_field(value),
                devx_db::DbValue::Other(value) => csv_field(value),
            })
            .collect();
        out.push_str(&fields.join(","));
        out.push('\n');
    }

    std::fs::write(&file_path, out).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to write {file_path}: {err}"),
        )
    })?;
    Ok(result.rows.len() as u32)
}

/// Lists the databases (schemas) visible on `params`.
#[tauri::command]
#[specta::specta]
pub async fn db_list_databases(
    params: devx_db::ConnectionParams,
) -> Result<devx_db::DbResult, Error> {
    devx_db::list_databases(&params).await
}

/// Lists the tables in `params.database`.
#[tauri::command]
#[specta::specta]
pub async fn db_list_tables(params: devx_db::ConnectionParams) -> Result<devx_db::DbResult, Error> {
    devx_db::list_tables(&params).await
}

/// One database backup file, for the UI.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct BackupEntry {
    /// Service the backup belongs to (`mariadb`, `postgresql`, `redis`).
    pub service_id: String,
    /// File name inside the service's backups directory.
    pub file_name: String,
    /// Size on disk, in bytes.
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
    /// Creation time as Unix seconds.
    #[specta(type = specta_typescript::Number)]
    pub created_unix: u64,
}

/// The backups directory for one database service.
fn backup_dir(paths: &AppPaths, service_id: &str) -> std::path::PathBuf {
    paths.data_dir.join("backups").join(service_id)
}

/// The [`devx_db::Engine`] a database service id maps to.
fn engine_of(service_id: &str) -> Result<devx_db::Engine, Error> {
    match service_id {
        "mariadb" => Ok(devx_db::Engine::MariaDb),
        "postgresql" => Ok(devx_db::Engine::PostgreSql),
        "redis" => Ok(devx_db::Engine::Redis),
        other => Err(Error::invalid_input(format!(
            "`{other}` has no backups; only mariadb, postgresql and redis do"
        ))),
    }
}

/// The connection params the dump tools and snapshots use for `service_id`.
fn db_params(state: &AppState, service_id: &str) -> Result<devx_db::ConnectionParams, Error> {
    let engine = engine_of(service_id)?;
    let default_port = match engine {
        devx_db::Engine::MariaDb => 3306,
        devx_db::Engine::PostgreSql => 5432,
        devx_db::Engine::Redis => 6379,
    };
    Ok(devx_db::ConnectionParams {
        engine,
        host: "127.0.0.1".into(),
        port: state.services.port_of(service_id).unwrap_or(default_port),
        username: None,
        password: None,
        database: None,
    })
}

/// Validates a backup file name: a safe stem plus a known extension.
fn validate_backup_file_name(file_name: &str) -> Result<(), Error> {
    let valid = !file_name.is_empty()
        && (file_name.ends_with(".sql") || file_name.ends_with(".rdb"))
        && file_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !file_name.contains("..");
    if valid {
        Ok(())
    } else {
        Err(Error::invalid_input(format!(
            "`{file_name}` is not a DevX backup file name"
        )))
    }
}

/// Lists the backups of one database service, newest first.
#[tauri::command]
#[specta::specta]
pub fn backup_list(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<Vec<BackupEntry>, Error> {
    engine_of(&service_id)?;
    let dir = backup_dir(&state.paths, &service_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut backups = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if validate_backup_file_name(&file_name).is_err() {
            continue;
        }
        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let created_unix = metadata
            .and_then(|m| m.created().or_else(|_| m.modified()).ok())
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs())
            })
            .unwrap_or(0);
        backups.push(BackupEntry {
            service_id: service_id.clone(),
            file_name,
            size_bytes,
            created_unix,
        });
    }
    backups.sort_by_key(|entry| std::cmp::Reverse(entry.created_unix));
    Ok(backups)
}

/// Creates a backup of one database service and prunes old ones.
///
/// MariaDB and PostgreSQL are dumped through their own tools into plain SQL;
/// Redis is snapshotted with a blocking `SAVE` and the RDB file copied. The
/// service must be running: the tools connect over TCP like any client.
#[tauri::command]
#[specta::specta]
pub async fn backup_create(
    state: State<'_, AppState>,
    service_id: String,
) -> Result<BackupEntry, Error> {
    let engine = engine_of(&service_id)?;
    let params = db_params(&state, &service_id)?;
    if !devx_db::is_reachable(&params) {
        return Err(Error::conflict(format!(
            "{service_id} is not running; start it before taking a backup"
        )));
    }

    let dir = backup_dir(&state.paths, &service_id);
    std::fs::create_dir_all(&dir).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to create {}: {err}", dir.display()),
        )
    })?;

    let created_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = match engine {
        devx_db::Engine::Redis => format!("snapshot-{created_unix}.rdb"),
        _ => format!("dump-{created_unix}.sql"),
    };
    let out_path = dir.join(&file_name);

    match engine {
        devx_db::Engine::Redis => {
            devx_db::redis_snapshot(params.port).await?;
            let rdb = state
                .paths
                .service_data_dir()
                .join("redis")
                .join("dump.rdb");
            std::fs::copy(&rdb, &out_path).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to copy {}: {err}", rdb.display()),
                )
                .with_hint("the snapshot file was not found next to the redis service data")
            })?;
        }
        _ => {
            let version = newest_installed_component(&state.paths, &service_id)?;
            let install_dir = state.paths.runtimes_dir().join(&service_id).join(version);
            let plan = devx_db::plan_dump(engine, &install_dir, params.port, &out_path)?;
            devx_db::run_tool(&plan).await?;
        }
    }

    prune_backups(&dir, MAX_BACKUPS_PER_SERVICE)?;

    let size_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupEntry {
        service_id,
        file_name,
        size_bytes,
        created_unix,
    })
}

/// Deletes all but the newest `keep` backups in `dir`.
fn prune_backups(dir: &std::path::Path, keep: usize) -> Result<(), Error> {
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(dir)
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Io,
                format!("failed to read {}: {err}", dir.display()),
            )
        })?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    files.sort_by_key(|(time, _)| std::cmp::Reverse(*time));

    for (_, path) in files.into_iter().skip(keep) {
        if let Err(err) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), error = %err, "could not prune an old backup");
        }
    }
    Ok(())
}

/// Restores a database service from one of its backups.
///
/// SQL dumps are replayed through the engine's client against the running
/// server; a Redis snapshot is copied back into the service data directory,
/// which requires the server to be stopped first.
#[tauri::command]
#[specta::specta]
pub async fn backup_restore(
    state: State<'_, AppState>,
    service_id: String,
    file_name: String,
) -> Result<(), Error> {
    let engine = engine_of(&service_id)?;
    validate_backup_file_name(&file_name)?;

    let dir = backup_dir(&state.paths, &service_id);
    let backup_path = dir.join(&file_name);
    if !backup_path.is_file() {
        return Err(Error::not_found(format!(
            "backup `{file_name}` does not exist"
        )));
    }

    match engine {
        devx_db::Engine::Redis => {
            let running = state
                .services
                .get(&service_id)
                .is_some_and(|supervisor| supervisor.state().is_active());
            if running {
                return Err(Error::conflict(
                    "redis must be stopped to restore a snapshot",
                ));
            }
            let rdb = state
                .paths
                .service_data_dir()
                .join("redis")
                .join("dump.rdb");
            std::fs::copy(&backup_path, &rdb).map_err(|err| {
                Error::new(
                    devx_core::ErrorCode::Io,
                    format!("failed to restore {}: {err}", rdb.display()),
                )
            })?;
        }
        _ => {
            let params = db_params(&state, &service_id)?;
            if !devx_db::is_reachable(&params) {
                return Err(Error::conflict(format!(
                    "{service_id} is not running; start it before restoring"
                )));
            }
            let version = newest_installed_component(&state.paths, &service_id)?;
            let install_dir = state.paths.runtimes_dir().join(&service_id).join(version);
            let plan = devx_db::plan_restore(engine, &install_dir, params.port, &backup_path)?;
            devx_db::run_tool(&plan).await?;
        }
    }

    Ok(())
}

/// Deletes one backup of a database service.
#[tauri::command]
#[specta::specta]
pub fn backup_delete(
    state: State<'_, AppState>,
    service_id: String,
    file_name: String,
) -> Result<(), Error> {
    engine_of(&service_id)?;
    validate_backup_file_name(&file_name)?;

    let path = backup_dir(&state.paths, &service_id).join(&file_name);
    std::fs::remove_file(&path).map_err(|err| {
        Error::new(
            devx_core::ErrorCode::Io,
            format!("failed to delete {}: {err}", path.display()),
        )
    })
}

/// How many backups to keep per service; older ones are pruned on create.
const MAX_BACKUPS_PER_SERVICE: usize = 10;
