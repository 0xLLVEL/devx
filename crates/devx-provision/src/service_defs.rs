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
        "meilisearch" => Ok(meilisearch()),
        "caddy" => Ok(caddy()),
        "nats-server" => Ok(nats_server()),
        "etcd" => Ok(etcd()),
        "mongodb" => Ok(mongodb()),
        "traefik" => Ok(traefik()),
        "apache" => Ok(apache()),
        "frankenphp" => Ok(frankenphp()),
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

/// Returns the default port for `component_id`, if declared.
pub fn default_port_for(component_id: &str) -> Option<u16> {
    definition_for(component_id)
        .ok()
        .and_then(|def| def.default_port)
}

/// Ids of every component with a service definition.
pub fn service_ids() -> Vec<&'static str> {
    vec![
        "nginx",
        "mariadb",
        "postgresql",
        "redis",
        "mailpit",
        "meilisearch",
        "caddy",
        "nats-server",
        "etcd",
        "mongodb",
        "traefik",
        "apache",
        "frankenphp",
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

fn caddy() -> ServiceDefinition {
    // A minimal Caddyfile: serve the data directory statically on the
    // assigned port. Admin endpoint and auto-HTTPS are off so a local dev
    // instance binds exactly one port and never prompts for certs.
    let caddyfile = r##"{
	admin off
	auto_https off
}

:{{ port }} {
	root * {{ data_dir }}/www
	file_server
}
"##;

    ServiceDefinition {
        component_id: "caddy".into(),
        default_port: Some(8080),
        depends_on: vec![],
        config_files: vec![ConfigFile {
            relative_path: "Caddyfile".into(),
            template: caddyfile.into(),
        }],
        init_steps: vec![],
        program: "caddy.exe".into(),
        args: vec![
            "run".into(),
            "--config".into(),
            "{{ config_dir }}/Caddyfile".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn nats_server() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "nats-server".into(),
        default_port: Some(4222),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "nats-server.exe".into(),
        args: vec![
            "-a".into(),
            "127.0.0.1".into(),
            "-p".into(),
            "{{ port }}".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn etcd() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "etcd".into(),
        default_port: Some(2379),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "etcd.exe".into(),
        args: vec![
            "--data-dir".into(),
            "{{ data_dir }}".into(),
            "--listen-client-urls".into(),
            "http://127.0.0.1:{{ port }}".into(),
            "--advertise-client-urls".into(),
            "http://127.0.0.1:{{ port }}".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn mongodb() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "mongodb".into(),
        default_port: Some(27017),
        depends_on: vec![],
        config_files: vec![],
        // mongod creates the dbpath on first start; no init step needed.
        init_steps: vec![],
        program: "bin/mongod.exe".into(),
        args: vec![
            "--dbpath".into(),
            "{{ data_dir }}".into(),
            "--port".into(),
            "{{ port }}".into(),
            "--bind_ip".into(),
            "127.0.0.1".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn traefik() -> ServiceDefinition {
    ServiceDefinition {
        component_id: "traefik".into(),
        default_port: Some(8090),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "traefik.exe".into(),
        args: vec![
            "--entrypoints.web.address".into(),
            "127.0.0.1:{{ port }}".into(),
            "--global.checknewversion=false".into(),
            "--global.sendanonymoususage=false".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn frankenphp() -> ServiceDefinition {
    // `php-server` mode: one binary serving PHP directly, no FastCGI pool.
    ServiceDefinition {
        component_id: "frankenphp".into(),
        default_port: Some(8082),
        depends_on: vec![],
        config_files: vec![],
        init_steps: vec![],
        program: "frankenphp.exe".into(),
        args: vec![
            "php-server".into(),
            "--root".into(),
            "{{ data_dir }}/www".into(),
            "--listen".into(),
            "127.0.0.1:{{ port }}".into(),
        ],
        env: vec![],
        working_dir: None,
        readiness: Readiness::TcpPort,
    }
}

fn apache() -> ServiceDefinition {
    // Apache Lounge build: the zip extracts an `Apache24/` tree whose
    // modules live under ServerRoot. PHP is served by proxying .php to
    // the first DevX PHP pool (FastCGI, port 9100) — DevX installs NTS
    // PHP builds, which have no mod_php library.
    //
    // Three directives make the FastCGI handoff work with plain php-cgi:
    // 1. The trailing slash on `proxy:fcgi://host:port/` — without it
    //    mod_proxy_fcgi appends the translated filename to the authority,
    //    and Apache reports a bogus DNS lookup for `127.0.0.1:9100c:`.
    // 2. `ProxyFCGIBackendType GENERIC` — with the default FPM type Apache
    //    leaves a `proxy:fcgi://` prefix inside SCRIPT_FILENAME, which
    //    php-cgi (unlike PHP-FPM) does not strip.
    // 3. `ProxyFCGISetEnvIf` rewriting SCRIPT_FILENAME to
    //    DOCUMENT_ROOT + REQUEST_URI and setting REDIRECT_STATUS — Apache
    //    would otherwise send a `/C:/...` path (leading slash), and php-cgi
    //    refuses scripts without REDIRECT_STATUS (cgi.force_redirect).
    let httpd_conf = r##"ServerRoot "{{ install_dir }}/Apache24"
Listen 127.0.0.1:{{ port }}
ServerName localhost

LoadModule auth_basic_module modules/mod_auth_basic.so
LoadModule authn_core_module modules/mod_authn_core.so
LoadModule authn_file_module modules/mod_authn_file.so
LoadModule authz_user_module modules/mod_authz_user.so
LoadModule authz_core_module modules/mod_authz_core.so
LoadModule authz_host_module modules/mod_authz_host.so
LoadModule log_config_module modules/mod_log_config.so
LoadModule env_module modules/mod_env.so
LoadModule filter_module modules/mod_filter.so
LoadModule mime_module modules/mod_mime.so
LoadModule dir_module modules/mod_dir.so
LoadModule alias_module modules/mod_alias.so
LoadModule headers_module modules/mod_headers.so
LoadModule setenvif_module modules/mod_setenvif.so
LoadModule rewrite_module modules/mod_rewrite.so
LoadModule deflate_module modules/mod_deflate.so
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_fcgi_module modules/mod_proxy_fcgi.so

TypesConfig conf/mime.types
ProxyFCGIBackendType GENERIC
ProxyFCGISetEnvIf "true" SCRIPT_FILENAME "%{reqenv:DOCUMENT_ROOT}%{REQUEST_URI}"
ProxyFCGISetEnvIf "true" REDIRECT_STATUS 200

DocumentRoot "{{ data_dir }}/www"
<Directory "{{ data_dir }}/www">
    Options Indexes FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>

<FilesMatch \.php$>
    SetHandler "proxy:fcgi://127.0.0.1:9100/"
</FilesMatch>

ErrorLog  "{{ log_dir }}/apache-error.log"
CustomLog "{{ log_dir }}/apache-access.log" common
PidFile   "{{ data_dir }}/httpd.pid"

IncludeOptional "{{ config_dir }}/sites/*.conf"
"##;

    ServiceDefinition {
        component_id: "apache".into(),
        default_port: Some(8085),
        depends_on: vec![],
        config_files: vec![ConfigFile {
            relative_path: "httpd.conf".into(),
            template: httpd_conf.into(),
        }],
        init_steps: vec![],
        program: "Apache24/bin/httpd.exe".into(),
        args: vec![
            "-d".into(),
            "{{ install_dir }}/Apache24".into(),
            "-f".into(),
            "{{ config_dir }}/httpd.conf".into(),
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
    fn web_servers_resolve_with_their_ports() {
        for (id, port) in [("traefik", 8090), ("frankenphp", 8082)] {
            let def = definition_for(id).unwrap_or_else(|_| panic!("missing {id}"));
            assert_eq!(def.default_port, Some(port));
        }
    }

    #[test]
    fn apache_config_renders_with_port_and_fastcgi_proxy() {
        let def = apache();
        let file = &def.config_files[0];
        let rendered = render_template(&file.template, &ctx(8085));
        assert!(rendered.contains("Listen 127.0.0.1:8085"), "{rendered}");
        assert!(
            rendered.contains("SetHandler \"proxy:fcgi://127.0.0.1:9100/\""),
            "{rendered}"
        );
        assert!(
            rendered.contains("ProxyFCGIBackendType GENERIC"),
            "{rendered}"
        );
        assert!(
            rendered.contains("SCRIPT_FILENAME \"%{reqenv:DOCUMENT_ROOT}%{REQUEST_URI}\""),
            "{rendered}"
        );
        assert!(rendered.contains("REDIRECT_STATUS 200"), "{rendered}");
        assert!(rendered.contains("AllowOverride All"), "{rendered}");
    }

    #[test]
    fn caddyfile_renders_with_the_assigned_port_and_no_tls() {
        let def = caddy();
        let file = &def.config_files[0];
        let rendered = render_template(&file.template, &ctx(8080));
        assert!(rendered.contains(":8080 {"), "{rendered}");
        assert!(rendered.contains("admin off"), "{rendered}");
        assert!(!rendered.contains('\\'), "paths must use forward slashes");
    }

    #[test]
    fn new_services_resolve_with_their_ports() {
        for (id, port) in [
            ("caddy", 8080),
            ("nats-server", 4222),
            ("etcd", 2379),
            ("mongodb", 27017),
        ] {
            let def = definition_for(id).unwrap_or_else(|_| panic!("missing {id}"));
            assert_eq!(def.default_port, Some(port));
            assert!(def.program.ends_with(".exe"), "{}", def.program);
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
