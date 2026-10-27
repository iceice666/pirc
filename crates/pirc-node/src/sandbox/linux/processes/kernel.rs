use super::{Child, Handle, Kernel};
use std::{io, sync::Arc};
pub(super) struct Platform;

#[cfg(not(target_os = "linux"))]
impl Kernel for Platform {
    fn wrapper(&self, _: u32) -> io::Result<Arc<dyn Handle>> {
        Err(io::Error::other("PID namespace tracking requires Linux"))
    }
    fn capture(&self, _: u32, _: &dyn Handle, _: &Child) -> io::Result<Arc<dyn Handle>> {
        Err(io::Error::other("PID namespace tracking requires Linux"))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use rustix::{
        event::{PollFd, PollFlags, Timespec, poll},
        process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal},
    };
    use std::{
        fs,
        os::{fd::OwnedFd, unix::fs::MetadataExt},
    };

    struct Pinned(OwnedFd);
    impl Pinned {
        fn open(pid: u32) -> io::Result<Self> {
            let raw = i32::try_from(pid).map_err(io::Error::other)?;
            let pid = Pid::from_raw(raw)
                .filter(|_| raw > 1)
                .ok_or_else(|| io::Error::other("invalid PID"))?;
            Ok(Self(pidfd_open(pid, PidfdFlags::empty())?))
        }
    }
    impl Handle for Pinned {
        fn exited(&self) -> io::Result<bool> {
            let mut fds = [PollFd::new(&self.0, PollFlags::IN)];
            poll(&mut fds, Some(&Timespec::default()))?;
            let events = fds[0].revents();
            if events.intersects(PollFlags::ERR | PollFlags::NVAL) {
                return Err(io::Error::other("cannot query pidfd"));
            }
            Ok(events.intersects(PollFlags::IN | PollFlags::HUP))
        }
        fn kill(&self) -> io::Result<()> {
            pidfd_send_signal(&self.0, Signal::KILL).map_err(Into::into)
        }
    }
    impl Kernel for Platform {
        fn wrapper(&self, pid: u32) -> io::Result<Arc<dyn Handle>> {
            Ok(Arc::new(Pinned::open(pid)?))
        }
        fn capture(
            &self,
            wrapper_pid: u32,
            wrapper: &dyn Handle,
            child: &Child,
        ) -> io::Result<Arc<dyn Handle>> {
            let refuse = || io::Error::other("sandbox namespace identity not confirmed");
            if wrapper.exited()? || child.pid == wrapper_pid {
                return Err(refuse());
            }
            let pinned = Pinned::open(child.pid)?;
            let status = fs::read_to_string(format!("/proc/{}/status", child.pid))?;
            let host = fs::metadata("/proc/self/ns/pid")?.ino();
            // Pin before checking /proc, then check both handles again. The
            // trusted live wrapper has exactly one namespace child, so a dead
            // child/PID reused by an unrelated process cannot pass this check.
            // The namespace inode comes from bubblewrap's private status pipe,
            // before it drops privilege. Reading /proc/child/ns/pid here would
            // require ptrace access to the namespace init on some hosts. PPid +
            // NSpid + both live pinned identities validate the same sole child.
            // No setns or as-pid-1 option is used by our native invocation.
            if !namespace_child(&status, wrapper_pid, child.pid)
                || child.namespace == host
                || pinned.exited()?
                || wrapper.exited()?
            {
                return Err(refuse());
            }
            Ok(Arc::new(pinned))
        }
    }
}

/// /proc status is read between acquiring the child pidfd and verifying both
/// handles are still live. A status from a later PID reuse cannot authorize it.
#[cfg(any(target_os = "linux", test))]
fn namespace_child(status: &str, wrapper: u32, child: u32) -> bool {
    let parent = status
        .lines()
        .find_map(|l| l.strip_prefix("PPid:"))
        .and_then(|s| s.trim().parse::<u32>().ok());
    let pids = status
        .lines()
        .find_map(|l| l.strip_prefix("NSpid:"))
        .map(|s| {
            s.split_whitespace()
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
        });
    parent == Some(wrapper)
        && pids.is_some_and(|p| {
            p.is_ok_and(|p| p.len() >= 2 && p.first() == Some(&child) && p.last() == Some(&1))
        })
}

#[cfg(test)]
mod tests {
    use super::namespace_child;
    #[test]
    fn requires_exact_parent_and_namespace_init_identity() {
        assert!(namespace_child("PPid: 7\nNSpid: 22 1\n", 7, 22));
        assert!(namespace_child("PPid: 7\nNSpid: 22 5 1\n", 7, 22));
        for status in [
            "",
            "PPid: 7\nNSpid: 22",
            "PPid: 8\nNSpid: 22 1",
            "PPid: 7\nNSpid: 99 1",
            "PPid: 7\nNSpid: 22 2",
            "PPid: 7\nNSpid: 22 x 1",
        ] {
            assert!(!namespace_child(status, 7, 22), "{status}");
        }
    }
}
