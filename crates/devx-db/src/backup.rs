//! Database backup and restore through the engines' own tooling.
//!
//! Supervised MariaDB and PostgreSQL installs ship their dump clients
//! (`mariadb-dump`, `pg_dumpall`), so a backup is one spawned tool writing a
//! plain SQL file; restore feeds it back through the engine's client
//! (`mariadb`, `psql`). Redis has no dump client — a backup issues a blocking
//! `SAVE` and copies the resulting RDB file, and a restore swaps the file
//! back while the server is stopped.
//!
//! The functions here are the contract the desktop shell drives: it resolves
//! the newest installed version's directory and the service's live port, then
//! calls [`dump`]/[`restore`] (or [`redis_snapshot`]) with a destination in
//! the per-service backups directory.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use devx_core::{Error, ErrorCode, Result};

use crate::Engine;

/// Where each engine keeps its command-line tools inside an install.
fn tool_path(install_dir: &Path, tool: &str) -> PathBuf {
    match tool {
        // MariaDB and PostgreSQL both lay their clients out in a `bin` dir;
        // MariaDB's zip additionally nests one level deeper in old releases,
        // which the resolver normalises away at install time.
        "mariadb-dump" | "mariadb" | "mysqldump" | "pg_dumpall" | "psql" => {
            install_dir.join("bin").join(format!("{tool}.exe"))
        }
        _ => install_dir.join(format!("{tool}.exe")),
    }
}

/// One planned one-shot backup or restore operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPlan {
    /// Executable to run.
    pub program: PathBuf,
    /// Arguments.
    pub args: Vec<String>,
    /// SQL text piped to the tool's stdin, when it reads that way.
    pub stdin_file: Option<PathBuf>,
}

/// Plans a full backup of `engine` into `out_path` (a plain SQL file).
///
/// `install_dir` is the engine's installed runtime directory.
///
/// # Errors
///
/// Fails when the engine's dump tool is missing from the install.
pub fn plan_dump(
    engine: Engine,
    install_dir: &Path,
    port: u16,
    out_path: &Path,
) -> Result<ToolPlan> {
    match engine {
        Engine::MariaDb => {
            let program = existing_tool(&[
                tool_path(install_dir, "mariadb-dump"),
                tool_path(install_dir, "mysqldump"),
            ])?;
            Ok(ToolPlan {
                args: vec![
                    "--host=127.0.0.1".into(),
                    format!("--port={port}"),
                    "--user=root".into(),
                    "--all-databases".into(),
                    "--result-file".into(),
                    out_path.to_string_lossy().into_owned(),
                ],
                program,
                stdin_file: None,
            })
        }
        Engine::PostgreSql => {
            let program = existing_tool(&[tool_path(install_dir, "pg_dumpall")])?;
            Ok(ToolPlan {
                args: vec![
                    "--host=127.0.0.1".into(),
                    format!("--port={port}"),
                    "--username=postgres".into(),
                    "--file".into(),
                    out_path.to_string_lossy().into_owned(),
                ],
                program,
                stdin_file: None,
            })
        }
        // Redis backs up by snapshot, not by dumping SQL.
        Engine::Redis => Err(Error::invalid_input(
            "redis backups use a snapshot; call redis_snapshot instead",
        )),
    }
}

/// Plans a restore of a plain SQL backup produced by [`plan_dump`].
///
/// MariaDB reads the dump on stdin; PostgreSQL's `psql` takes `-f`.
///
/// # Errors
///
/// Fails when the engine's client is missing from the install.
pub fn plan_restore(
    engine: Engine,
    install_dir: &Path,
    port: u16,
    backup_path: &Path,
) -> Result<ToolPlan> {
    match engine {
        Engine::MariaDb => {
            let program = existing_tool(&[
                tool_path(install_dir, "mariadb"),
                tool_path(install_dir, "mysql"),
            ])?;
            Ok(ToolPlan {
                args: vec![
                    "--host=127.0.0.1".into(),
                    format!("--port={port}"),
                    "--user=root".into(),
                ],
                program,
                stdin_file: Some(backup_path.to_path_buf()),
            })
        }
        Engine::PostgreSql => {
            let program = existing_tool(&[tool_path(install_dir, "psql")])?;
            Ok(ToolPlan {
                args: vec![
                    "--host=127.0.0.1".into(),
                    format!("--port={port}"),
                    "--username=postgres".into(),
                    "--file".into(),
                    backup_path.to_string_lossy().into_owned(),
                ],
                program,
                stdin_file: None,
            })
        }
        Engine::Redis => Err(Error::invalid_input(
            "redis restores swap the RDB file; copy it back with the server stopped",
        )),
    }
}

/// The first tool in `candidates` that exists on disk, or the first candidate
/// when none does.
///
/// Planning stays pure so it is testable without an install; a missing tool
/// surfaces from [`run_tool`]'s spawn error, which names the path.
fn existing_tool(candidates: &[PathBuf]) -> Result<PathBuf> {
    let chosen = candidates
        .iter()
        .find(|p| p.is_file())
        .or_else(|| candidates.first())
        .ok_or_else(|| Error::invalid_input("no dump tool candidate given"))?;
    Ok(chosen.clone())
}

/// Runs a planned tool to completion, refusing non-zero exits.
pub async fn run_tool(plan: &ToolPlan) -> Result<()> {
    let mut command = tokio::process::Command::new(&plan.program);
    command
        .args(&plan.args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let stdin_path = plan.stdin_file.clone();
    if let Some(path) = stdin_path {
        let file = tokio::fs::File::open(&path).await.map_err(|err| {
            Error::new(
                ErrorCode::Io,
                format!("failed to open {}: {err}", path.display()),
            )
        })?;
        command.stdin(Stdio::from(file.into_std().await));
    } else {
        command.stdin(Stdio::null());
    }

    let output = command.output().await.map_err(|err| {
        Error::new(
            ErrorCode::Process,
            format!("failed to run {}: {err}", plan.program.display()),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::new(
            ErrorCode::Process,
            format!(
                "{} exited with {:?}: {}",
                plan.program.display(),
                output.status.code(),
                stderr.trim()
            ),
        ));
    }

    Ok(())
}

/// Asks the Redis server on `port` to persist a snapshot, blocking until done.
///
/// `SAVE` (not `BGSAVE`) is deliberate: when it returns, the RDB file is
/// complete and safe to copy — the whole reason a background save exists is
/// to overlap with traffic, which is exactly what would race the copy.
pub async fn redis_snapshot(port: u16) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let client = redis::Client::open(("127.0.0.1", port))
            .map_err(|err| Error::new(ErrorCode::Io, format!("redis: {err}")))?;
        let mut connection = client
            .get_connection()
            .map_err(|err| Error::new(ErrorCode::Io, format!("redis: {err}")))?;

        redis::cmd("SAVE")
            .query::<()>(&mut connection)
            .map_err(|err| Error::new(ErrorCode::Process, format!("redis SAVE failed: {err}")))
    })
    .await
    .map_err(|err| {
        Error::new(
            ErrorCode::Process,
            format!("redis snapshot task failed: {err}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mariadb_backup_targets_the_dump_tool_with_the_port() {
        let dir = Path::new("C:/devx/runtimes/mariadb/11.4.5");
        let out = Path::new("C:/devx/backups/mariadb/2026.sql");

        let plan = plan_dump(Engine::MariaDb, dir, 3306, out).expect("plan");
        assert!(
            plan.program.ends_with("bin\\mariadb-dump.exe")
                || plan.program.ends_with("bin/mariadb-dump.exe")
        );
        assert!(
            plan.args.iter().any(|a| a == "--port=3306"),
            "{:?}",
            plan.args
        );
        assert!(plan.args.iter().any(|a| a == "--all-databases"));
        assert!(plan.stdin_file.is_none());
    }

    #[test]
    fn postgres_backup_uses_pg_dumpall_and_restore_uses_psql() {
        let dir = Path::new("C:/devx/runtimes/postgresql/17.2");
        let out = Path::new("C:/devx/backups/postgresql/2026.sql");

        let dump = plan_dump(Engine::PostgreSql, dir, 5432, out).expect("plan");
        assert!(dump.program.ends_with("pg_dumpall.exe"));

        let restore = plan_restore(Engine::PostgreSql, dir, 5432, out).expect("plan");
        assert!(restore.program.ends_with("psql.exe"));
        assert!(restore
            .args
            .iter()
            .any(|a| a == out.to_string_lossy().as_ref()));
    }

    #[test]
    fn mariadb_restore_feeds_the_dump_through_stdin() {
        let dir = Path::new("C:/devx/runtimes/mariadb/11.4.5");
        let backup = Path::new("C:/devx/backups/mariadb/2026.sql");

        let plan = plan_restore(Engine::MariaDb, dir, 3306, backup).expect("plan");
        assert_eq!(plan.stdin_file.as_deref(), Some(backup));
    }

    #[test]
    fn redis_refuses_sql_plans() {
        let dir = Path::new("C:/devx/runtimes/redis/8.0");
        assert!(plan_dump(Engine::Redis, dir, 6379, Path::new("x.sql")).is_err());
        assert!(plan_restore(Engine::Redis, dir, 6379, Path::new("x.sql")).is_err());
    }
}
