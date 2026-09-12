//! Point-in-time resource metrics for supervised services.
//!
//! A service's resource use is the aggregate of the live processes in its job
//! object: CPU time from [`GetProcessTimes`] and resident memory from
//! [`GetProcessMemoryInfo`]. CPU percent needs a previous sample to subtract
//! from, so callers keep the last [`Sample`] per service and pass it back in.
//!
//! Sampling is pull-based (a command polls the registry) rather than pushed:
//! only the frontend's visible page needs the numbers, and a background
//! sampler would burn the same OpenProcess calls regardless.

#![cfg(windows)]

use std::sync::Arc;
use std::time::Instant;

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::JobObjects::{
    JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::job::JobObject;

/// A previous CPU reading, kept so the next one can form a delta.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// Kernel + user time of all processes, in 100-nanosecond units.
    pub cpu_time: u64,
    /// When the reading was taken.
    pub wall: Instant,
}

/// One measurement of a job's resource use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawMetrics {
    /// CPU use since the previous sample, normalised to one core (0–100).
    pub cpu_percent: f64,
    /// Resident memory of every live process, in bytes.
    pub memory_bytes: u64,
    /// How many live processes the job contains.
    pub processes: u32,
}

/// Number of process ids a single job query can return.
const MAX_PROCESSES: usize = 1024;

/// Samples CPU and memory of every process in `job`, updating `previous` with
/// the reading this call produced.
///
/// Returns `None` when the job cannot be queried (it is gone, or the call
/// failed); metrics are best-effort by design.
pub fn sample_job(job: &Arc<JobObject>, previous: &mut Option<Sample>) -> Option<RawMetrics> {
    let pids = job_pids(job.handle())?;

    let mut cpu_time = 0u64;
    let mut memory_bytes = 0u64;
    let mut processes = 0u32;
    for pid in pids {
        if let Some((time, memory)) = process_stats(pid) {
            cpu_time += time;
            memory_bytes += memory;
            processes += 1;
        }
    }

    let now = Instant::now();
    let cpu_percent = match previous {
        Some(sample) => compute_cpu_percent(*sample, cpu_time, now, available_cores()),
        None => 0.0,
    };
    *previous = Some(Sample {
        cpu_time,
        wall: now,
    });

    Some(RawMetrics {
        cpu_percent,
        memory_bytes,
        processes,
    })
}

/// CPU percent between two samples, normalised so 100% means one whole core.
///
/// Job CPU time counts 100-nanosecond units across every process and thread;
/// dividing by the wall time and the core count turns it into a share a UI can
/// render as a single bar.
pub fn compute_cpu_percent(previous: Sample, cpu_time: u64, now: Instant, cores: u64) -> f64 {
    let cpu_seconds = cpu_time.saturating_sub(previous.cpu_time) as f64 / 10_000_000.0;
    let wall_seconds = now.duration_since(previous.wall).as_secs_f64();

    if wall_seconds <= 0.0 || cores == 0 {
        return 0.0;
    }

    (cpu_seconds / wall_seconds / cores as f64 * 100.0).clamp(0.0, 100.0)
}

/// Logical cores available to the process.
fn available_cores() -> u64 {
    u64::try_from(
        std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
    )
    .unwrap_or(1)
}

/// The process ids currently assigned to `job`.
fn job_pids(job: HANDLE) -> Option<Vec<usize>> {
    // The struct ends with a fixed-size array; over-allocating and casting the
    // buffer lets one query return up to MAX_PROCESSES ids.
    let buffer_len = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
        + (MAX_PROCESSES - 1) * std::mem::size_of::<usize>();
    let mut buffer = vec![0u8; buffer_len];

    let result = unsafe {
        QueryInformationJobObject(
            Some(job),
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).ok()?,
            None,
        )
    };
    result.ok()?;

    let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
    let count = list.NumberOfProcessIdsInList as usize;
    if count == 0 || count > MAX_PROCESSES {
        return Some(Vec::new());
    }

    let ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count) };
    Some(ids.to_vec())
}

/// Total CPU time (100ns units) and resident memory of one process.
fn process_stats(pid: usize) -> Option<(u64, u64)> {
    let pid = u32::try_from(pid).ok()?;

    // SAFETY: the handle is opened, read and closed within this function.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let stats = process_stats_with_handle(process);
        let _ = CloseHandle(process);
        stats
    }
}

/// Reads the stats through an already-open process handle.
///
/// # Safety
///
/// `process` must be a valid handle opened with
/// `PROCESS_QUERY_LIMITED_INFORMATION`.
unsafe fn process_stats_with_handle(process: HANDLE) -> Option<(u64, u64)> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    GetProcessMemoryInfo(
        process,
        &mut counters,
        u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS>())
            .expect("struct size fits in u32"),
    )
    .ok()?;

    Some((
        filetime_as_100ns(&kernel) + filetime_as_100ns(&user),
        u64::try_from(counters.WorkingSetSize).unwrap_or(u64::MAX),
    ))
}

/// Converts a `FILETIME` to its 100-nanosecond unit count.
fn filetime_as_100ns(value: &FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn cpu_percent_is_zero_without_elapsed_cpu_time() {
        let now = Instant::now();
        let previous = Sample {
            cpu_time: 1_000_000,
            wall: now - Duration::from_secs(1),
        };

        assert_eq!(
            compute_cpu_percent(previous, 1_000_000, now, 4),
            0.0,
            "no delta means no CPU use"
        );
    }

    #[test]
    fn cpu_percent_reflects_the_delta_between_samples() {
        let now = Instant::now();
        let previous = Sample {
            cpu_time: 0,
            wall: now - Duration::from_secs(1),
        };

        // 0.25s of CPU time across 1s of wall time on one core.
        let percent = compute_cpu_percent(previous, 2_500_000, now, 1);
        assert!((percent - 25.0).abs() < 0.1, "got {percent}");

        // The same CPU share across four cores reads as 100/4 of the bar.
        let quarter = compute_cpu_percent(previous, 2_500_000, now, 4);
        assert!((quarter - 6.25).abs() < 0.1, "got {quarter}");
    }

    #[test]
    fn cpu_percent_is_clamped_and_safe_against_bad_input() {
        let now = Instant::now();
        let previous = Sample {
            cpu_time: 0,
            wall: now - Duration::from_secs(1),
        };

        // Far more CPU time than wall time (many threads) clamps to full.
        assert_eq!(compute_cpu_percent(previous, 500_000_000, now, 1), 100.0);
        // A zero core count must not divide by zero.
        assert_eq!(compute_cpu_percent(previous, 2_500_000, now, 0), 0.0);
        // A sample "in the future" must not divide by zero either.
        let future = Sample {
            cpu_time: 0,
            wall: now + Duration::from_secs(1),
        };
        assert_eq!(compute_cpu_percent(future, 2_500_000, now, 1), 0.0);
    }

    #[test]
    fn filetime_conversion_combines_both_halves() {
        let value = FILETIME {
            dwLowDateTime: 0x1234_5678,
            dwHighDateTime: 0x0000_00AB,
        };
        assert_eq!(filetime_as_100ns(&value), 0x0000_00AB_1234_5678);
    }
}
