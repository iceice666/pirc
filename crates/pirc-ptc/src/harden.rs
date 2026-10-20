//! What the `ptc-guest` process gives up before it reads its script
//! (security audit S6). Rust-only: TS ran QuickJS compiled to WASM inside
//! Bun, so a QuickJS memory-safety bug stayed inside the WASM instance;
//! the native guest needs the operating system to bound it instead.
//!
//! In this order, before the `start` message is read:
//!
//! 1. Every inherited descriptor but 0–2 closed (`/proc/self/fd` on Linux,
//!    `/dev/fd` elsewhere).
//! 2. Resource limits, hard and soft: `RLIMIT_NOFILE` 3 (no descriptor can
//!    be created), `RLIMIT_CORE` 0 (no core file holding script data);
//!    `RLIMIT_AS` [`ADDRESS_SPACE_BYTES`] but on macOS, which refuses it
//!    (the QuickJS heap limit is QuickJS's own; this bounds the process if
//!    that is bypassed); on Linux `RLIMIT_NPROC` 0 (no fork unless
//!    privileged; behind the filter, for architectures without one).
//! 3. Linux: `PR_SET_NO_NEW_PRIVS`, then on x86_64 and aarch64 a seccomp
//!    filter for every thread ([`allowed_syscalls`]): reads on fd 0,
//!    writes on fds 1 and 2, anonymous memory that is never executable,
//!    futex, clocks, the signal mask and actions, `getppid` (the orphan check),
//!    `getrandom`, aborting itself, and exit. Anything else fails with
//!    `EPERM`, so opening a file, starting a process or making a socket
//!    is refused. Other architectures get no filter (the rest still
//!    applies).
//!
//! The set was measured with `strace -ff` over `crates/pirc-agent/tests/
//! ptc_runtime.rs` and the `agent_*_ptc` conformance transcripts: after
//! start-up the guest calls `read(0)`, `write(1|2)`, `mmap`/`munmap`/
//! `mremap`/`brk`, `futex`, `getrandom`, `getppid`, `rt_sigprocmask`, and
//! on a failed QuickJS assertion `getpid`/`gettid`/`tgkill(self,
//! SIGABRT)`. `madvise`, `mprotect` (never executable), `sigaltstack`,
//! `rt_sigreturn`, `sched_yield`, `restart_syscall` and the clocks are
//! allowed besides, for allocator, signal and vDSO fallback paths, and
//! `rt_sigaction`: Rust's SIGSEGV/SIGBUS handler resets the action to the
//! default and returns so that a fault off the stack guard repeats and
//! kills the process; with the reset refused, a wild access (the QuickJS
//! bug this bounds) would fault and return forever at full CPU.
//!
//! On macOS only the portable part applies: descriptors closed, no new
//! descriptor (so a spawned dynamically linked program cannot load its
//! libraries), no core file; checked on macOS 26.5 arm64. A process can
//! still be spawned there, and memory is bounded by QuickJS alone.
//!
//! Everything here is a safe wrapper (`nix`, `seccompiler`); a step that
//! fails fails the guest (closed, not open).

/// `RLIMIT_AS`: the QuickJS heap (128 MiB) and stack, the executable's own
/// mappings and the allocator's slack, with room to spare (a debug guest
/// whose script exhausts the QuickJS heap peaks at about 180 MiB).
pub const ADDRESS_SPACE_BYTES: u64 = 512 * 1024 * 1024;

/// Harden the calling process as described above; `Err` says which step
/// failed.
pub fn harden() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    nix::sys::prctl::set_dumpable(false).map_err(|error| format!("PR_SET_DUMPABLE: {error}"))?;
    close_inherited_fds()?;
    limit_resources()?;
    #[cfg(target_os = "linux")]
    {
        nix::sys::prctl::set_no_new_privs()
            .map_err(|error| format!("PR_SET_NO_NEW_PRIVS: {error}"))?;
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        seccomp::apply()?;
    }
    Ok(())
}

/// Close every descriptor from 3 up that this process inherited.
fn close_inherited_fds() -> Result<(), String> {
    let dir = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    // Collected first: the listing holds a descriptor of its own, gone
    // (and then refused with EBADF) once the iterator is dropped.
    let fds: Vec<i32> = std::fs::read_dir(dir)
        .map_err(|error| format!("{dir}: {error}"))?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .filter(|fd| *fd > 2)
        .collect();
    for fd in fds {
        match nix::unistd::close(fd) {
            Ok(()) | Err(nix::errno::Errno::EBADF) => {}
            Err(error) => return Err(format!("close({fd}): {error}")),
        }
    }
    Ok(())
}

fn limit_resources() -> Result<(), String> {
    use nix::sys::resource::{Resource, setrlimit};
    let limits = [
        (Resource::RLIMIT_NOFILE, "RLIMIT_NOFILE", 3),
        (Resource::RLIMIT_CORE, "RLIMIT_CORE", 0),
        // macOS refuses `RLIMIT_AS` (EINVAL), and `nix` has no
        // `RLIMIT_NPROC` there.
        #[cfg(not(target_vendor = "apple"))]
        (Resource::RLIMIT_AS, "RLIMIT_AS", ADDRESS_SPACE_BYTES),
        #[cfg(target_os = "linux")]
        (Resource::RLIMIT_NPROC, "RLIMIT_NPROC", 0),
    ];
    for (resource, name, limit) in limits {
        setrlimit(resource, limit, limit).map_err(|error| format!("{name}: {error}"))?;
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod seccomp {
    use std::collections::BTreeMap;

    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen as Len, SeccompCmpOp as Op, SeccompCondition,
        SeccompFilter, SeccompRule, TargetArch,
    };

    #[cfg(target_arch = "aarch64")]
    const ARCH: TargetArch = TargetArch::aarch64;
    #[cfg(target_arch = "x86_64")]
    const ARCH: TargetArch = TargetArch::x86_64;

    fn condition(arg: u8, op: Op, value: u64) -> Result<SeccompCondition, String> {
        SeccompCondition::new(arg, Len::Dword, op, value).map_err(|error| error.to_string())
    }

    fn rule(conditions: Vec<SeccompCondition>) -> Result<SeccompRule, String> {
        SeccompRule::new(conditions).map_err(|error| error.to_string())
    }

    /// The allowed system calls and, where they matter, their arguments
    /// (every condition of a rule must hold; any rule may).
    pub fn allowed_syscalls() -> Result<BTreeMap<i64, Vec<SeccompRule>>, String> {
        let never_exec = |arg| condition(arg, Op::MaskedEq(libc::PROT_EXEC as u64), 0);
        let anonymous = condition(
            3,
            Op::MaskedEq(libc::MAP_ANONYMOUS as u64),
            libc::MAP_ANONYMOUS as u64,
        )?;
        let pid = u64::from(std::process::id());
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
        rules.insert(libc::SYS_read, vec![rule(vec![condition(0, Op::Eq, 0)?])?]);
        rules.insert(
            libc::SYS_write,
            vec![
                rule(vec![condition(0, Op::Eq, 1)?])?,
                rule(vec![condition(0, Op::Eq, 2)?])?,
            ],
        );
        rules.insert(libc::SYS_mmap, vec![rule(vec![anonymous, never_exec(2)?])?]);
        rules.insert(libc::SYS_mprotect, vec![rule(vec![never_exec(2)?])?]);
        // Aborting itself (a failed QuickJS assertion, a Rust abort).
        rules.insert(
            libc::SYS_tgkill,
            vec![rule(vec![
                condition(0, Op::Eq, pid)?,
                condition(2, Op::Eq, libc::SIGABRT as u64)?,
            ])?],
        );
        for syscall in [
            libc::SYS_munmap,
            libc::SYS_mremap,
            libc::SYS_brk,
            libc::SYS_madvise,
            libc::SYS_futex,
            libc::SYS_getrandom,
            libc::SYS_getppid,
            libc::SYS_getpid,
            libc::SYS_gettid,
            libc::SYS_rt_sigprocmask,
            libc::SYS_rt_sigaction,
            libc::SYS_rt_sigreturn,
            libc::SYS_sigaltstack,
            libc::SYS_sched_yield,
            libc::SYS_clock_gettime,
            libc::SYS_clock_getres,
            libc::SYS_gettimeofday,
            libc::SYS_restart_syscall,
            libc::SYS_exit,
            libc::SYS_exit_group,
        ] {
            rules.insert(syscall, Vec::new());
        }
        Ok(rules)
    }

    /// Install the filter on every thread (`SECCOMP_FILTER_FLAG_TSYNC`).
    pub fn apply() -> Result<(), String> {
        let filter = SeccompFilter::new(
            allowed_syscalls()?,
            SeccompAction::Errno(libc::EPERM as u32),
            SeccompAction::Allow,
            ARCH,
        )
        .map_err(|error| format!("seccomp filter: {error}"))?;
        let program: BpfProgram = filter
            .try_into()
            .map_err(|error: seccompiler::BackendError| format!("seccomp filter: {error}"))?;
        seccompiler::apply_filter_all_threads(&program).map_err(|error| format!("seccomp: {error}"))
    }
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
pub use seccomp::allowed_syscalls;
