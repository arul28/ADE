//! Child processes: the lane's X server, its window manager and bus, and the
//! apps an agent opens.
//!
//! Every child gets its own process group, so a stop reaches the helpers an
//! app forks (Chrome's zygote and renderers) and not just the pid we started,
//! and a parent-death signal, so a helper that crashes never leaves a lane's
//! X server running with nobody to stop it. The parent-death signal fires when
//! the *thread* that forked exits, so lane children are spawned from the
//! lane's own worker thread, which lives exactly as long as the lane.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Spawned {
    pub child: Child,
    pub pid: i32,
}

pub fn spawn(mut cmd: Command, death_signal: libc::c_int, log_path: Option<&Path>) -> std::io::Result<Spawned> {
    cmd.stdin(Stdio::null());
    match log_path.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok()) {
        Some(file) => {
            let err = file.try_clone()?;
            cmd.stdout(file).stderr(err);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    unsafe {
        cmd.pre_exec(move || {
            libc::setpgid(0, 0);
            libc::prctl(libc::PR_SET_PDEATHSIG, death_signal as libc::c_ulong, 0, 0, 0);
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    let pid = child.id() as i32;
    Ok(Spawned { child, pid })
}


pub fn signal_group(pgid: i32, sig: libc::c_int) {
    if pgid > 1 {
        unsafe {
            libc::kill(-pgid, sig);
        }
    }
}

/// Reaps a child without blocking. True once it has exited.
pub fn reaped(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// SIGTERM the group, wait up to `grace`, then SIGKILL it. True when the
/// leader exited before the kill.
pub fn stop_group(child: &mut Child, pgid: i32, grace: Duration) -> bool {
    if reaped(child) {
        signal_group(pgid, libc::SIGKILL);
        return true;
    }
    signal_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if reaped(child) {
            signal_group(pgid, libc::SIGKILL);
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_group(pgid, libc::SIGKILL);
    let _ = child.wait();
    false
}

/// A program on PATH (or an absolute path that exists), or None.
pub fn which(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return if is_executable(&p) { Some(p) } else { None };
    }
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
    for dir in std::env::split_paths(&path).chain(["/usr/sbin", "/sbin", "/snap/bin"].iter().map(PathBuf::from)) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub fn first_existing(paths: &[&str]) -> Option<PathBuf> {
    paths.iter().map(PathBuf::from).find(|p| is_executable(p))
}

/// The pid's parent, from /proc.
pub fn parent_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 2..];
    after.split_whitespace().nth(1)?.parse().ok()
}


pub fn process_name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string())
}

