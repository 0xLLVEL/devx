//! Built-in service definitions for the catalog components.
//!
//! These are the recipes that make an installed component runnable. Each is
//! hand-written from the component's documented Windows invocation and verified
//! by the `live_service` tests, which actually start each one.
//!
//! Kept in code rather than the JSON catalog because they are logic (init
//! sequencing, template bodies) rather than the versioned data the catalog
//! holds, and because they must stay in lock-step with this crate's renderer.

use devx_core::{Error, Result};

use crate::service::{ConfigFile, InitStep, Readiness, ServiceDefinition};

/// Returns the service definition for `component_id`, if one exists.
///
/// Components with no definition (php, node, composer, cloudflared) are not
/// long-running services managed here: PHP runs as FastCGI pools (see
/// [`crate::php_pool`]), cloudflared is launched per-share (Task 14), and the
/// rest are CLI tools.
pub fn definition_for(component_id: &str) -> Result<ServiceDefinition> {
    match component_id {
        "nginx" => Ok(nginx()),
        "mariadb" => Ok(mariadb()),
        "postgresql" => Ok(postgresql()),
        "redis" => Ok(redis()),
        "mailpit" => Ok(mailpit()),
        "minio" => Ok(minio()),
        "meilisearch" => Ok(meilisearch()),
        other => Err(
            Error::not_found(format!("`{other}` has no supervised service definition"))
                .with_hint("it may be a CLI tool or handled by a dedicated subsystem"),
        ),
    }
}

/// Whether a component has a supervised service definition.
pub fn is_service(component_id: &str) -> bool {
    definition_for(component_id).is_ok()
}

/// Ids of every component with a service definition.
pub fn service_ids() -> Vec<&'static str> {
    vec![
        "nginx",
        "mariadb",
        "postgresql",
        "redis",
        "mailpit",
        "minio",
        "meilisearch",
    ]
}

fn nginx() -> ServiceDefinition {
    // A minimal nginx.conf that logs to the DevX log dir and includes per-site
    // server blocks (written by Task 9) from a sites directory.
    let conf = r#"worker_processes  1;
error_log  {{ log_dir }}/nginx-error.log;
pid        {{ data_dir }}/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       {{ install_dir }}/conf/mime.types;
    default_type  application/octet-stream;
    access_log    {{ log_dir }}/nginx-access.log;
    sendfile      on;
    keepalive_timeout  65;

    client_body_temp_path {{ data_dir }}/client_body_temp;
    proxy_temp_path       {{ data_dir }}/proxy_temp;
    fastcgi_temp_path     {{ data_dir }}/fastcgi_temp;
    uwsgi_temp_path       {{ data_dir }}/uwsgi_temp;
    scgi_temp_path        {{ data_dir }}/scgi_temp;

    server {
        listen       {{ port }};
        server_name  localhost;
        location / {
            root   {{ install_dir }}/html;
            index  index.html index.htm;
        }
    }

    include {{ config_dir }}/sites/*.conf;
}
"#;

    ServiceDefinition {
        component_id: "nginx".into(),
        default_port: Some(80),
        depends_on: vec![],
        config_files: vec![ConfigFile {
            relative_path: "nginx.conf".into(),
            template: conf.into(),
        }],
        // nginx needs an empty sites directory to include, and its temp dirs.
        init_steps: vec![],
        program: "nginx.exe".into(),
        // `-p` sets the prefix; `-c` points at our generated config. Paths use
        // forward slashes so nginx parses them on Windows.
        args: vec![
            "-p".into(),
            "{{ install_dir }}".into(),
            "-c".into(),
            "{{ config_dir }}/nginx.conf".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn mariadb() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "mariadb".into(),
        default_port: Some(3306),
        depends_on: vec![],
        config_files: vec![ConfigFile {
            relative_path: "my.ini".into(),
            template: r#"[mysqld]
datadir={{ data_dir }}
port={{ port }}
bind-address=127.0.0.1
skip-name-resolve
"#
            .into(),
        }],
        // `mariadb-install-db` creates the system tables; its output leaves a
        // `mysql` subdirectory in the data dir, which is our completion marker.
        init_steps: vec![InitStep {
            description: "initialise the MariaDB data directory".into(),
            // The Windows `mariadb-install-db.exe` takes only `--datadir`; the
            // Unix-only auth flags are rejected as unknown variables.
            program: "bin/mariadb-install-db.exe".into(),
            args: vec!["--datadir={{ data_dir }}".into()],
            creates: "mysql".into(),
        }],
        program: "bin/mariadbd.exe".into(),
        args: vec![
            "--defaults-file={{ config_dir }}/my.ini".into(),
            "--datadir={{ data_dir }}".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn postgresql() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "postgresql".into(),
        default_port: Some(5432),
        depends_on: vec![],
        config_files: vec![],
        // `initdb` writes PG_VERSION into the data dir when it completes.
        init_steps: vec![InitStep {
            description: "initialise the PostgreSQL data directory".into(),
            program: "bin/initdb.exe".into(),
            args: vec![
                "-D".into(),
                "{{ data_dir }}".into(),
                "-U".into(),
                "postgres".into(),
                "-E".into(),
                "UTF8".into(),
                "--auth=trust".into(),
            ],
            creates: "PG_VERSION".into(),
        }],
        program: "bin/postgres.exe".into(),
        args: vec![
            "-D".into(),
            "{{ data_dir }}".into(),
            "-p".into(),
            "{{ port }}".into(),
            "-k".into(),
            "".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn redis() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "redis".into(),
        default_port: Some(6379),
        depends_on: vec![],
        config_files: vec![ConfigFile {
            relative_path: "redis.conf".into(),
            // `dir .` keeps the RDB next to the config: redis-server runs with
            // its working directory set to the config dir (see the definition),
            // which avoids the Cygwin absolute-path problem for the data dir too.
            template: r#"bind 127.0.0.1
port {{ port }}
dir .
save 900 1
"#
            .into(),
        }],
        init_steps: vec![],
        program: "redis-server.exe".into(),
        // The Cygwin redis-server mishandles an absolute Windows config path, so
        // run it from the config directory and pass the bare file name. `dir` in
        // redis.conf is likewise a relative name for the same reason.
        args: vec!["redis.conf".into()],
        env: vec![],
        working_dir: Some("{{ config_dir }}".into()),
        readiness: Readiness::TcpPort,
    }
}

fn mailpit() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "mailpit".into(),
        default_port: Some(8025),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "mailpit.exe".into(),
        args: vec![
            "--db-file".into(),
            "{{ data_dir }}/mailpit.db".into(),
            "--smtp".into(),
            "127.0.0.1:1025".into(),
            "--listen".into(),
            "127.0.0.1:{{ port }}".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn minio() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "minio".into(),
        default_port: Some(9000),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "minio.exe".into(),
        args: vec![
            "server".into(),
            "{{ data_dir }}".into(),
            "--address".into(),
            "127.0.0.1:{{ port }}".into(),
            "--console-address".into(),
            "127.0.0.1:9001".into(),
        ],
        // MinIO's default root credentials; fine for a local dev store.
        env: vec![
            ("MINIO_ROOT_USER".into(), "devx".into()),
            ("MINIO_ROOT_PASSWORD".into(), "devx-local-secret".into()),
        ],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn meilisearch() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "meilisearch".into(),
        default_port: Some(7700),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "meilisearch.exe".into(),
        args: vec![
            "--db-path".into(),
            "{{ data_dir }}/data.ms".into(),
            "--http-addr".into(),
            "127.0.0.1:{{ port }}".into(),
            "--env".into(),
            "development".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{Readiness, RenderContext};
    use std::collections::BTreeMap;
    use std::path::Path;

    fn ctx(port: u16) -> RenderContext {
        RenderContext {
            install_dir: Path::new("C:/devx/install").to_path_buf(),
            config_dir: Path::new("C:/devx/config").to_path_buf(),
            data_dir: Path::new("C:/devx/data").to_path_buf(),
            log_dir: Path::new("C:/devx/logs").to_path_buf(),
            port: Some(port),
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn every_declared_service_has_a_definition() {
        for id in service_ids() {
            let def = definition_for(id).unwrap_or_else(|_| panic!("missing definition for {id}"));
            assert_eq!(def.component_id, id);
            assert!(def.default_port.is_some(), "{id} should declare a port");
        }
    }

    #[test]
    fn non_service_components_have_no_definition() {
        for id in ["php", "node", "composer", "cloudflared", "unknown"] {
            assert!(!is_service(id), "{id} should not be a supervised service");
        }
    }

    #[test]
    fn nginx_config_renders_with_the_assigned_port() {
        let def = nginx();
        let file = &def.config_files[0];
        let rendered = render_template(&file.template, &ctx(8080));
        assert!(rendered.contains("listen       8080;"), "{rendered}");
        assert!(!rendered.contains('\\'), "paths must use forward slashes");
    }

    #[test]
    fn mariadb_init_is_gated_on_the_mysql_directory() {
        let def = mariadb();
        assert_eq!(def.init_steps.len(), 1);
        assert_eq!(def.init_steps[0].creates, "mysql");
    }

    #[test]
    fn postgresql_init_is_gated_on_pg_version() {
        let def = postgresql();
        assert_eq!(def.init_steps[0].creates, "PG_VERSION");
    }

    /// Renders a template through the same engine `prepare` uses.
    fn render_template(template: &str, ctx: &RenderContext) -> String {
        let dir = tempfile::tempdir().expect("temp");
        let mut ctx = ctx.clone();
        ctx.config_dir = dir.path().join("config");
        ctx.data_dir = dir.path().join("data");

        let def = ServiceDefinition {
            component_id: "t".into(),
            default_port: ctx.port,
            depends_on: vec![],
            config_files: vec![ConfigFile {
                relative_path: "out.conf".into(),
                template: template.into(),
            }],
            init_steps: vec![],
            program: "x".into(),
            args: vec![],
            env: vec![],
            working_dir: None,
            readiness: Readiness::TcpPort,
        };
        def.prepare(&ctx).expect("prepare");
        std::fs::read_to_string(ctx.config_dir.join("out.conf")).expect("read")
    }
}
