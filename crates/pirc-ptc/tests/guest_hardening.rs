//! Escape tests for the hardened `ptc-guest` (security audit S6): after
//! `pirc_ptc::harden::harden()` a process cannot open or create a file,
//! start a process, make a socket, keep an inherited descriptor or grow
//! past its address-space limit, and can still use its stdio and memory.
//! On macOS (no seccomp, no `RLIMIT_AS`) only files and sockets are
//! refused: a process can still be spawned and memory grow.
//!
//! Where the seccomp filter applies (Linux x86_64 and aarch64), every
//! refusal must be its `EPERM`, not the rlimits' `EMFILE` or `EAGAIN`,
//! and the cases that need no new descriptor (`remove`, `mkdir`, `rename`,
//! `kill`, `chdir`) are refused by the filter alone: without it the suite
//! fails.
//!
//! Hardening is irreversible, so each case runs in a child: this binary
//! (`harness = false`) re-executes itself as `<exe> child <case>`.

use std::io::{BufRead, Write};
use std::process::{Command, ExitCode, Stdio};

/// Whether the seccomp filter applies here.
const SECCOMP: bool = cfg!(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
));

/// What a hardened child tries; each must be refused.
const ESCAPES: &[&str] = if SECCOMP {
    &[
        "open", "create", "spawn", "tcp", "unix", "memory", "remove", "mkdir", "rename", "kill",
        "chdir",
    ]
} else if cfg!(target_os = "linux") {
    &["open", "create", "spawn", "tcp", "unix", "memory"]
} else {
    &["open", "create", "tcp", "unix"]
};

/// The scratch directory (with a file `victim`) the parent makes for the
/// descriptor-free cases.
const SCRATCH: &str = "PIRC_HARDENING_SCRATCH";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("child") {
        return child(&args[2]);
    }
    let exe = std::env::current_exe().unwrap();
    let scratch = std::env::temp_dir().join(format!("pirc-ptc-hardening-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join("victim"), "x").unwrap();
    let mut failures = Vec::new();
    for &case in ESCAPES {
        let output = Command::new(&exe)
            .args(["child", case])
            .env(SCRATCH, &scratch)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        // The filter's errno, where it applies (memory is the allocator's).
        let by_filter = !SECCOMP || case == "memory" || stdout.contains("(os error 1)");
        let ok =
            output.status.success() && stdout.starts_with(&format!("{case}: refused")) && by_filter;
        println!(
            "test {case} ... {} ({})",
            if ok { "ok" } else { "FAILED" },
            stdout.trim()
        );
        if !ok {
            failures.push(format!("{case}: {output:?}"));
        }
    }
    let checks: [(&str, Check); 3] = [
        ("inherited descriptors", inherited_descriptors),
        ("a fault kills", a_fault_kills),
        ("local time", local_time),
    ];
    for (name, check) in checks {
        match check(&exe) {
            Ok(()) => println!("test {name} ... ok"),
            Err(error) => {
                println!("test {name} ... FAILED");
                failures.push(error);
            }
        }
    }
    if failures.is_empty() {
        let untouched = scratch.join("victim").is_file()
            && std::fs::read_dir(&scratch).map(Iterator::count).ok() == Some(1);
        let _ = std::fs::remove_dir_all(&scratch);
        if !untouched {
            println!("\nfailures:\nthe scratch directory changed");
            return ExitCode::FAILURE;
        }
        println!("\ntest result: ok. {} passed", ESCAPES.len() + checks.len());
        ExitCode::SUCCESS
    } else {
        let _ = std::fs::remove_dir_all(&scratch);
        println!("\nfailures:\n{}", failures.join("\n"));
        ExitCode::FAILURE
    }
}

/// A check run by the parent, with this executable.
type Check = fn(&std::path::Path) -> Result<(), String>;

/// A descriptor open before hardening is gone after it (Linux: read from
/// `/proc/<pid>/fd` while the child waits on stdin; elsewhere skipped).
fn inherited_descriptors(exe: &std::path::Path) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Ok(());
    }
    let mut child = Command::new(exe)
        .args(["child", "descriptors"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let open: Vec<String> = std::fs::read_dir(format!("/proc/{}/fd", child.id()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    let mut sorted = open.clone();
    sorted.sort();
    if line.trim() != "hardened 3" || sorted != ["0", "1", "2"] || !status.success() {
        return Err(format!("descriptors: {line:?}, open {open:?}, {status}"));
    }
    Ok(())
}

/// A hardened process that faults dies of it at once. Rust's runtime
/// handles SIGSEGV: off the stack guard it resets the action to the
/// default and returns, so the fault repeats and kills; with that reset
/// refused, a wild access in QuickJS would spin forever. The fault is the
/// parent's `kill(SIGSEGV)`, repeated as a faulting instruction repeats
/// (no `unsafe` here).
fn a_fault_kills(exe: &std::path::Path) -> Result<(), String> {
    use std::os::unix::process::ExitStatusExt;
    use std::time::{Duration, Instant};
    let mut child = Command::new(exe)
        .args(["child", "fault"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    if line.trim() != "hardened" {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("fault: {line:?}"));
    }
    let pid = nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap());
    let deadline = Instant::now() + Duration::from_secs(1);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() > deadline {
            break None;
        }
        let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGSEGV);
        std::thread::sleep(Duration::from_millis(50));
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("fault: the hardened child survived SIGSEGV for 1 s".to_owned());
    };
    if status.signal() != Some(nix::libc::SIGSEGV) {
        return Err(format!("fault: {status}"));
    }
    Ok(())
}

/// The hardened guest keeps local time: the time zone is loaded before
/// the filter refuses its file (a zone without daylight saving time).
fn local_time(exe: &std::path::Path) -> Result<(), String> {
    let zone = std::env::var_os("TZDIR")
        .map(std::path::PathBuf::from)
        .into_iter()
        .chain(["/usr/share/zoneinfo".into(), "/etc/zoneinfo".into()])
        .map(|dir| dir.join("Asia/Taipei"))
        .find(|file| file.is_file());
    let Some(zone) = zone else {
        println!("(local time skipped: no zoneinfo for Asia/Taipei)");
        return Ok(());
    };
    let mut child = Command::new(exe)
        .args(["child", "guest"])
        .env("TZ", format!(":{}", zone.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let start = r#"{"type":"start","code":"async function __ptc_main() { return String(new Date(0).getTimezoneOffset()) + ' ' + new Date(0).getHours(); }","manifest":[]}"#;
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{start}").unwrap();
    let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let done = stdout
        .lines()
        .map_while(Result::ok)
        .find(|line| line.contains(r#""type":"done""#));
    drop(stdin);
    let _ = child.wait();
    match done {
        Some(line) if line.contains(r#""-480 8""#) => Ok(()),
        other => Err(format!("local time: {other:?}")),
    }
}

fn child(case: &str) -> ExitCode {
    if case == "guest" {
        return pirc_ptc::guest::run();
    }
    // Opened before hardening, without close-on-exec mattering: the
    // descriptor case checks it is closed.
    let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
    let fd = std::os::fd::IntoRawFd::into_raw_fd(file);
    let scratch = std::path::PathBuf::from(std::env::var_os(SCRATCH).unwrap_or_default());
    pirc_ptc::harden::harden().unwrap();
    let dir = std::env::temp_dir();
    let attempt: Result<(), String> = match case {
        "fault" => {
            println!("hardened");
            std::io::stdout().flush().unwrap();
            let mut rest = String::new();
            let _ = std::io::stdin().lock().read_line(&mut rest);
            return ExitCode::SUCCESS;
        }
        "descriptors" => {
            println!("hardened {fd}");
            std::io::stdout().flush().unwrap();
            // Wait for the parent to look, through stdin (still allowed).
            let mut rest = String::new();
            let _ = std::io::stdin().lock().read_line(&mut rest);
            return ExitCode::SUCCESS;
        }
        "open" => std::fs::File::open("/etc/passwd")
            .map(drop)
            .map_err(|e| e.to_string()),
        "create" => std::fs::File::create(dir.join("pirc-ptc-hardened"))
            .map(drop)
            .map_err(|e| e.to_string()),
        "spawn" => Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .status()
            .map(drop)
            .map_err(|e| e.to_string()),
        "tcp" => std::net::TcpListener::bind("127.0.0.1:0")
            .map(drop)
            .map_err(|e| e.to_string()),
        "unix" => std::os::unix::net::UnixDatagram::unbound()
            .map(drop)
            .map_err(|e| e.to_string()),
        // No new descriptor: only the filter refuses these.
        "remove" => std::fs::remove_file(scratch.join("victim")).map_err(|e| e.to_string()),
        "mkdir" => std::fs::create_dir(scratch.join("made")).map_err(|e| e.to_string()),
        "rename" => std::fs::rename(scratch.join("victim"), scratch.join("renamed"))
            .map_err(|e| e.to_string()),
        "kill" => nix::sys::signal::kill(nix::unistd::getppid(), None)
            .map_err(|e| std::io::Error::from(e).to_string()),
        "chdir" => std::env::set_current_dir("/").map_err(|e| e.to_string()),
        "memory" => {
            // Small allocations still work; past RLIMIT_AS they fail.
            let small = vec![1u8; 64 * 1024 * 1024];
            assert_eq!(
                small.iter().map(|b| usize::from(*b)).sum::<usize>(),
                64 << 20
            );
            let mut big: Vec<u8> = Vec::new();
            big.try_reserve_exact(2 * 1024 * 1024 * 1024)
                .map_err(|e| e.to_string())
        }
        other => panic!("unknown case {other}"),
    };
    // stdout and stderr still work.
    match attempt {
        Ok(()) => println!("{case}: allowed"),
        Err(error) => println!("{case}: refused ({error})"),
    }
    eprintln!("stderr works");
    ExitCode::SUCCESS
}
