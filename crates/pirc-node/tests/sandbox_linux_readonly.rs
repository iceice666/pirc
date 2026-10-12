//! `NativeSandbox`'s read-only sandbox (`Sandbox::prepare_readonly`, panel
//! git under security audit S8): bubblewrap with a read policy, no write
//! path, no network and no proxy. The policy is built here (the node's
//! `common::readonly_session` is the hardening worker's). Skipped, with a
//! message, where `bwrap` is not on `PATH`.

#![cfg(target_os = "linux")]

mod sandbox_linux_support;

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use pirc_node::sandbox::Prepared;
use pirc_policy::PathPolicy;
use pirc_policy::session::SessionPolicy;
use sandbox_linux_support::{Fixture, fixture, path, run};

const CLIENT: &str = "PIRC_READONLY_TEST_CLIENT";

/// Inside the sandbox: connect to the host's port `$PIRC_READONLY_TEST_CLIENT`.
#[test]
fn readonly_client() {
    let Ok(port) = std::env::var(CLIENT) else {
        return;
    };
    let result = std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(3),
    );
    println!(
        "@@ {}",
        if result.is_ok() {
            "connected"
        } else {
            "refused"
        }
    );
    std::process::exit(0);
}

/// What a session of the workspace may read, and nothing to write.
fn read_policy(f: &Fixture) -> SessionPolicy {
    SessionPolicy {
        paths: PathPolicy {
            deny_read: vec![path(&f.root, "home/.ssh"), path(&f.root, "state")],
            allow_read: vec![path(&f.root, "workspace")],
            ..PathPolicy::default()
        },
        ..SessionPolicy::default()
    }
}

async fn readonly(f: &Fixture, command: &[&str]) -> Prepared {
    f.sandbox
        .prepare_readonly_with(
            read_policy(f),
            &f.root.join("workspace"),
            command.iter().map(OsString::from).collect(),
        )
        .await
        .unwrap()
}

async fn sh(f: &Fixture, script: &str) -> i32 {
    let prepared = readonly(f, &["/bin/sh", "-c", script]).await;
    let code = run(&prepared, &[], &f.root.join("workspace")).await;
    prepared.cleanup();
    code
}

#[tokio::test]
async fn runs_a_command_read_only_without_network() {
    let Some(f) = fixture("readonly") else {
        return;
    };
    let (root, w) = (&f.root, path(&f.root, "workspace"));
    let prepared = readonly(&f, &["/bin/true", "x"]).await;
    assert!(!prepared.has_control(), "no network control");
    assert!(prepared.env.is_empty());
    let args: Vec<_> = prepared
        .args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args[args.len() - 3..], ["--", "/bin/true", "x"]);
    assert!(args.contains(&"--unshare-net".to_owned()));
    assert!(
        !args
            .iter()
            .any(|a| a.contains("PROXY") || a.contains("sandbox-bridge"))
    );
    prepared.cleanup();

    let cases = [
        ("read the workspace", format!("cat {w}/README"), true),
        ("write the workspace", format!("echo x > {w}/new"), false),
        (
            "write .git",
            format!("echo x > {w}/.git/description"),
            false,
        ),
        (
            "write /tmp",
            "echo x > /tmp/pirc-readonly-$$".to_owned(),
            false,
        ),
        (
            "read ~/.ssh",
            format!("cat {}/.ssh/id_ed25519", path(root, "home")),
            false,
        ),
        (
            "read the node's state",
            format!("cat {}/secret", path(root, "state")),
            false,
        ),
        (
            "see a host process",
            format!("kill -0 {}", std::process::id()),
            false,
        ),
    ];
    let mut failures = Vec::new();
    for (name, script, expect) in &cases {
        let code = sh(&f, script).await;
        if (code == 0) != *expect {
            failures.push(format!("{name}: exit {code}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
    assert!(!root.join("workspace/new").exists());

    // No network: a host listener is out of reach.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let exe = std::env::current_exe().unwrap().display().to_string();
    let prepared = readonly(&f, &[&exe, "--exact", "readonly_client", "--nocapture"]).await;
    let mut command = prepared.command().unwrap();
    command
        .env(CLIENT, &port)
        .stdout(Stdio::piped())
        .stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("@@ refused"), "{stdout}");
    prepared.cleanup();
}

/// Panel git's use: status and log work in the sandbox, nothing it runs can
/// write the repository.
#[tokio::test]
async fn git_reads_but_cannot_write() {
    let Some(f) = fixture("readonly-git") else {
        return;
    };
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("skipped: git is not on PATH");
        return;
    }
    let w = f.root.join("workspace");
    std::fs::remove_dir_all(w.join(".git")).unwrap();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .current_dir(&w)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["add", "README"]);
    git(&["commit", "-qm", "first"]);
    let head = std::fs::read_to_string(w.join(".git/HEAD")).unwrap();
    let ws = w.display().to_string();
    let run_git = async |args: &[&str]| {
        let mut command = vec!["git", "-C", ws.as_str()];
        command.extend_from_slice(args);
        let prepared = readonly(&f, &command).await;
        let code = run(&prepared, &[], Path::new(&w)).await;
        prepared.cleanup();
        code
    };
    assert_eq!(run_git(&["status", "--porcelain"]).await, 0);
    assert_eq!(run_git(&["log", "--oneline"]).await, 0);
    assert_ne!(
        run_git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@e",
            "commit",
            "--allow-empty",
            "-qm",
            "x"
        ])
        .await,
        0
    );
    assert_ne!(
        run_git(&["config", "core.fsmonitor", "touch /tmp/x"]).await,
        0
    );
    assert_eq!(std::fs::read_to_string(w.join(".git/HEAD")).unwrap(), head);
    assert!(
        !std::fs::read_to_string(w.join(".git/config"))
            .unwrap()
            .contains("fsmonitor")
    );
}
