//! The native Linux sandbox for real: bubblewrap, the proxy, the bridge
//! (this package's `pirc-node sandbox-bridge`) and a shell as the agent.
//! Skipped, with a message, where `bwrap` is not on `PATH`.
//!
//! Network checks run this test binary inside the sandbox as a small HTTP
//! client (the `sandbox_client` test, which does nothing unless
//! `PIRC_SANDBOX_TEST_CLIENT` is set), since the sandbox may have no curl.

#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use pirc_config::{Env, NodeConfig};
use pirc_node::sandbox::linux::{NativeSandbox, find_bwrap};
use pirc_node::sandbox::{PrepareInput, Prepared, Sandbox, SandboxStatus};
use pirc_protocol::NodeRole;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const CLIENT: &str = "PIRC_SANDBOX_TEST_CLIENT";

/// Inside the sandbox: for each space-separated target, one line on
/// stdout. `direct:<port>` connects to the host's port without the proxy;
/// `unix:<path>` sends `ping` to a Unix socket and prints the answer;
/// `read:<path>` says whether the file can be read; a URL is fetched
/// through the bridge. Every target after the first waits for a line on
/// stdin first.
#[test]
fn sandbox_client() {
    let Ok(targets) = std::env::var(CLIENT) else {
        return;
    };
    let stdin = std::io::stdin();
    for (index, target) in targets.split(' ').enumerate() {
        if index > 0 {
            let mut line = String::new();
            stdin.lock().read_line(&mut line).unwrap();
        }
        let result = if let Some(socket) = target.strip_prefix("unix:") {
            match std::os::unix::net::UnixStream::connect(socket) {
                Err(error) => format!("unreachable: {:?}", error.kind()),
                Ok(mut stream) => {
                    stream.write_all(b"ping\n").unwrap();
                    let mut reply = String::new();
                    let _ = stream.read_to_string(&mut reply);
                    reply.trim().to_owned()
                }
            }
        } else if let Some(file) = target.strip_prefix("read:") {
            match fs::read(file) {
                Ok(_) => "read".to_owned(),
                Err(error) => format!("unreadable: {:?}", error.kind()),
            }
        } else if let Some(port) = target.strip_prefix("direct:") {
            match std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap(),
                Duration::from_secs(3),
            ) {
                Ok(_) => "connected".to_owned(),
                Err(_) => "refused".to_owned(),
            }
        } else {
            match std::net::TcpStream::connect("127.0.0.1:3128") {
                Err(error) => format!("no bridge: {error}"),
                Ok(mut stream) => {
                    let host = target
                        .trim_start_matches("http://")
                        .split('/')
                        .next()
                        .unwrap();
                    write!(stream, "GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
                    let mut reply = String::new();
                    let _ = stream.read_to_string(&mut reply);
                    reply.lines().next().unwrap_or_default().to_owned()
                }
            }
        };
        // libtest may print on the same line: mark the result.
        println!("@@ {result}");
        std::io::stdout().flush().unwrap();
    }
    std::process::exit(0);
}

struct Fixture {
    root: PathBuf,
    config: NodeConfig,
    sandbox: NativeSandbox,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn path(root: &Path, rest: &str) -> String {
    root.join(rest).display().to_string()
}

/// A node layout outside `/tmp` (a write root of every session), or `None`
/// without bubblewrap.
fn fixture(name: &str) -> Option<Fixture> {
    fixture_with(name, false)
}

/// [`fixture`]; with `home_writable`, the agent config lives in
/// `~/.config/.pirc` and puts `~` in `allowedPaths`.
fn fixture_with(name: &str, home_writable: bool) -> Option<Fixture> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let probe_env = Env::new([("PATH", path_var.as_str())], "/");
    if find_bwrap(&probe_env).is_none() {
        eprintln!("skipped: bwrap is not on PATH, so the native sandbox cannot be tested here");
        return None;
    }
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("sandbox-native-{name}"));
    let _ = fs::remove_dir_all(&root);
    let config_rel = if home_writable {
        "home/.config/.pirc"
    } else {
        "config"
    };
    for dir in [
        "home/.ssh",
        "state",
        config_rel,
        "workspace/.git/hooks",
        "outside",
        "tmp",
    ] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = fs::canonicalize(&root).unwrap();
    fs::write(root.join("home/.ssh/id_ed25519"), "secret").unwrap();
    fs::write(root.join("state/secret"), "node secret").unwrap();
    fs::write(root.join("workspace/README"), "hello").unwrap();
    fs::write(root.join("workspace/.git/config"), "[core]").unwrap();
    let allowed = if home_writable {
        r#""allowedPaths":["~"],"#
    } else {
        ""
    };
    fs::write(
        root.join(config_rel).join("config.json"),
        format!(
            r#"{{{allowed}"sandbox":{{"network":{{"defaultDomains":false,"allowedDomains":["localhost"]}}}}}}"#
        ),
    )
    .unwrap();
    let (home, state, config_dir, tmp) = (
        path(&root, "home"),
        path(&root, "state"),
        path(&root, config_rel),
        path(&root, "tmp"),
    );
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
    })
}

impl Fixture {
    async fn prepare(&self, session: &str) -> Prepared {
        self.prepare_with(session, None, Vec::new()).await
    }

    async fn prepare_with(
        &self,
        session: &str,
        inference_socket: Option<PathBuf>,
        protected_paths: Vec<PathBuf>,
    ) -> Prepared {
        let session_dir = self.config.sessions_dir.join(session);
        fs::create_dir_all(&session_dir).unwrap();
        self.sandbox
            .prepare(PrepareInput {
                session_id: session.to_owned(),
                workspace_root: self.root.join("workspace"),
                session_dir,
                inference_socket,
                protected_paths,
            })
            .await
            .unwrap()
    }

    /// `script` as the agent (`/bin/sh -c <script>`): its exit code.
    async fn sh(&self, script: &str) -> i32 {
        self.sh_protecting(script, Vec::new()).await
    }

    /// [`Self::sh`] with `protected` among the session's protected paths.
    async fn sh_protecting(&self, script: &str, protected: Vec<PathBuf>) -> i32 {
        let prepared = self.prepare_with("pi_sh", None, protected).await;
        let mut command = prepared.command().unwrap();
        command
            .args(["-c", script])
            .envs(prepared.env.iter().map(|(k, v)| (k, v)))
            .current_dir(self.root.join("workspace"))
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(Duration::from_secs(30), command.status())
            .await
            .unwrap()
            .unwrap();
        prepared.cleanup();
        status.code().unwrap_or(-1)
    }
}

#[tokio::test]
async fn confines_the_agent_to_the_session_policy() {
    let Some(f) = fixture("files") else {
        return;
    };
    assert!(matches!(
        f.sandbox.check().await,
        SandboxStatus::Active { .. }
    ));
    let (root, w) = (&f.root, path(&f.root, "workspace"));
    let session = f.config.sessions_dir.join("pi_sh").display().to_string();
    let cases = [
        ("probe", "exit 0".to_owned(), true),
        ("read the workspace", format!("cat {w}/README"), true),
        ("write the workspace", format!("echo x > {w}/new.txt"), true),
        (
            "write outside the write roots",
            format!("echo x > {}/x", path(root, "outside")),
            false,
        ),
        (
            "write the home directory",
            format!("echo x > {}/new", path(root, "home")),
            false,
        ),
        (
            "read ~/.ssh",
            format!("cat {}/.ssh/id_ed25519", path(root, "home")),
            false,
        ),
        (
            "write ~/.ssh",
            format!("echo x > {}/.ssh/x", path(root, "home")),
            false,
        ),
        (
            "read the node's private state",
            format!("cat {}/secret", path(root, "state")),
            false,
        ),
        (
            "read and write the session dir",
            format!("echo x > {session}/f && cat {session}/f"),
            true,
        ),
        (
            "write .git/hooks",
            format!("echo x > {w}/.git/hooks/pre-commit"),
            false,
        ),
        (
            "write .git/config",
            format!("echo x >> {w}/.git/config"),
            false,
        ),
        (
            "write the config dir",
            format!("echo x > {}/x", path(root, "config")),
            false,
        ),
        (
            "write /tmp",
            "echo x > /tmp/pirc-native-$$ && rm /tmp/pirc-native-$$".to_owned(),
            true,
        ),
        ("write $TMPDIR", "echo x > \"$TMPDIR/x\"".to_owned(), true),
        (
            "TMPDIR is the session's",
            format!(
                "case \"$TMPDIR\" in {}/pirc-*) exit 0;; esac; exit 1",
                path(root, "tmp")
            ),
            true,
        ),
        (
            "see a host process",
            format!("kill -0 {}", std::process::id()),
            false,
        ),
        ("exit status passes through", "exit 7".to_owned(), false),
    ];
    let mut failures = Vec::new();
    for (name, script, expect) in &cases {
        let code = f.sh(script).await;
        if (code == 0) != *expect {
            failures.push(format!("{name}: exit {code}"));
        }
    }
    assert_eq!(f.sh("exit 7").await, 7);
    assert!(failures.is_empty(), "{failures:#?}");
    assert!(root.join("workspace/new.txt").exists());
    assert_eq!(
        fs::read_to_string(root.join("workspace/.git/config")).unwrap(),
        "[core]"
    );
}

#[tokio::test]
async fn passes_stdio_through_untouched() {
    let Some(f) = fixture("stdio") else {
        return;
    };
    let prepared = f.prepare("pi_stdio").await;
    let mut command = prepared.command().unwrap();
    command
        .args([
            "-c",
            "while read line; do echo \"got $line\"; echo \"err $line\" >&2; done",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"type\":\"a\"}\nsecond\n")
        .await
        .unwrap();
    drop(stdin);
    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .await
        .unwrap();
    let mut err = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .await
        .unwrap();
    assert!(child.wait().await.unwrap().success());
    assert_eq!(out, "got {\"type\":\"a\"}\ngot second\n");
    assert_eq!(err, "err {\"type\":\"a\"}\nerr second\n");
    prepared.cleanup();
}

/// A host server answering 200 to anything.
async fn upstream() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
            });
        }
    });
    port
}

/// This test binary as the agent, running [`sandbox_client`] on `targets`
/// (stdin piped, for the client's pauses between targets).
fn client(prepared: &Prepared, targets: &str) -> tokio::process::Command {
    let command = prepared.command().unwrap();
    // The agent command is /bin/sh in the fixture: swap in the client.
    let mut args: Vec<_> = command.as_std().get_args().map(|a| a.to_owned()).collect();
    let at = args.iter().rposition(|a| a == "/bin/sh").unwrap();
    args[at] = std::env::current_exe().unwrap().into_os_string();
    let mut client = tokio::process::Command::new(command.as_std().get_program());
    client
        .args(&args)
        .args([
            "--exact",
            "sandbox_client",
            "--nocapture",
            "--test-threads=1",
        ])
        .envs(prepared.env.iter().map(|(k, v)| (k, v)))
        .env(CLIENT, targets)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    client
}

/// The client's next result line.
async fn next_result(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> String {
    // libtest prints its own lines around the test's.
    loop {
        let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Some((_, result)) = line.split_once("@@ ") {
            return result.to_owned();
        }
    }
}

#[tokio::test]
async fn reaches_the_network_only_through_the_proxy_and_approvals_widen_it_in_place() {
    let Some(f) = fixture("network") else {
        return;
    };
    let port = upstream().await;
    let prepared = f.prepare("pi_net").await;
    assert!(prepared.has_control());
    let mut child = client(
        &prepared,
        &format!(
            "direct:{port} http://localhost:{port}/ http://127.0.0.1:{port}/ http://127.0.0.1:{port}/"
        ),
    )
    .spawn()
    .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut next = async || next_result(&mut lines).await;
    assert_eq!(next().await, "refused", "no direct network");
    stdin.write_all(b"\n").await.unwrap();
    assert_eq!(next().await, "HTTP/1.1 200 OK", "an allowed domain");
    stdin.write_all(b"\n").await.unwrap();
    assert_eq!(next().await, "HTTP/1.1 403 Forbidden", "not allowed yet");
    prepared.approve_domains(&["127.0.0.1".to_owned()]).unwrap();
    stdin.write_all(b"\n").await.unwrap();
    assert_eq!(next().await, "HTTP/1.1 200 OK", "approved while it runs");
    assert!(child.wait().await.unwrap().success());
    prepared.cleanup();
}

#[tokio::test]
async fn cleanup_removes_the_session_temp_directory() {
    let Some(f) = fixture("cleanup") else {
        return;
    };
    let prepared = f.prepare("pi_clean").await;
    let tmp = PathBuf::from(&prepared.env[0].1);
    assert!(tmp.join("proxy.sock").exists());
    prepared.cleanup();
    assert!(!tmp.exists());
}

/// Renaming a directory that merely contains a mount point is allowed on
/// Linux (the mount moves with it), so every writable directory above a
/// protected path must be a mount point itself: otherwise `mv .git x;
/// mkdir .git` gives the agent a `.git/config` the host's git trusts.
#[tokio::test]
async fn protected_paths_cannot_be_renamed_away() {
    let Some(f) = fixture_with("rename", true) else {
        return;
    };
    let (root, w) = (&f.root, path(&f.root, "workspace"));
    let home = path(root, "home");
    fs::create_dir_all(root.join("workspace/project/docs")).unwrap();
    let instructions = root.join("workspace/project/docs/AGENTS.md");
    fs::write(&instructions, "be nice").unwrap();
    let protected = vec![instructions.clone()];
    let refused = [
        ("rename .git", format!("mv {w}/.git {w}/.git.bak")),
        (
            "swap .git for a copy with a filter",
            format!(
                "mv {w}/.git {w}/.git.bak; mkdir -p {w}/.git && printf '[filter \"x\"]\\n' >> {w}/.git/config"
            ),
        ),
        ("rename .git/hooks", format!("mv {w}/.git/hooks {w}/.git/h")),
        (
            "rename .git/config",
            format!("mv {w}/.git/config {w}/.git/c"),
        ),
        ("remove .git/config", format!("rm -f {w}/.git/config")),
        (
            "replace .git with a directory",
            format!("mkdir {w}/g && mv -T {w}/g {w}/.git"),
        ),
        (
            "rename an ancestor of the project's instructions",
            format!(
                "mv {w}/project {w}/p && mkdir -p {w}/project/docs && echo x > {w}/project/docs/AGENTS.md"
            ),
        ),
        (
            "rename the instructions' parent",
            format!("mv {w}/project/docs {w}/project/d"),
        ),
        (
            "rename ~/.config",
            format!(
                "mv {home}/.config {home}/c && mkdir -p {home}/.config/.pirc && echo '{{}}' > {home}/.config/.pirc/config.json"
            ),
        ),
        (
            "rename ~/.config/.pirc",
            format!("mv {home}/.config/.pirc {home}/.config/p"),
        ),
        (
            "write ~/.config/.pirc",
            format!("echo x > {home}/.config/.pirc/config.json"),
        ),
    ];
    let mut failures = Vec::new();
    for (name, script) in &refused {
        let code = f.sh_protecting(script, protected.clone()).await;
        if code == 0 {
            failures.push(format!("{name}: allowed"));
        }
    }
    // What stays writable around them.
    let allowed = [
        ("write ~", format!("echo x > {home}/new")),
        ("write in .git", format!("echo x > {w}/.git/description")),
        (
            "write next to the instructions",
            format!("echo x > {w}/project/docs/notes.md"),
        ),
        (
            "write in ~/.config",
            format!("mkdir -p {home}/.config/tool && echo x > {home}/.config/tool/rc"),
        ),
    ];
    for (name, script) in &allowed {
        let code = f.sh_protecting(script, protected.clone()).await;
        if code != 0 {
            failures.push(format!("{name}: exit {code}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
    assert_eq!(
        fs::read_to_string(root.join("workspace/.git/config")).unwrap(),
        "[core]"
    );
    assert_eq!(fs::read_to_string(&instructions).unwrap(), "be nice");
    for gone in [
        "workspace/.git.bak",
        "workspace/p",
        "workspace/project/d",
        "home/c",
        "home/.config/p",
    ] {
        assert!(!root.join(gone).exists(), "{gone}");
    }
    assert!(root.join("home/.config/.pirc/config.json").exists());
    assert!(root.join("home/new").exists());
}

/// The node's inference socket lives in a private directory of its state,
/// which the sandbox hides: the policy gives that one directory back.
#[tokio::test]
async fn reaches_the_inference_socket_inside_the_hidden_state() {
    use std::os::unix::fs::DirBuilderExt;

    let Some(f) = fixture("inference") else {
        return;
    };
    let dir = f.root.join("state/i-test");
    fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let socket = dir.join("socket");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = std::io::BufReader::new(&stream).read_line(&mut line);
            let _ = write!(stream, "pong {}", line.trim());
        }
    });
    let prepared = f
        .prepare_with("pi_inference", Some(socket.clone()), Vec::new())
        .await;
    let mut command = client(
        &prepared,
        &format!(
            "unix:{} read:{} read:{}",
            socket.display(),
            f.root.join("state/secret").display(),
            f.root.join("workspace/README").display(),
        ),
    );
    command.stdin(Stdio::null());
    let mut child = command.spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(next_result(&mut lines).await, "pong ping");
    assert_eq!(
        next_result(&mut lines).await,
        "unreadable: NotFound",
        "the rest of the state stays hidden"
    );
    assert_eq!(next_result(&mut lines).await, "read");
    assert!(child.wait().await.unwrap().success());
    prepared.cleanup();
}
