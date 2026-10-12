//! A panel terminal's PTY (security audit S9). Owner: **hardening** (M7).
//!
//! `pty-process` 0.5 (what M6 used, and the agent's background tasks
//! still use) opens the master with `posix_openpt(O_RDWR | O_NOCTTY)` and
//! sets `FD_CLOEXEC` afterwards: a fork on another thread in between (an
//! agent's bubblewrap or srt, git, a host exec) would inherit the master
//! of the human's unsandboxed shell, and bubblewrap passes inherited
//! descriptors into the sandbox. Here the master is opened with
//! `O_CLOEXEC` (and `O_NONBLOCK`) in the `open(2)` itself, as glibc's
//! `posix_openpt` and macOS's do: `open("/dev/ptmx")`. The slave is opened
//! by `std`, which always passes `O_CLOEXEC`, before the size is set (as
//! pty-process did; macOS requires it).
//!
//! The shell must still be a session leader with the PTY as its
//! controlling terminal (pty-process: `setsid` and `TIOCSCTTY` before
//! `exec`). Without `unsafe` of ours: `process-wrap`'s `ProcessSession`
//! does the `setsid`, and the first program the child runs, `/bin/sh`,
//! reopens the slave by name without `O_NOCTTY` for its stdio (a session
//! leader with no controlling terminal acquires the terminal it opens, on
//! Linux and macOS alike), then `exec`s the shell ([`spawn`]).

use std::ffi::OsStr;
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use process_wrap::tokio::{ChildWrapper, CommandWrap, ProcessSession};
use rustix::fs::{Mode, OFlags};
use tokio::io::unix::AsyncFd;

/// The master side: non-blocking, close-on-exec from its first instant.
pub struct Master(AsyncFd<OwnedFd>);

/// The slave side, open (close-on-exec, not as a controlling terminal) until
/// [`spawn`] hands it to the shell; macOS refuses a window size on a master
/// whose slave was never opened.
pub struct Slave {
    fd: OwnedFd,
    path: PathBuf,
}

/// A new PTY of `rows` x `cols`.
pub fn open(rows: u16, cols: u16) -> io::Result<(Master, Slave)> {
    let master = rustix::fs::open(
        "/dev/ptmx",
        OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )?;
    rustix::pty::grantpt(&master)?;
    rustix::pty::unlockpt(&master)?;
    let name = rustix::pty::ptsname(&master, Vec::new())?;
    let path = PathBuf::from(OsStr::from_bytes(name.as_bytes()));
    let fd = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(OFlags::NOCTTY.bits() as i32)
        .open(&path)?
        .into();
    let master = Master(AsyncFd::new(master)?);
    master.resize(rows, cols)?;
    Ok((master, Slave { fd, path }))
}

impl Master {
    /// `TIOCSWINSZ`.
    pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        rustix::termios::tcsetwinsize(
            self.0.get_ref(),
            rustix::termios::Winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
        )?;
        Ok(())
    }

    /// Read what the terminal wrote; `Ok(0)` or an error (Linux: `EIO`)
    /// once no process holds the slave.
    pub async fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.0.readable().await?;
            if let Ok(result) = ready.try_io(|fd| Ok(rustix::io::read(fd.get_ref(), &mut *buffer)?))
            {
                return result;
            }
        }
    }

    /// Type `bytes` into the terminal.
    pub async fn write_all(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut ready = self.0.writable().await?;
            if let Ok(written) = ready.try_io(|fd| Ok(rustix::io::write(fd.get_ref(), bytes)?)) {
                bytes = &bytes[written?..];
            }
        }
        Ok(())
    }
}

/// Run `shell -l` on the PTY of `slave`: `/bin/sh -c 'exec "$0" -l
/// <>"$1" >&0 2>&0' <shell> <slave path>` in a new session (see the module
/// documentation), with `cwd` and exactly `env`. The child's initial stdio
/// is the slave too, so nothing reads the node's.
pub fn spawn(
    slave: Slave,
    shell: &str,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> io::Result<Box<dyn ChildWrapper>> {
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("exec \"$0\" -l <>\"$1\" >&0 2>&0")
        .arg(shell)
        .arg(&slave.path)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(slave.fd.try_clone()?)
        .stdout(slave.fd.try_clone()?)
        .stderr(slave.fd);
    let mut command = CommandWrap::from(command);
    command.wrap(ProcessSession);
    // `ProcessSession` waits for the whole group; the terminal ends with
    // its shell, as before, so wait on the shell itself.
    Ok(command.spawn()?.into_inner())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn the_master_is_close_on_exec_and_non_blocking() {
        let (master, slave) = open(24, 80).unwrap();
        let fd = master.0.get_ref();
        assert!(
            rustix::io::fcntl_getfd(&slave.fd)
                .unwrap()
                .contains(rustix::io::FdFlags::CLOEXEC)
        );
        assert!(
            rustix::io::fcntl_getfd(fd)
                .unwrap()
                .contains(rustix::io::FdFlags::CLOEXEC)
        );
        assert!(
            rustix::fs::fcntl_getfl(fd)
                .unwrap()
                .contains(OFlags::NONBLOCK)
        );
        assert!(slave.path.exists(), "{:?}", slave.path);
        let size = rustix::termios::tcgetwinsize(fd).unwrap();
        assert_eq!((size.ws_row, size.ws_col), (24, 80));
    }

    /// The program [`spawn`] starts leads its own session with the PTY as
    /// its controlling terminal, its stdio on the PTY. (Where `/bin/sh` is
    /// bash, bash acquires the terminal by itself too; dash and others do
    /// not, which the reopen in [`spawn`] is for.)
    #[tokio::test]
    async fn the_shell_starts_as_a_session_leader_on_the_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("probe");
        crate::test_support::executable(
            &script,
            "#!/bin/sh\n\
             [ \"$1\" = -l ] && echo login\n\
             if : </dev/tty; then echo ctty; fi\n\
             [ -t 0 ] && [ -t 1 ] && [ -t 2 ] && echo stdio\n\
             [ -r /proc/$$/stat ] && cut -d' ' -f6 /proc/$$/stat > sid\n\
             echo $$ > pid\n\
             echo done\n",
        );
        let (master, slave) = open(24, 80).unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH").unwrap_or_default());
        let mut child = spawn(slave, script.to_str().unwrap(), dir.path(), &env).unwrap();
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        let read = async {
            while !String::from_utf8_lossy(&output).contains("done") {
                match master.read(&mut buffer).await {
                    Ok(n @ 1..) => output.extend_from_slice(&buffer[..n]),
                    _ => break,
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(10), read)
            .await
            .unwrap();
        assert!(child.wait().await.unwrap().success());
        let output = String::from_utf8_lossy(&output).replace('\r', "");
        assert_eq!(output, "login\nctty\nstdio\ndone\n");
        let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
        // Linux: the session is the script's.
        let sid = std::fs::read_to_string(dir.path().join("sid")).unwrap_or_default();
        assert!(
            sid.trim().is_empty() || sid.trim() == pid.trim(),
            "{sid} {pid}"
        );
    }

    /// Security audit S9: no process spawned on another thread while PTYs
    /// are opened ever holds a master. `pty-process` 0.5's open, which set
    /// `FD_CLOEXEC` afterwards, leaked into about 4% of such spawns in a
    /// two-second run of this shape; this one into none.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_concurrent_spawn_never_inherits_a_master() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Instant;

        let stop = Arc::new(AtomicBool::new(false));
        let opener = {
            let stop = stop.clone();
            tokio::task::spawn_blocking(move || {
                let mut opened = 0_u32;
                while !stop.load(Ordering::Relaxed) {
                    drop(open(24, 80).unwrap());
                    opened += 1;
                }
                opened
            })
        };
        let started = Instant::now();
        let (mut spawns, mut leaks) = (0, Vec::new());
        while started.elapsed() < Duration::from_millis(1500) {
            let output = std::process::Command::new("ls")
                .args(["-l", "/proc/self/fd"])
                .output()
                .unwrap();
            spawns += 1;
            let listing = String::from_utf8_lossy(&output.stdout).into_owned();
            if listing.contains("ptmx") {
                leaks.push(listing);
            }
        }
        stop.store(true, Ordering::Relaxed);
        let opened = opener.await.unwrap();
        assert!(
            opened > 100 && spawns > 50,
            "{opened} opens, {spawns} spawns"
        );
        assert!(
            leaks.is_empty(),
            "{} of {spawns} spawns inherited a master: {leaks:?}",
            leaks.len()
        );
    }
}
