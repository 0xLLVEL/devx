//! Declarative service definitions: how each component is configured and run.
//!
//! A [`ServiceDefinition`] is the recipe that turns an *installed* component
//! into a *runnable* one: which config files to render from templates, which
//! one-time init steps to run (`initdb`, `mysql_install_db`), what to launch,
//! how to tell it is ready, and what it depends on. It is pure data plus pure
//! rendering, so the whole mapping is testable without spawning anything.
//!
//! The supervisor ([`devx_proc`]) consumes the launch part; this module owns the
//! "get it ready to launch" part.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use devx_core::{Error, ErrorCode, Result};
use serde::Serialize;

/// How a service reports readiness, mirrored into the supervisor's health check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Readiness {
    /// Ready once alive for this many milliseconds.
    UptimeMs(u64),
    /// Ready when its primary port accepts a TCP connection.
    TcpPort,
    /// Ready when a log line contains this text.
    LogContains(String),
}

/// A file rendered from a template into the service's config directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigFile {
    /// Path relative to the service's config directory.
    pub relative_path: String,
    /// The template, in minijinja syntax.
    pub template: String,
}

/// A command run once, the first time a service is set up.
///
/// Idempotent by construction: it only runs when `creates` does not yet exist,
/// so re-running setup never corrupts an initialised data directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InitStep {
    /// Human-readable description for logs and the UI.
    pub description: String,
    /// Executable, relative to the install directory, or absolute.
    pub program: String,
    /// Arguments, each rendered through the same context as config files.
    pub args: Vec<String>,
    /// Path (relative to the data directory) whose existence means "done".
    pub creates: String,
}

/// The declarative definition of how to configure and run a component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceDefinition {
    /// Component id this belongs to.
    pub component_id: String,
    /// Default TCP port, when the service listens on one.
    pub default_port: Option<u16>,
    /// Other component ids that must be running first.
    pub depends_on: Vec<String>,
    /// Config files to render before launch.
    pub config_files: Vec<ConfigFile>,
    /// One-time initialisation steps.
    pub init_steps: Vec<InitStep>,
    /// Launch program, relative to the install directory.
    pub program: String,
    /// Launch arguments, rendered through the template context.
    pub args: Vec<String>,
    /// Extra environment variables, values rendered through the context.
    pub env: Vec<(String, String)>,
    /// Working directory template, if the service needs one.
    ///
    /// Some Windows builds (the Cygwin Redis) mishandle absolute Windows paths
    /// in arguments; running them from a known directory and passing bare file
    /// names sidesteps that.
    pub working_dir: Option<String>,
    /// How readiness is observed.
    pub readiness: Readiness,
}

/// Everything a render needs: resolved paths and the chosen port.
#[derive(Debug, Clone)]
pub struct RenderContext {
    /// Directory the component version is installed in.
    pub install_dir: PathBuf,
    /// Directory for this service's generated config.
    pub config_dir: PathBuf,
    /// Directory for this service's persistent data.
    pub data_dir: PathBuf,
    /// Directory for logs.
    pub log_dir: PathBuf,
    /// The port assigned to this service, if it listens.
    pub port: Option<u16>,
    /// Extra values a specific service wants exposed to its templates.
    pub extra: BTreeMap<String, String>,
}

impl RenderContext {
    /// Builds the minijinja value map from the resolved paths.
    ///
    /// Paths are exposed with forward slashes: nginx and PHP config parse them
    /// correctly on Windows, while backslashes need escaping and often do not.
    fn to_value(&self) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        map.insert("install_dir".into(), slash(&self.install_dir));
        map.insert("config_dir".into(), slash(&self.config_dir));
        map.insert("data_dir".into(), slash(&self.data_dir));
        map.insert("log_dir".into(), slash(&self.log_dir));
        if let Some(port) = self.port {
            map.insert("port".into(), port.to_string());
        }
        for (key, value) in &self.extra {
            map.insert(key.clone(), value.clone());
        }
        map
    }
}

/// Result of preparing a service: the rendered launch plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    /// Absolute program path.
    pub program: PathBuf,
    /// Rendered arguments.
    pub args: Vec<String>,
    /// Rendered environment.
    pub env: Vec<(String, String)>,
    /// Working directory, if the service declared one.
    pub working_dir: Option<PathBuf>,
    /// Readiness signal.
    pub readiness: Readiness,
}

impl ServiceDefinition {
    /// Renders config files to disk and returns the launch plan.
    ///
    /// Does not run init steps or spawn anything; see [`Self::pending_init`].
    /// Separating rendering from side effects keeps this callable in tests that
    /// only assert on generated config.
    pub fn prepare(&self, ctx: &RenderContext) -> Result<LaunchPlan> {
        std::fs::create_dir_all(&ctx.config_dir)
            .map_err(|err| io_error(err, &ctx.config_dir, "create config directory"))?;
        std::fs::create_dir_all(&ctx.data_dir)
            .map_err(|err| io_error(err, &ctx.data_dir, "create data directory"))?;

        let values = ctx.to_value();

        for file in &self.config_files {
            let rendered = render(&file.template, &values)
                .map_err(|err| err.with_hint(format!("in config file {}", file.relative_path)))?;
            let path = ctx.config_dir.join(&file.relative_path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| io_error(err, parent, "create config subdirectory"))?;
            }
            devx_core::fsx::write_atomic(&path, rendered)?;
        }

        let mut args = Vec::with_capacity(self.args.len());
        for arg in &self.args {
            args.push(render(arg, &values)?);
        }

        let mut env = Vec::with_capacity(self.env.len());
        for (key, value) in &self.env {
            env.push((key.clone(), render(value, &values)?));
        }

        let working_dir = match &self.working_dir {
            Some(template) => Some(PathBuf::from(render(template, &values)?)),
            None => None,
        };

        Ok(LaunchPlan {
            program: ctx.install_dir.join(&self.program),
            args,
            env,
            working_dir,
            readiness: self.readiness.clone(),
        })
    }

    /// Returns the init steps that still need running, in order.
    ///
    /// A step whose `creates` marker already exists under the data directory is
    /// skipped, which is what makes running setup twice safe.
    pub fn pending_init(&self, ctx: &RenderContext) -> Vec<ResolvedInitStep> {
        let values = ctx.to_value();
        self.init_steps
            .iter()
            .filter(|step| !ctx.data_dir.join(&step.creates).exists())
            .map(|step| ResolvedInitStep {
                description: step.description.clone(),
                program: resolve_program(&ctx.install_dir, &step.program),
                args: step
                    .args
                    .iter()
                    .map(|arg| render(arg, &values).unwrap_or_else(|_| arg.clone()))
                    .collect(),
                marker: ctx.data_dir.join(&step.creates),
            })
            .collect()
    }
}

/// A ready-to-run init step with resolved paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInitStep {
    /// Description for logs.
    pub description: String,
    /// Absolute program path.
    pub program: PathBuf,
    /// Rendered arguments.
    pub args: Vec<String>,
    /// Marker file whose creation means the step succeeded.
    pub marker: PathBuf,
}

/// Renders a minijinja template against a flat string map.
fn render(template: &str, values: &BTreeMap<String, String>) -> Result<String> {
    let mut env = minijinja::Environment::new();
    env.add_template("t", template)
        .map_err(|err| Error::new(ErrorCode::Config, format!("invalid template: {err}")))?;
    let tmpl = env
        .get_template("t")
        .map_err(|err| Error::new(ErrorCode::Config, format!("template error: {err}")))?;
    tmpl.render(values).map_err(|err| {
        Error::new(
            ErrorCode::Config,
            format!("failed to render template: {err}"),
        )
    })
}

/// Resolves a program path against the install dir unless already absolute.
fn resolve_program(install_dir: &Path, program: &str) -> PathBuf {
    let path = Path::new(program);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        install_dir.join(program)
    }
}

/// Renders a path with forward slashes.
fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Wraps an IO error with context.
fn io_error(err: std::io::Error, path: &Path, action: &str) -> Error {
    Error::new(
        ErrorCode::Io,
        format!("failed to {action} at {}: {err}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn ctx(root: &Path) -> RenderContext {
        RenderContext {
            install_dir: root.join("install"),
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            log_dir: root.join("logs"),
            port: Some(8025),
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn renders_config_with_forward_slash_paths_and_port() {
        let dir = tempfile::tempdir().expect("temp");
        let context = ctx(dir.path());

        let def = ServiceDefinition {
            component_id: "demo".into(),
            default_port: Some(8025),
            depends_on: vec![],
            config_files: vec![ConfigFile {
                relative_path: "demo.conf".into(),
                template: "listen 127.0.0.1:{{ port }};\nroot {{ data_dir }};".into(),
            }],
            init_steps: vec![],
            program: "demo.exe".into(),
            args: vec!["--config".into(), "{{ config_dir }}/demo.conf".into()],
            env: vec![("DATA".into(), "{{ data_dir }}".into())],
            working_dir: None,
            readiness: Readiness::TcpPort,
        };

        let plan = def.prepare(&context).expect("prepare");

        let conf = std::fs::read_to_string(context.config_dir.join("demo.conf")).expect("read");
        assert!(conf.contains("listen 127.0.0.1:8025;"), "{conf}");
        // Paths use forward slashes so nginx/PHP parse them on Windows.
        assert!(conf.contains("/data"), "{conf}");
        assert!(!conf.contains('\\'), "no backslashes in config: {conf}");

        assert_eq!(plan.program, context.install_dir.join("demo.exe"));
        assert!(plan.args[1].ends_with("/demo.conf"));
        assert_eq!(plan.env[0].1, slash(&context.data_dir));
    }

    #[test]
    fn pending_init_skips_steps_whose_marker_exists() {
        let dir = tempfile::tempdir().expect("temp");
        let context = ctx(dir.path());
        std::fs::create_dir_all(&context.data_dir).expect("data dir");

        let def = ServiceDefinition {
            component_id: "db".into(),
            default_port: Some(3306),
            depends_on: vec![],
            config_files: vec![],
            init_steps: vec![InitStep {
                description: "initialise data directory".into(),
                program: "bin/initdb.exe".into(),
                args: vec!["--datadir".into(), "{{ data_dir }}".into()],
                creates: "PG_VERSION".into(),
            }],
            program: "bin/postgres.exe".into(),
            args: vec![],
            env: vec![],
            working_dir: None,
            readiness: Readiness::TcpPort,
        };

        // Not initialised yet: the step is pending.
        let pending = def.pending_init(&context);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].program,
            context.install_dir.join("bin/initdb.exe")
        );
        assert!(pending[0].args.iter().any(|a| a.contains("/data")));

        // Once the marker exists, it is skipped.
        std::fs::write(context.data_dir.join("PG_VERSION"), "16").expect("marker");
        assert!(def.pending_init(&context).is_empty());
    }

    #[test]
    fn an_invalid_template_is_a_config_error() {
        let dir = tempfile::tempdir().expect("temp");
        let context = ctx(dir.path());

        let def = ServiceDefinition {
            component_id: "broken".into(),
            default_port: None,
            depends_on: vec![],
            config_files: vec![ConfigFile {
                relative_path: "x.conf".into(),
                template: "{{ unclosed".into(),
            }],
            init_steps: vec![],
            program: "x.exe".into(),
            args: vec![],
            env: vec![],
            working_dir: None,
            readiness: Readiness::UptimeMs(100),
        };

        let err = def.prepare(&context).expect_err("bad template must fail");
        assert_eq!(err.code, ErrorCode::Config);
        assert!(err.hint.is_some(), "should point at the offending file");
    }

    #[test]
    fn absolute_init_program_is_left_untouched() {
        let resolved = resolve_program(Path::new("C:\\install"), "C:\\windows\\system32\\cmd.exe");
        assert_eq!(resolved, PathBuf::from("C:\\windows\\system32\\cmd.exe"));

        let relative = resolve_program(Path::new("C:\\install"), "bin/tool.exe");
        assert_eq!(relative, PathBuf::from("C:\\install\\bin/tool.exe"));
    }
}
