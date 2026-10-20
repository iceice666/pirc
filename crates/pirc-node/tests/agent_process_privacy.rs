//! Linux /proc must not turn arbitrary tool processes into the RPC agent.
#![cfg(target_os = "linux")]
use std::fs::OpenOptions;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn agent_rpc_stdio_cannot_be_reopened_through_proc() {
    // The boundary excludes a privileged host tracer; native sandboxes drop
    // CAP_SYS_PTRACE. Normal CI/deployment users have no such capability.
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let caps = status
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:\t"))
        .and_then(|v| u64::from_str_radix(v.trim(), 16).ok())
        .unwrap();
    if caps & (1 << 19) != 0 {
        eprintln!("skipped: host test process has CAP_SYS_PTRACE");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pirc-node"))
        .args(["agent", "--session-dir"])
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let inaccessible = |pid| {
        (0..=2).all(|fd| {
            [true, false].iter().all(|read| {
                let error = OpenOptions::new()
                    .read(*read)
                    .write(!*read)
                    .open(format!("/proc/{pid}/fd/{fd}"))
                    .err();
                error.is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
            })
        })
    };
    let mut protected = false;
    while Instant::now() < deadline && child.try_wait().unwrap().is_none() {
        if inaccessible(child.id()) {
            protected = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = child.kill();
    let output = child.wait_with_output().unwrap();
    assert!(
        protected,
        "agent RPC descriptors were accessible: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
