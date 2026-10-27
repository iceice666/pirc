//! sshd's forwarded agents in `/tmp` (`plan::SSH_AGENT_TMP`) under the
//! native sandbox, for real, behind tmux's `/tmp/ssh-agent-$USER` link for
//! `SSH_AUTH_SOCK` (`/tmp` is a write root of every session). Skipped,
//! with a message, where `bwrap` is not on `PATH`.
//!
//! A binary of its own, its tests one at a time: they make and remove
//! `/tmp/ssh-*` directories, which every plan of the process hides, and a
//! directory removed while another sandbox starts fails that start (see
//! `plan`'s accepted gaps).
//!
//! The agent is this test binary (the `sandbox_client` test, which does
//! nothing unless `PIRC_SSH_TEST_CLIENT` is set), since the sandbox may
//! have no socat.

#![cfg(target_os = "linux")]

mod sandbox_linux_support;

use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use pirc_node::sandbox::Prepared;
use sandbox_linux_support::{Fixture, fixture_env};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const CLIENT: &str = "PIRC_SSH_TEST_CLIENT";

/// One test at a time (see the module docs).
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Inside the sandbox: for each space-separated socket path, one line on
/// stdout, `@@ ` and the socket's answer to `ping` (or why it is
/// unreachable). Every socket after the first waits for a line on stdin.
#[test]
fn sandbox_client() {
    let Ok(targets) = std::env::var(CLIENT) else {
        return;
    };
    for (index, socket) in targets.split(' ').enumerate() {
        if index > 0 {
            let mut line = String::new();
            std::io::stdin().lock().read_line(&mut line).unwrap();
        }
        let result = match std::os::unix::net::UnixStream::connect(socket) {
            Err(error) => format!("unreachable: {:?}", error.kind()),
            Ok(mut stream) => {
                let _ = stream.write_all(b"ping\n");
                let mut reply = String::new();
                let _ = stream.read_to_string(&mut reply);
                reply.trim().to_owned()
            }
        };
        println!("@@ {result}");
        std::io::stdout().flush().unwrap();
    }
    std::process::exit(0);
}

/// A path under `/tmp`, removed (with its contents) when dropped.
struct TmpEntry(PathBuf);

impl TmpEntry {
    fn new(path: String) -> Self {
        let entry = Self(PathBuf::from(path));
        entry.remove();
        entry
    }

    fn remove(&self) {
        let _ = fs::remove_dir_all(&self.0);
        let _ = fs::remove_file(&self.0);
    }
}

impl Drop for TmpEntry {
    fn drop(&mut self) {
        self.remove();
    }
}

/// A Unix socket at `path` answering `agent` to every request line.
fn agent_socket(path: &Path) {
    let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = std::io::BufReader::new(&stream).read_line(&mut line);
            let _ = stream.write_all(b"agent");
        }
    });
}

/// sshd's layout: `/tmp/ssh-<name>/agent.1` and tmux's link to it, and a
/// node whose `SSH_AUTH_SOCK` is the link.
fn layout(name: &str) -> Option<(Fixture, TmpEntry, TmpEntry)> {
    let id = std::process::id();
    let dir = TmpEntry::new(format!("/tmp/ssh-pirc{id}{name}"));
    let link = TmpEntry::new(format!("/tmp/pirc-ssh-agent-{id}{name}"));
    fs::create_dir(&dir.0).unwrap();
    let socket = dir.0.join("agent.1");
    agent_socket(&socket);
    std::os::unix::fs::symlink(&socket, &link.0).unwrap();
    let link_var = link.0.display().to_string();
    let f = fixture_env(
        None,
        &format!("ssh-agent-{name}"),
        r#"{"sandbox":{"network":{"defaultDomains":false,"allowedDomains":["localhost"]}}}"#,
        &[("SSH_AUTH_SOCK", &link_var)],
    )?;
    Some((f, dir, link))
}

/// This test binary as the agent, running [`sandbox_client`] on `sockets`.
fn client(prepared: &Prepared, sockets: &[&Path]) -> tokio::process::Child {
    let command = prepared.command().unwrap();
    // The agent command is /bin/sh in the fixture: swap in the client.
    let mut args: Vec<_> = command.as_std().get_args().map(|a| a.to_owned()).collect();
    let at = args.iter().rposition(|a| a == "/bin/sh").unwrap();
    args[at] = std::env::current_exe().unwrap().into_os_string();
    let targets: Vec<String> = sockets.iter().map(|s| s.display().to_string()).collect();
    let mut rebuilt = tokio::process::Command::new(command.as_std().get_program());
    // The descriptor mapping is not copied with the arguments.
    prepared.prepare_command_fds(&mut rebuilt).unwrap();
    rebuilt
        .args(&args)
        .args([
            "--exact",
            "sandbox_client",
            "--nocapture",
            "--test-threads=1",
        ])
        .envs(prepared.env.iter().map(|(k, v)| (k, v)))
        .env(CLIENT, targets.join(" "))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

/// The client's next result line.
async fn next_result(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> String {
    loop {
        let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("the client ended without a result (see bubblewrap's error above)");
        if let Some((_, result)) = line.split_once("@@ ") {
            return result.to_owned();
        }
    }
}

/// The forwarded agent in a writable root, the link left in place: out of
/// reach through the link and by name.
#[tokio::test]
async fn a_forwarded_ssh_agent_in_tmp_is_hidden() {
    let _serial = SERIAL.lock().await;
    let Some((f, dir, link)) = layout("a") else {
        return;
    };
    let socket = dir.0.join("agent.1");
    let prepared = f.try_prepare("pi_ssh_tmp").await.unwrap();
    let mut child = client(&prepared, &[&link.0, &socket]);
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = next_result(&mut lines).await;
    assert!(
        result.starts_with("unreachable"),
        "through the link: {result}"
    );
    stdin.write_all(b"\n").await.unwrap();
    let result = next_result(&mut lines).await;
    assert!(result.starts_with("unreachable"), "by name: {result}");
    assert!(child.wait().await.unwrap().success());
    prepared.cleanup();
}

/// A reattach while the session runs: sshd makes a new socket and tmux's
/// link is pointed at it. In a `/tmp/ssh-*` directory that existed at
/// plan time it stays hidden. (A `/tmp/ssh-*` directory made after the
/// plan is not: an accepted gap, see `plan`'s docs.)
#[tokio::test]
async fn an_ssh_agent_socket_made_after_the_start_is_hidden() {
    let _serial = SERIAL.lock().await;
    let Some((f, dir, link)) = layout("b") else {
        return;
    };
    let second = dir.0.join("agent.2");
    let prepared = f.try_prepare("pi_ssh_later").await.unwrap();
    let mut child = client(&prepared, &[&link.0, &link.0, &second]);
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = next_result(&mut lines).await;
    assert!(result.starts_with("unreachable"), "before: {result}");
    // The reattach, on the host.
    agent_socket(&second);
    let retarget = link.0.with_extension("new");
    std::os::unix::fs::symlink(&second, &retarget).unwrap();
    fs::rename(&retarget, &link.0).unwrap();
    let mut host = std::os::unix::net::UnixStream::connect(&link.0).unwrap();
    host.write_all(b"ping\n").unwrap();
    let mut reply = String::new();
    host.read_to_string(&mut reply).unwrap();
    assert_eq!(reply, "agent", "the host reaches the new socket");
    stdin.write_all(b"\n").await.unwrap();
    let result = next_result(&mut lines).await;
    assert!(
        result.starts_with("unreachable"),
        "through the link: {result}"
    );
    stdin.write_all(b"\n").await.unwrap();
    let result = next_result(&mut lines).await;
    assert!(result.starts_with("unreachable"), "by name: {result}");
    assert!(child.wait().await.unwrap().success());
    prepared.cleanup();
}
