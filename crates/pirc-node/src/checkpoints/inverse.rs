//! Standalone inverse merge, never Git against the user's repository/config.
use super::{Result, err, snapshot::Content};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) enum Inverse {
    File(Option<Content>),
    Conflict,
}
pub(super) fn inverse(
    before: Option<&Content>,
    after: Option<&Content>,
    current: Option<&Content>,
    scratch: &Path,
    limit: u64,
) -> Result<Inverse> {
    if before == after || current == before {
        return Ok(Inverse::File(current.cloned()));
    }
    if current == after {
        return Ok(Inverse::File(before.cloned()));
    }
    let (Some(before), Some(after), Some(current)) = (before, after, current) else {
        return Ok(Inverse::Conflict);
    };
    if [&before.bytes, &after.bytes, &current.bytes]
        .iter()
        .any(|b| b.contains(&0) || std::str::from_utf8(b).is_err())
    {
        return Ok(Inverse::Conflict);
    }
    let bytes = if before.bytes == after.bytes {
        current.bytes.clone()
    } else if current.bytes == after.bytes {
        before.bytes.clone()
    } else {
        for (name, bytes) in [
            ("before", &before.bytes),
            ("after", &after.bytes),
            ("current", &current.bytes),
        ] {
            write_new(&scratch.join(name), bytes, false)?;
        }
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(scratch.join("merged"))
            .map_err(err)?;
        let mut child = Command::new("git")
            .current_dir(scratch)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", scratch)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "merge-file",
                "--stdout",
                "--diff3",
                "--",
                "current",
                "after",
                "before",
            ])
            .stdin(Stdio::null())
            .stdout(output)
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(err)?;
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(err)? {
                break status;
            }
            if started.elapsed() > Duration::from_secs(10)
                || fs::metadata(scratch.join("merged")).map_err(err)?.len() > limit
            {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(child.id() as i32),
                    nix::sys::signal::Signal::SIGKILL,
                );
                let _ = child.wait();
                return Err(err("inverse merge exceeded time/output budget"));
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        match status.code() {
            Some(0) => {
                let bytes = fs::read(scratch.join("merged")).map_err(err)?;
                if bytes.len() as u64 > limit {
                    return Err(err("merged file limit exceeded"));
                }
                bytes
            }
            Some(1..=127) => return Ok(Inverse::Conflict),
            _ => return Err(err("inverse merge unavailable")),
        }
    };
    Ok(Inverse::File(Some(Content {
        bytes,
        executable: if current.executable == after.executable {
            before.executable
        } else {
            current.executable
        },
    })))
}
pub(super) fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .mode(if executable { 0o700 } else { 0o600 })
        .open(path)
        .map_err(err)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(err)
}
pub(super) fn sync_dir(path: &Path) -> Result<()> {
    File::open(path).and_then(|f| f.sync_all()).map_err(err)
}
