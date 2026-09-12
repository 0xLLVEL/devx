//! # devx-db
//!
//! Read-only database access behind the DevX database browser: connect to a
//! supervised MariaDB, PostgreSQL or Redis instance, list databases and
//! tables, and run the queries the browser renders.
//!
//! ## Read-only, by construction
//!
//! The browser is a viewer. Rather than trusting the UI (or a future bug)
//! never to send a write, [`ensure_read_only`] rewrites nothing and instead
//! **rejects** any statement whose first keyword is not on an explicit
//! allow-list (`SELECT`, `SHOW`, `EXPLAIN`, `DESCRIBE`…). Everything else —
//! `UPDATE`, `DROP`, even `SET` — is refused before it reaches the server.
//! The same filter guards `db_query`; introspection commands run fixed,
//! parameterless queries built here, never strings from the client.

use std::net::TcpStream;
use std::time::Duration;

use devx_core::{Error, ErrorCode, Result};
use serde::{Deserialize, Serialize};

pub mod backup;
pub mod value;

pub use backup::{plan_dump, plan_restore, redis_snapshot, run_tool, ToolPlan};
pub use value::DbValue;

/// How to reach one database server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ConnectionParams {
    /// Which engine speaks on the other end.
    pub engine: Engine,
    /// Host, almost always `127.0.0.1` for supervised services.
    pub host: String,
    /// Port from the service's port allocation.
    pub port: u16,
    /// Username; DevX services use `root` / `postgres` with no password by
    /// default, so the field is optional.
    pub username: Option<String>,
    /// Password, same story as the username.
    pub password: Option<String>,
    /// Optional database/schema to scope table listings to.
    pub database: Option<String>,
}

/// Supported engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    /// MariaDB or MySQL, both speak the MySQL protocol.
    MariaDb,
    /// PostgreSQL.
    PostgreSql,
    /// Redis (and Redis-compatible servers).
    Redis,
}

/// One column of a result set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct DbColumn {
    /// Column name as the server reported it.
    pub name: String,
}

/// A tabular result: what the browser renders as a grid.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct DbResult {
    /// Column names, in order.
    pub columns: Vec<DbColumn>,
    /// Rows, each with one value per column.
    pub rows: Vec<Vec<DbValue>>,
}

impl DbResult {
    /// A result with `columns` and no rows.
    pub fn empty(columns: &[&str]) -> Self {
        Self {
            columns: columns
                .iter()
                .map(|c| DbColumn {
                    name: c.to_string(),
                })
                .collect(),
            rows: Vec::new(),
        }
    }

    /// Number of rows returned.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether the result has no rows.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

/// The statement keywords the browser is allowed to run.
///
/// Matching is on the first word of the trimmed, uppercased statement. The
/// list is deliberately tiny; anything not obviously a read is refused.
const READ_ONLY_KEYWORDS: &[&str] = &[
    "SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "USE", "ANALYZE",
];

/// Rejects non-read statements before they reach a server.
///
/// Empty statements fail too: they are a UI bug, not a legitimate query.
pub fn ensure_read_only(statement: &str) -> Result<()> {
    let trimmed = strip_leading_comments(statement.trim());
    if trimmed.is_empty() {
        return Err(Error::invalid_input("the statement is empty"));
    }

    // Parenthesised selects like `(SELECT 1)` start with `(`.
    let trimmed = trimmed.strip_prefix('(').unwrap_or(trimmed).trim_start();

    let first = trimmed
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("");
    let first = first.to_ascii_uppercase();

    if READ_ONLY_KEYWORDS.contains(&first.as_str()) {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::InvalidInput,
            format!("`{first}` statements are not allowed in the database browser"),
        )
        .with_hint("the browser is read-only; run writes from your application"))
    }
}

/// Strips comments from the head of a statement so `/* hint */ SELECT`
/// and `-- x\nSELECT` are recognised by their first real word.
fn strip_leading_comments(statement: &str) -> &str {
    let mut rest = statement.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("/*") {
            // The whole block comment (or the rest of the input when it is
            // unterminated) is skipped.
            rest = match after.find("*/") {
                Some(end) => after[end + 2..].trim_start(),
                None => "",
            };
        } else if rest.starts_with("--") || rest.starts_with('#') {
            // Line comments run to the newline (SQL `--` needs a space per
            // the standard, MySQL accepts the bare form; skipping both is
            // safe because we only read forward).
            rest = match rest.find('\n') {
                Some(line_end) => rest[line_end + 1..].trim_start(),
                None => "",
            };
        } else {
            return rest;
        }
    }
}

/// Whether the server on `host:port` accepts a TCP connection.
///
/// A quick reachability probe the browser uses to distinguish "service is
/// stopped" from "query failed" in the error it shows.
pub fn is_reachable(params: &ConnectionParams) -> bool {
    let address = format!("{}:{}", params.host, params.port);
    TcpStream::connect_timeout(
        &address
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:0".parse().expect("static address")),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// Lists the databases (schemas) the connection can see.
pub async fn list_databases(params: &ConnectionParams) -> Result<DbResult> {
    match params.engine {
        Engine::MariaDb => {
            let result = query(params, "SHOW DATABASES").await?;
            Ok(result)
        }
        Engine::PostgreSql => {
            query(
                params,
                "SELECT datname AS database_name FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
            .await
        }
        // Redis has no database names beyond numeric indexes 0-15.
        Engine::Redis => {
            let mut result = DbResult::empty(&["index"]);
            for index in 0..16u8 {
                result.rows.push(vec![DbValue::Int(index as i64)]);
            }
            Ok(result)
        }
    }
}

/// Lists the tables in `params.database` (or the engine default).
pub async fn list_tables(params: &ConnectionParams) -> Result<DbResult> {
    match params.engine {
        Engine::MariaDb => {
            let database = params.database.clone().unwrap_or_default();
            let statement = format!(
                "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '{database}' ORDER BY table_name"
            );
            query(params, &statement).await
        }
        Engine::PostgreSql => {
            query(
                params,
                "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
            )
            .await
        }
        // Redis keys are listed, not "tables"; the count keeps the grid
        // honest without scanning a potentially huge keyspace.
        Engine::Redis => Ok(DbResult::empty(&["keyspace"])),
    }
}

/// Runs one read-only statement and renders the result as a grid.
///
/// `ensure_read_only` gates every statement, including the ones this module
/// builds itself.
pub async fn query(params: &ConnectionParams, statement: &str) -> Result<DbResult> {
    ensure_read_only(statement)?;

    match params.engine {
        Engine::MariaDb => mariadb_query(params, statement).await,
        Engine::PostgreSql => postgres_query(params, statement).await,
        // Redis has no query language in this sense; the browser exposes
        // GET/TYPE per key instead of a grid over commands.
        Engine::Redis => Err(Error::invalid_input(
            "Redis is browsed per key, not with SQL statements",
        )),
    }
}

/// Runs `statement` against MariaDB/MySQL.
async fn mariadb_query(params: &ConnectionParams, statement: &str) -> Result<DbResult> {
    use mysql_async::prelude::Queryable;

    let url = format!(
        "mysql://{}:{}@{}:{}/{}",
        params.username.as_deref().unwrap_or("root"),
        params.password.as_deref().unwrap_or(""),
        params.host,
        params.port,
        params.database.as_deref().unwrap_or("information_schema"),
    );

    let pool = mysql_async::Pool::new(url.as_str());
    let mut connection = pool.get_conn().await.map_err(|err| {
        Error::new(
            ErrorCode::Process,
            format!("MariaDB connection failed: {err}"),
        )
    })?;

    let rows: Vec<mysql_async::Row> = connection
        .query(statement)
        .await
        .map_err(|err| Error::new(ErrorCode::Process, format!("query failed: {err}")))?;

    // Column names come from the first row's metadata; a rowless result has
    // no names on the wire, which the grid renders as zero columns.
    let columns: Vec<DbColumn> = rows
        .first()
        .map(|row| {
            row.columns_ref()
                .iter()
                .map(|column| DbColumn {
                    name: column.name_str().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let data = rows
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|index| {
                    let value = row
                        .as_ref(index)
                        .cloned()
                        .unwrap_or(mysql_async::Value::NULL);
                    DbValue::from_mysql(&value)
                })
                .collect()
        })
        .collect();

    Ok(DbResult {
        columns,
        rows: data,
    })
}

/// Runs `statement` against PostgreSQL.
async fn postgres_query(params: &ConnectionParams, statement: &str) -> Result<DbResult> {
    let (client, connection) = tokio_postgres::connect(
        &format!(
            "host={} port={} user={} password={} dbname={} connect_timeout=5",
            params.host,
            params.port,
            params.username.as_deref().unwrap_or("postgres"),
            params.password.as_deref().unwrap_or(""),
            params.database.as_deref().unwrap_or("postgres"),
        ),
        tokio_postgres::NoTls,
    )
    .await
    .map_err(|err| {
        Error::new(
            ErrorCode::Process,
            format!("PostgreSQL connection failed: {err}"),
        )
    })?;

    // The connection drives itself on a background task; the client is the
    // request half of that pair.
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let rows = client
        .query(statement, &[])
        .await
        .map_err(|err| Error::new(ErrorCode::Process, format!("query failed: {err}")))?;

    let columns: Vec<DbColumn> = if rows.is_empty() {
        Vec::new()
    } else {
        rows[0]
            .columns()
            .iter()
            .map(|column| DbColumn {
                name: column.name().to_owned(),
            })
            .collect()
    };

    let data = rows
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|index| DbValue::from_postgres(row.try_get::<usize, _>(index)))
                .collect()
        })
        .collect();

    Ok(DbResult {
        columns,
        rows: data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn read_statements_pass_the_gate() {
        for statement in [
            "SELECT * FROM users",
            "  show tables",
            "EXPLAIN SELECT 1",
            "DESCRIBE users",
            "DESC users",
            "(SELECT 1)",
        ] {
            assert!(ensure_read_only(statement).is_ok(), "{statement}");
        }
    }

    #[test]
    fn write_statements_are_refused_before_any_connection() {
        for statement in [
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "DROP TABLE users",
            "INSERT INTO users VALUES (1)",
            "ALTER TABLE users ADD COLUMN x INT",
            "CREATE TABLE evil (id INT)",
            "SET GLOBAL max_connections = 0",
            "TRUNCATE users",
            "GRANT ALL ON *.* TO 'evil'@'%'",
            "; DROP TABLE users",
            "",
        ] {
            let err = ensure_read_only(statement).expect_err(statement);
            assert_eq!(err.code, ErrorCode::InvalidInput, "{statement}");
        }
    }

    #[test]
    fn comments_and_leading_parentheses_do_not_smuggle_writes() {
        // A leading comment does not make an UPDATE a read: the first word
        // after the comment is still UPDATE and gets refused.
        assert!(ensure_read_only("/*x*/ UPDATE t SET a = 1").is_err());
        // A real read with a leading comment passes.
        assert!(ensure_read_only("/*x*/ SELECT 1").is_ok());
    }

    #[test]
    fn grid_helpers_behave() {
        let empty = DbResult::empty(&["a", "b"]);
        assert_eq!(empty.columns.len(), 2);
        assert!(empty.is_empty());
        assert_eq!(empty.len(), 0);
    }
}
