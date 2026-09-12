//! Windows Job Object wrapper for orphan-proof process supervision.
//!
//! The failure this prevents: DevX spawns `mysqld`, then DevX itself is killed
//! (crash, Task Manager, a hard `taskkill`). Without a job object, `mysqld`
//! keeps running, holding its port and data directory, and the next launch
//! collides with a ghost. Laragon and XAMPP both suffer from this.
//!
//! A job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ties every assigned
//! process to the job's handle: when the handle closes (including on abnormal
//! termination, because Windows closes handles for us), the kernel terminates
//! the whole job. Assigning a child to the job right after spawn therefore makes
//! it impossible to leak.

#![cfg(windows)]

use devx_core::{Error, ErrorCode, Result};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// An owned job object that kills its members when dropped.
#[derive(Debug)]
pub struct JobObject {
    handle: HANDLE,
}

// A job handle is just a kernel handle; it is safe to move across threads.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// The raw job handle, for queries such as metrics sampling.
    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    /// Creates a job configured to kill its processes when the handle closes.
    pub fn new() -> Result<Self> {
        // SAFETY: creating an anonymous job object with no security attributes
        // and no name.
        let handle =
            unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }.map_err(|err| {
                Error::new(ErrorCode::Process, format!("CreateJobObject failed: {err}"))
            })?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `info` is a correctly sized, initialised structure and
        // `handle` is the job just created.
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .expect("struct size fits in u32"),
            )
        };

        if let Err(err) = result {
            // Do not leak the handle if configuration failed.
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(Error::new(
                ErrorCode::Process,
                format!("SetInformationJobObject failed: {err}"),
            ));
        }

        Ok(Self { handle })
    }

    /// Assigns a process, identified by its raw handle, to this job.
    ///
    /// # Safety
    ///
    /// `process_handle` must be a valid, open process handle for the lifetime of
    /// this call. In practice it comes straight from a just-spawned child.
    pub unsafe fn assign(&self, process_handle: HANDLE) -> Result<()> {
        AssignProcessToJobObject(self.handle, process_handle).map_err(|err| {
            Error::new(
                ErrorCode::Process,
                format!("AssignProcessToJobObject failed: {err}"),
            )
        })
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        // Closing the handle triggers KILL_ON_JOB_CLOSE, terminating every
        // assigned process. This is the whole point of the type.
        // SAFETY: the handle was created in `new` and not closed elsewhere.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_drops_a_job_object() {
        // Creation exercises both CreateJobObject and SetInformationJobObject;
        // drop exercises CloseHandle. A leak or bad flag would surface here.
        let job = JobObject::new().expect("create job object");
        drop(job);
    }

    #[test]
    fn kills_an_assigned_process_when_the_job_is_dropped() {
        use std::os::windows::io::AsRawHandle;
        use std::process::Command;
        use windows::Win32::Foundation::HANDLE;

        // A process that would otherwise run for a long time.
        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "60", "127.0.0.1"])
            .spawn()
            .expect("spawn child");

        let job = JobObject::new().expect("job");
        // SAFETY: the child is alive and its handle valid until we wait on it.
        unsafe {
            job.assign(HANDLE(child.as_raw_handle() as _))
                .expect("assign");
        }

        // Dropping the job must terminate the assigned process.
        drop(job);

        // The child should now exit promptly rather than pinging for a minute.
        let start = std::time::Instant::now();
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => break,
                None if start.elapsed() > std::time::Duration::from_secs(10) => {
                    let _ = child.kill();
                    panic!("assigned process was not killed when the job dropped");
                }
                None => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
    }
}
