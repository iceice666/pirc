//! The Linux sandbox's seccomp filter: a deny list, not srt's (srt ran
//! without one on Linux, as `allowAllUnixSockets` did; pirc too until
//! this). bubblewrap installs it (`--seccomp`) just before it executes
//! the command, so it binds the bridge, the agent and everything they
//! start, and the read-only sandbox's command.
//!
//! What it refuses, with `EPERM`:
//!
//! - `socket(AF_VSOCK, ...)`. vsock is not part of a network namespace:
//!   the sandbox's own one leaves it open. On WSL 2 the Windows host
//!   listens on vsock (hvsocket) ports, which the sandbox reached past its
//!   proxy and its interop rules ([`super::plan::WSL_INTEROP_DIR`]); a VM
//!   guest's hypervisor, likewise.
//! - `io_uring_setup`. A ring makes sockets (`IORING_OP_SOCKET`) that no
//!   seccomp filter sees, so the rule above would be moot with it; Docker's
//!   default profile refuses it too. Programs that use io_uring fall back
//!   to plain system calls (or fail where they cannot).
//!
//! The filter checks the architecture first (`seccompiler`): a system call
//! of another ABI kills the process. On x86_64 that is i386 code
//! (`int 0x80`, whose `socketcall` would pass a socket number check), so
//! 32-bit programs do not run in the sandbox. x32 calls share x86_64's
//! audit architecture; their numbers are refused as well.
//!
//! Other architectures than x86_64 and aarch64 get no filter
//! ([`program`] is `None`), as the PTC guest's.

use std::io::Write as _;

use command_fds::FdMapping;

/// The descriptor bubblewrap reads the program from: past the read-only
/// sandbox's status descriptor (3), below the long-profile shell's (9).
pub const SECCOMP_FD: i32 = 4;

/// `AF_VSOCK` (Linux's ABI).
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
const AF_VSOCK: u64 = 40;

/// The compiled filter: each `sock_filter` (`code`, `jt`, `jf`, `k`) in
/// native byte order, as bubblewrap reads it. Built once.
pub fn program() -> Option<&'static [u8]> {
    static PROGRAM: std::sync::OnceLock<Option<Vec<u8>>> = std::sync::OnceLock::new();
    PROGRAM
        .get_or_init(|| match build() {
            Ok(program) => program,
            Err(error) => {
                crate::log::error(&format!(
                    "cannot build the sandbox's seccomp filter: {error}"
                ));
                None
            }
        })
        .as_deref()
}

/// bubblewrap's options for the filter (none without one).
pub fn args() -> Vec<String> {
    if program().is_some() {
        vec!["--seccomp".to_owned(), SECCOMP_FD.to_string()]
    } else {
        Vec::new()
    }
}

/// The filter on a pipe, for the child's [`SECCOMP_FD`]; `None` without
/// a filter. The pipe is written and its write end closed before the
/// spawn: the program (well under 1 KiB) fits a pipe's buffer. Each
/// command needs its own (bubblewrap reads it to the end).
pub fn mapping() -> std::io::Result<Option<FdMapping>> {
    let Some(program) = program() else {
        return Ok(None);
    };
    let (reader, mut writer) = std::io::pipe()?;
    writer.write_all(program)?;
    drop(writer);
    Ok(Some(FdMapping {
        parent_fd: reader.into(),
        child_fd: SECCOMP_FD,
    }))
}

/// Map the filter onto `command`'s [`SECCOMP_FD`]: for a command that
/// runs bubblewrap with [`args`] and no other descriptor mapped (a
/// session's; a caller rebuilding one from `Prepared::command`'s program
/// and arguments). Without it, bubblewrap refuses to start.
pub fn pass(command: &mut tokio::process::Command) -> std::io::Result<()> {
    use command_fds::CommandFdExt as _;
    if let Some(mapping) = mapping()? {
        command
            .fd_mappings(vec![mapping])
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn build() -> Result<Option<Vec<u8>>, String> {
    use std::collections::BTreeMap;

    use nix::libc;
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule, TargetArch,
    };

    #[cfg(target_arch = "aarch64")]
    const ARCH: TargetArch = TargetArch::aarch64;
    #[cfg(target_arch = "x86_64")]
    const ARCH: TargetArch = TargetArch::x86_64;

    let vsock = || -> Result<SeccompRule, String> {
        let domain = SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, AF_VSOCK)
            .map_err(|error| error.to_string())?;
        SeccompRule::new(vec![domain]).map_err(|error| error.to_string())
    };
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    rules.insert(libc::SYS_socket, vec![vsock()?]);
    rules.insert(libc::SYS_io_uring_setup, Vec::new());
    #[cfg(target_arch = "x86_64")]
    {
        /// `__X32_SYSCALL_BIT`.
        const X32: i64 = 0x4000_0000;
        rules.insert(X32 | libc::SYS_socket, vec![vsock()?]);
        rules.insert(X32 | libc::SYS_io_uring_setup, Vec::new());
    }
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        ARCH,
    )
    .map_err(|error| error.to_string())?;
    let program: BpfProgram = filter
        .try_into()
        .map_err(|error: seccompiler::BackendError| error.to_string())?;
    let mut bytes = Vec::with_capacity(program.len() * 8);
    for instruction in program {
        bytes.extend(instruction.code.to_ne_bytes());
        bytes.push(instruction.jt);
        bytes.push(instruction.jf);
        bytes.extend(instruction.k.to_ne_bytes());
    }
    Ok(Some(bytes))
}

#[cfg(not(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
)))]
fn build() -> Result<Option<Vec<u8>>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_program_goes_to_bubblewrap_where_there_is_one() {
        let supported = cfg!(all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ));
        assert_eq!(program().is_some(), supported);
        if let Some(program) = program() {
            assert!(!program.is_empty() && program.len() % 8 == 0);
            assert!(program.len() < 4096, "fits a pipe's buffer");
            assert_eq!(args(), ["--seccomp", "4"]);
            let mapping = mapping().unwrap().unwrap();
            assert_eq!(mapping.child_fd, SECCOMP_FD);
        } else {
            assert!(args().is_empty());
            assert!(mapping().unwrap().is_none());
        }
    }
}
