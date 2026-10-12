//! Escape tests for the hardened `ptc-guest` (security audit S6): after
//! `pirc_ptc::harden::harden()` a process cannot open or create a file,
//! start a process, make a socket, keep an inherited descriptor or grow
//! past its address-space limit, and can still use its stdio and memory.
//! On macOS (no seccomp, no `RLIMIT_AS`) only files and sockets are
//! refused: a process can still be spawned and memory grow.
//!
//! Hardening is irreversible, so each case runs in a child: this binary
//! (`harness = false`) re-executes itself as `<exe> child <case>`.

use std::io::{BufRead, Write};
use std::process::{Command, ExitCode, Stdio};

/// What a hardened child tries; each must be refused.
const ESCAPES: &[&str] = if cfg!(target_os = "linux") {
    &["open", "create", "spawn", "tcp", "unix", "memory"]
} else {
    &["open", "create", "tcp", "unix"]
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("child") {
        return child(&args[2]);
    }
    let exe = std::env::current_exe().unwrap();
    let mut failures = Vec::new();
    for &case in ESCAPES {
        let output = Command::new(&exe)
            .args(["child", case])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let ok = output.status.success() && stdout.starts_with(&format!("{case}: refused"));
        println!(
            "test {case} ... {} ({})",
            if ok { "ok" } else { "FAILED" },
            stdout.trim()
        );
        if !ok {
            failures.push(format!("{case}: {output:?}"));
        }
    }
    match inherited_descriptors(&exe) {
        Ok(()) => println!("test inherited descriptors ... ok"),
        Err(error) => {
            println!("test inherited descriptors ... FAILED");
            failures.push(error);
        }
    }
    if failures.is_empty() {
        println!("\ntest result: ok. {} passed", ESCAPES.len() + 1);
        ExitCode::SUCCESS
    } else {
        println!("\nfailures:\n{}", failures.join("\n"));
        ExitCode::FAILURE
    }
}

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

fn child(case: &str) -> ExitCode {
    // Opened before hardening, without close-on-exec mattering: the
    // descriptor case checks it is closed.
    let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
    let fd = std::os::fd::IntoRawFd::into_raw_fd(file);
    pirc_ptc::harden::harden().unwrap();
    let dir = std::env::temp_dir();
    let attempt: Result<(), String> = match case {
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
