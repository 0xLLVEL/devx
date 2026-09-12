//! Integration tests for resource metrics sampling.
//!
//! These spawn real (dummy) processes: `cmd /c ping` long enough to sample.

#![cfg(windows)]

use std::time::Duration;

use devx_proc::{HealthCheck, ProcessSpec, RestartPolicy, Supervisor};

fn temp_log_dir(name: &str) -> std::path::PathBuf {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).expect("create log dir");
    // Leak the temp dir; the test process is short-lived.
    std::mem::forget(dir);
    path
}

#[tokio::test]
async fn samples_memory_and_process_count_of_a_running_service() {
    let spec = ProcessSpec {
        args: vec![
            "/c".into(),
            "ping".into(),
            "-n".into(),
            "30".into(),
            "127.0.0.1".into(),
        ],
        health: HealthCheck::Uptime(Duration::from_millis(300)),
        restart: RestartPolicy::Never,
        ..ProcessSpec::new("metrics-dummy", "cmd", temp_log_dir("metrics-dummy"))
    };
    let supervisor = Supervisor::new(spec);
    supervisor.start().await.expect("start");

    // First sample establishes the CPU baseline.
    let first = supervisor.metrics().expect("a live job must be sampleable");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let second = supervisor.metrics().expect("job must still be live");

    assert!(second.memory_bytes > 0, "the child must use some memory");
    assert!(
        second.processes >= 1,
        "the job must contain at least the ping process"
    );
    assert!(
        (0.0..=100.0).contains(&second.cpu_percent),
        "cpu percent must be a normalised share, got {}",
        second.cpu_percent
    );
    let _ = first;

    supervisor.stop().await;

    // After the stop the job slot is cleared: metrics report nothing.
    assert!(supervisor.metrics().is_none(), "stopped job must vanish");
}

#[tokio::test]
async fn metrics_are_none_before_any_start() {
    let spec = ProcessSpec::new("never-started", "cmd", temp_log_dir("never-started"));
    let supervisor = Supervisor::new(spec);

    assert!(supervisor.metrics().is_none());
}
