//! The native sandbox's network for real: bubblewrap, the bridge's two
//! ports, the proxy's HTTP and SOCKS5 sides, the environment the agent
//! gets (`GIT_SSH_COMMAND`, `ALL_PROXY`, `FTP_PROXY`), approvals and the
//! resolved-address guard. Skipped, with a message, where `bwrap` is not
//! on `PATH`; the `curl`, `ssh` and `nc` cases also where those are missing.
//!
//! The agent is `/bin/sh -c <script>`; the destinations are servers of
//! this test on the host's loopback, which the sandbox (its own network
//! namespace) reaches only through the proxy.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use pirc_config::{Env, NodeConfig};
use pirc_node::sandbox::linux::{NativeSandbox, find_bwrap};
use pirc_node::sandbox::{PrepareInput, Prepared, Sandbox};
use pirc_protocol::NodeRole;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    root: PathBuf,
    config: NodeConfig,
    sandbox: NativeSandbox,
    path: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A node whose sessions may reach `allowed` but not `denied`, or `None`
/// without bubblewrap.
fn fixture(name: &str, allowed: &[&str], denied: &[&str]) -> Option<Fixture> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    if find_bwrap(&Env::new([("PATH", path_var.as_str())], "/")).is_none() {
        eprintln!("skipped: bwrap is not on PATH, so the native sandbox cannot be tested here");
        return None;
    }
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("sandbox-network-{name}"));
    let _ = fs::remove_dir_all(&root);
    for dir in ["home", "state", "config", "workspace", "tmp"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = fs::canonicalize(&root).unwrap();
    let list = |items: &[&str]| serde_json::to_string(items).unwrap();
    fs::write(
        root.join("config/config.json"),
        format!(
            r#"{{"sandbox":{{"network":{{"defaultDomains":false,"allowedDomains":{},"deniedDomains":{}}}}}}}"#,
            list(allowed),
            list(denied)
        ),
    )
    .unwrap();
    let dir = |rest: &str| root.join(rest).display().to_string();
    let (home, state, config_dir, tmp) = (dir("home"), dir("state"), dir("config"), dir("tmp"));
    let vars = [
        ("PIRC_NODE_ID", "test-node"),
        ("PIRC_NODE_TOKEN", "0123456789abcdef0123456789abcdef"),
        ("PIRC_DAEMON_URL", "ws://127.0.0.1:8787"),
        ("PIRC_ALLOWED_USERS", "test-user"),
        ("PIRC_STATE_DIR", state.as_str()),
        ("PIRC_CONFIG_DIR", config_dir.as_str()),
        ("PIRC_BROWSER", "false"),
        ("HOME", home.as_str()),
        ("TMPDIR", tmp.as_str()),
        ("PATH", path_var.as_str()),
    ];
    let env = Env::new(vars, &root);
    let mut config = NodeConfig::load(&env, NodeRole::Node).unwrap();
    config.agent_command = "/bin/sh".to_owned();
    config.agent_args = Vec::new();
    let sandbox = NativeSandbox::new(
        config.clone(),
        env,
        PathBuf::from(env!("CARGO_BIN_EXE_pirc-node")),
    );
    Some(Fixture {
        root,
        config,
        sandbox,
        path: path_var,
    })
}

/// What a script printed and how it ended.
struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Fixture {
    async fn prepare(&self, session: &str) -> Prepared {
        let session_dir = self.config.sessions_dir.join(session);
        fs::create_dir_all(&session_dir).unwrap();
        self.sandbox
            .prepare(PrepareInput {
                session_id: session.to_owned(),
                workspace_root: self.root.join("workspace"),
                session_dir,
                inference_socket: None,
                protected_paths: Vec::new(),
            })
            .await
            .unwrap()
    }

    /// `script` as the agent of `prepared` (each run is a new sandbox on
    /// the same proxy).
    async fn run(&self, prepared: &Prepared, script: &str) -> Run {
        let mut command = prepared.command().unwrap();
        command
            .args(["-c", script])
            .envs(prepared.env.iter().map(|(k, v)| (k, v)))
            .env("PATH", &self.path)
            .current_dir(self.root.join("workspace"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .expect("the sandboxed script timed out")
            .unwrap();
        Run {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }
}

/// A host server on 127.0.0.1: echoes what it reads after its first line
/// (a tunnel), or answers an HTTP request with `200 ok`.
async fn upstream() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                if line.starts_with("GET ") {
                    loop {
                        let mut next = String::new();
                        if reader.read_line(&mut next).await.unwrap_or(0) == 0 || next == "\r\n" {
                            break;
                        }
                    }
                    let _ = reader
                        .into_inner()
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n")
                        .await;
                    return;
                }
                let _ = reader
                    .get_mut()
                    .write_all(format!("echo {line}").as_bytes())
                    .await;
                let mut rest = Vec::new();
                let _ = reader.read_to_end(&mut rest).await;
                let _ = reader.into_inner().write_all(&rest).await;
            });
        }
    });
    port
}

/// The `ProxyCommand` of `$GIT_SSH_COMMAND` for `host` and `port`, run
/// with `input` on stdin (the shell does what ssh would: split, expand).
fn proxy_command(host: &str, port: u16, input: &str) -> String {
    format!(
        r#"eval "set -- $GIT_SSH_COMMAND"
pc=${{7#ProxyCommand=}}
case "$pc" in *' %h %p') ;; *) echo "unexpected ProxyCommand: $pc" >&2; exit 99;; esac
printf '{input}' | eval "exec ${{pc% %h %p}} {host} {port}""#
    )
}

fn has(tool: &str, path: &str) -> bool {
    let found = path
        .split(':')
        .any(|dir| Path::new(dir).join(tool).is_file());
    if !found {
        eprintln!("skipped: {tool} is not on PATH");
    }
    found
}

#[tokio::test]
async fn ssh_style_tunnels_go_through_the_helper_and_approvals_widen_them() {
    let Some(f) = fixture("helper", &["localhost"], &[]) else {
        return;
    };
    let port = upstream().await;
    let prepared = f.prepare("pi_helper").await;
    let run = f
        .run(
            &prepared,
            &proxy_command("localhost", port, "hello\\nworld\\n"),
        )
        .await;
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.stdout, "echo hello\nworld\n");

    let run = f
        .run(&prepared, &proxy_command("127.0.0.1", port, "x\\n"))
        .await;
    assert_eq!(run.code, 1);
    assert!(
        run.stderr.contains(&format!(
            "CONNECT 127.0.0.1:{port}: HTTP/1.1 403 Forbidden: Connection blocked by network allowlist"
        )),
        "{}",
        run.stderr
    );
    prepared.approve_domains(&["127.0.0.1".to_owned()]).unwrap();
    let run = f
        .run(&prepared, &proxy_command("127.0.0.1", port, "x\\n"))
        .await;
    assert_eq!(
        (run.code, run.stdout.as_str()),
        (0, "echo x\n"),
        "{}",
        run.stderr
    );
    prepared.cleanup();
}

#[tokio::test]
async fn names_resolving_to_this_host_are_refused() {
    // The host's own name resolves to one of its addresses (or loopback):
    // allowing the name grants neither. (Approved: `DOMAIN_PATTERN` admits
    // no single-label names in the config.)
    let Ok(hostname) = fs::read_to_string("/proc/sys/kernel/hostname") else {
        return;
    };
    let hostname = hostname.trim().to_ascii_lowercase();
    if tokio::net::lookup_host((hostname.as_str(), 80))
        .await
        .is_err()
    {
        eprintln!("skipped: {hostname} does not resolve here");
        return;
    }
    let Some(f) = fixture("resolved", &["*.localhost"], &["bad.localhost"]) else {
        return;
    };
    let port = upstream().await;
    let prepared = f.prepare("pi_resolved").await;
    prepared
        .approve_domains(std::slice::from_ref(&hostname))
        .unwrap();
    let run = f
        .run(&prepared, &proxy_command(&hostname, port, "x\\n"))
        .await;
    assert_eq!(run.code, 1, "{}", run.stdout);
    assert!(
        run.stderr
            .contains(&format!("Connection to {hostname} blocked: resolved to ")),
        "{}",
        run.stderr
    );
    // `*.localhost` names may be loopback (RFC 6761), but not when denied.
    let run = f
        .run(&prepared, &proxy_command("bad.localhost", port, "x\\n"))
        .await;
    assert!(
        run.stderr.contains("blocked by network allowlist"),
        "{}",
        run.stderr
    );
    prepared.cleanup();
}

#[tokio::test]
async fn curl_reaches_allowed_hosts_over_http_and_socks5() {
    let Some(f) = fixture("curl", &["localhost"], &["denied.localhost"]) else {
        return;
    };
    if !has("curl", &f.path) {
        return;
    }
    let port = upstream().await;
    let prepared = f.prepare("pi_curl").await;
    // `localhost` is in NO_PROXY (it is the sandbox's own loopback):
    // `--noproxy ''` sends it to the host through the proxy anyway.
    let curl = "curl -sS --noproxy '' --max-time 10";
    let script = format!(
        r#"echo "http $({curl} http://localhost:{port}/)"
echo "all $({curl} --proxy "$ALL_PROXY" http://localhost:{port}/)"
echo "socks $({curl} --proxy "$FTP_PROXY" http://localhost:{port}/)"
echo "tunnel $({curl} --proxytunnel --proxy "$HTTPS_PROXY" http://localhost:{port}/)"
echo "denied $({curl} -o /dev/null -w '%{{http_code}}' http://denied.localhost:{port}/)"
echo "off-list $({curl} -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{port}/)"
{curl} --proxy "socks5h://srt:wrong@localhost:1080" http://localhost:{port}/ || echo "bad token $?"
{curl} --proxy "http://localhost:3128" -o /dev/null -w 'no token %{{http_code}}\n' http://localhost:{port}/
"#
    );
    let run = f.run(&prepared, &script).await;
    assert_eq!(
        run.stdout,
        "http ok\nall ok\nsocks ok\ntunnel ok\ndenied 403\noff-list 403\nbad token 97\nno token 407\n",
        "{}",
        run.stderr
    );
    prepared.cleanup();
}

#[tokio::test]
async fn git_ssh_command_reaches_ssh_servers_through_the_proxy() {
    let Some(f) = fixture("ssh", &["localhost"], &[]) else {
        return;
    };
    if !has("ssh", &f.path) {
        return;
    }
    // A server that speaks SSH's identification line and records the client's.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen, mut banner) = tokio::sync::mpsc::channel::<String>(4);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let _ = reader.get_mut().write_all(b"SSH-2.0-fake\r\n").await;
                let mut line = String::new();
                let _ = reader.read_line(&mut line).await;
                let _ = seen.send(line).await;
            });
        }
    });
    let prepared = f.prepare("pi_ssh").await;
    let options = "-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10";
    // As git runs it: through a shell.
    let run = f
        .run(
            &prepared,
            &format!(r#"eval "$GIT_SSH_COMMAND {options} -p {port} git@localhost true""#),
        )
        .await;
    assert_ne!(run.code, 0, "the fake server cannot finish a key exchange");
    let line = tokio::time::timeout(Duration::from_secs(5), banner.recv())
        .await
        .expect("ssh never reached the server")
        .unwrap();
    assert!(
        line.starts_with("SSH-2.0-OpenSSH"),
        "{line:?}; {}",
        run.stderr
    );

    let run = f
        .run(
            &prepared,
            &format!(r#"eval "$GIT_SSH_COMMAND {options} -p 22 git@github.com true""#),
        )
        .await;
    assert_ne!(run.code, 0);
    assert!(
        run.stderr.contains("blocked by network allowlist"),
        "{}",
        run.stderr
    );

    // srt's macOS command: nc cannot authenticate, so the proxy answers
    // with an SSH disconnect that says why.
    if has("nc", &f.path) {
        let nc = format!(
            "ssh {options} -o ProxyCommand='nc -X 5 -x localhost:1080 %h %p' -p 22 git@localhost true"
        );
        let run = f.run(&prepared, &nc).await;
        assert_ne!(run.code, 0);
        assert!(
            run.stderr.contains("This proxy requires authentication"),
            "{}",
            run.stderr
        );
    }
    prepared.cleanup();
}
