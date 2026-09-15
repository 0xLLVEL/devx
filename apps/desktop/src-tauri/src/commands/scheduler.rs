//! Windows scheduled-task commands.

use crate::state::AppState;
use devx_core::Error;
use tauri::State;

/// One scheduled task, as the UI shows it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct CronStatus {
    /// The user-chosen task name (Windows task: `DevX <name>`).
    pub name: String,
    /// Program to run; a relative name runs off `PATH`.
    pub program: Option<String>,
    /// PHP version running the task, when DevX supplies the interpreter.
    pub php_version: Option<String>,
    /// Arguments passed to the program.
    pub args: Vec<String>,
    /// Directory the task runs in.
    pub working_dir: String,
    /// The interval in minutes.
    pub every_minutes: u32,
    /// Whether the Windows scheduled task exists right now.
    pub registered: bool,
    /// The Windows task's next scheduled run, as reported by `schtasks`.
    ///
    /// Raw text straight from the OS (locale-formatted); `null` when the task
    /// is unregistered or the query failed, which the UI renders as "—".
    pub next_run: Option<String>,
}

/// Lists the configured scheduled tasks with their Windows registration.
#[tauri::command]
#[specta::specta]
pub fn cron_list(state: State<'_, AppState>) -> Result<Vec<CronStatus>, Error> {
    let jobs = state.with_config(|store| store.config().cron.clone());
    Ok(jobs
        .iter()
        .map(|job| CronStatus {
            name: job.name.clone(),
            program: job.program.clone(),
            php_version: job.php_version.clone(),
            args: job.args.clone(),
            working_dir: job.working_dir.clone(),
            every_minutes: job.every_minutes,
            registered: cron_task_exists(&job.name),
            next_run: cron_task_next_run(&job.name),
        })
        .collect())
}

/// Creates or updates a scheduled task: persist the definition, then
/// reconcile the Windows task with it.
#[tauri::command]
#[specta::specta]
pub async fn cron_set(
    state: State<'_, AppState>,
    name: String,
    program: Option<String>,
    php_version: Option<String>,
    args: Vec<String>,
    working_dir: String,
    every_minutes: u32,
) -> Result<Vec<CronStatus>, Error> {
    let job = devx_core::CronJob {
        name,
        program,
        php_version,
        args,
        working_dir,
        every_minutes,
    };

    // `update` validates the whole config: name shape, program/php_version
    // exclusivity, interval bounds — all before anything persists.
    state.with_config_mut(|store| {
        store.update(|config| {
            config.cron.retain(|c| c.name != job.name);
            config.cron.push(job.clone());
        })
    })?;

    // Reconcile the OS task: config is the intent, schtasks the mechanism.
    cron_task_create(&job).await?;

    cron_list(state)
}

/// Deletes a scheduled task from the config and from Windows.
#[tauri::command]
#[specta::specta]
pub async fn cron_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<CronStatus>, Error> {
    state.with_config_mut(|store| store.update(|config| config.cron.retain(|c| c.name != name)))?;

    cron_task_delete(&name).await;

    cron_list(state)
}

/// The Windows task name for a DevX cron job.
fn cron_task_name(name: &str) -> String {
    format!("{CRON_TASK_PREFIX}{name}")
}

/// Whether the Windows scheduled task for `name` exists.
fn cron_task_exists(name: &str) -> bool {
    use std::os::windows::process::CommandExt as _;

    std::process::Command::new("schtasks")
        .args(["/Query", "/TN", &cron_task_name(name)])
        .creation_flags(0x0800_0000)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Reads the Windows task's `Next Run Time` from `schtasks /Query /V /FO LIST`.
///
/// The value is locale-formatted OS text, shown to the user verbatim —
/// parsing it into a timestamp would mean guessing the user's language.
/// Any failure (unregistered task, unexpected output) becomes `None`, which
/// the UI renders as an em dash rather than a wrong time.
fn cron_task_next_run(name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt as _;

    let output = std::process::Command::new("schtasks")
        .args([
            "/Query",
            "/TN",
            &cron_task_name(name),
            "/V", // verbose: includes scheduling fields
            "/FO",
            "LIST", // one "Field: value" per line
        ])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // Locale-independent on the field name? No: the *label* is localized
        // ("Next Run Time" on English Windows). Match by position instead —
        // the field whose value parses as a date, falling back to the
        // English label, and give up quietly otherwise.
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() || value == "N/A" {
            continue;
        }
        if field.trim().contains("Next Run")
            || (looks_like_datetime(value) && field.trim().contains("Time"))
        {
            return Some(value.to_owned());
        }
    }
    None
}

/// A cheap guess that `value` is a date-time, for localized field fallbacks.
fn looks_like_datetime(value: &str) -> bool {
    let digits = value.chars().filter(|c| c.is_ascii_digit()).count();
    digits >= 6 && value.contains('/') || value.contains('-') && digits >= 6
}

/// The full command line a task runs, resolving a DevX PHP version when set.
///
/// `schtasks` has no start-in-directory flag, so the working directory is
/// part of the command: the payload changes into it before running.
fn cron_command_line(job: &devx_core::CronJob) -> Result<String, Error> {
    let program = match (&job.program, &job.php_version) {
        (Some(program), None) => program.clone(),
        (None, Some(version)) => format!("runtimes/php/{version}/php.exe"),
        _ => {
            return Err(Error::invalid_input(format!(
                "cron job `{}` must set exactly one of program or php_version",
                job.name
            )))
        }
    };

    let mut line = format!("cmd /c cd /d \"{}\"", job.working_dir);
    line.push_str(" && \"");
    line.push_str(&program);
    line.push('"');
    for arg in &job.args {
        line.push(' ');
        line.push_str(arg);
    }
    Ok(line)
}

/// Creates (or overwrites) the Windows scheduled task for `job`.
///
/// Runs per-user and unelevated: `schtasks /Create` for the current user
/// needs no admin, which keeps the helper out of scheduling entirely.
async fn cron_task_create(job: &devx_core::CronJob) -> Result<(), Error> {
    let line = cron_command_line(job)?;

    // /TR is stored verbatim, quotes and all:
    let output = tokio::process::Command::new("schtasks")
        .args([
            "/Create",
            "/TN",
            &cron_task_name(&job.name),
            "/TR",
            &line,
            "/SC",
            "MINUTE",
            "/MO",
            &job.every_minutes.to_string(),
            "/F",
        ])
        .creation_flags(0x0800_0000)
        .output()
        .await
        .map_err(|err| {
            Error::new(
                devx_core::ErrorCode::Process,
                format!("failed to run schtasks: {err}"),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::new(
            devx_core::ErrorCode::Process,
            format!("schtasks failed for `{}`: {}", job.name, stderr.trim()),
        ));
    }

    Ok(())
}

/// Deletes the Windows scheduled task for `name`, tolerating absence.
async fn cron_task_delete(name: &str) {
    let _ = tokio::process::Command::new("schtasks")
        .args(["/Delete", "/TN", &cron_task_name(name), "/F"])
        .creation_flags(0x0800_0000)
        .output()
        .await;
}

/// Prefix of every Windows task name DevX creates.
const CRON_TASK_PREFIX: &str = "DevX ";
