//! Starting the executables under test: a gateway and, optionally, one node
//! connected to it, each in an isolated temporary directory with its own
//! `HOME`, configuration and state.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::json;
use tempfile::TempDir;

use crate::client::{Api, Response};
use crate::fake_llm::FakeLlm;

/// The one allowed user.
pub const USER: &str = "test@example.com";
/// The allowed `Host`.
pub const HOST: &str = "test.example";
/// The allowed `Origin`.
pub const ORIGIN: &str = "https://test.example";
/// The node's id and per-node secret.
pub const NODE_ID: &str = "test";
pub const NODE_TOKEN: &str = "conformance-node-token-0123456789abcdef";
/// The node's only workspace, as the gateway names it.
pub const WORKSPACE_ID: &str = "test:test";

/// Directory of the executables under test; tests are skipped without it.
const BIN_DIR_VARIABLE: &str = "PIRC_CONFORMANCE_BIN_DIR";
/// Set by `bun run test:conformance` (and so CI): skipping is then a failure.
const REQUIRED_VARIABLE: &str = "PIRC_CONFORMANCE_REQUIRED";

/// Replaces the sandbox runtime: answers the node's probe and runs the agent unconfined.
const FAKE_SRT: &str = r#"#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --settings|--control-fd) shift 2 ;;
    *) shift ;;
  esac
done
exec "$@"
"#;

/// Starting again with another port when the gateway exits before it
/// answers (the free port was taken in between).
const START_ATTEMPTS: usize = 3;

/// Gateway variations for tests that need a different trust configuration.
#[derive(Clone, Debug, Default)]
pub struct GatewayOptions {
    /// Extra or overriding gateway environment variables.
    pub env: Vec<(&'static str, String)>,
    /// Start no node.
    pub without_node: bool,
}

/// A running gateway (and node) with a fake model provider.
pub struct Cluster {
    // Field order is drop order: the node stops before the gateway, and the
    // processes before their directory is removed.
    node: Option<Process>,
    gateway: Process,
    pub llm: FakeLlm,
    pub port: u16,
    /// Root of every temporary directory the processes use.
    pub dir: TempDir,
}

impl Cluster {
    /// A gateway with one node, or `None` (test skipped) when
    /// `PIRC_CONFORMANCE_BIN_DIR` is unset.
    pub async fn start() -> Option<Self> {
        Self::start_with(GatewayOptions::default()).await
    }

    pub async fn start_with(options: GatewayOptions) -> Option<Self> {
        let bin_dir = bin_dir()?;
        for attempt in 1..=START_ATTEMPTS {
            match Self::try_start(&bin_dir, &options).await {
                Ok(cluster) => return Some(cluster),
                Err(reason) if attempt < START_ATTEMPTS => {
                    eprintln!("conformance cluster: {reason}; starting again");
                }
                Err(reason) => panic!("conformance cluster: {reason}"),
            }
        }
        unreachable!("the last attempt panics")
    }

    async fn try_start(bin_dir: &Path, options: &GatewayOptions) -> Result<Self, String> {
        let (dir, root) = run_dir();
        let llm = FakeLlm::start().await.expect("fake model server");
        let port = free_port();

        let models = root.join("gateway-models.json");
        fs::write(
            &models,
            serde_json::to_vec_pretty(&json!({
                "providers": { "fake": {
                    "api": "openai-completions",
                    "baseUrl": llm.base_url(),
                    "apiKey": "test-key",
                    "models": [{ "id": "fake-model", "reasoning": true,
                        "contextWindow": 100000, "maxTokens": 1000 }],
                } },
                "defaultModel": { "provider": "fake", "id": "fake-model", "thinking": "low" },
            }))
            .unwrap(),
        )
        .unwrap();
        let node_tokens = json!({ NODE_ID: NODE_TOKEN }).to_string();
        let mut env = vec![
            ("PIRC_HOST", "127.0.0.1".to_owned()),
            ("PIRC_PORT", port.to_string()),
            ("PIRC_STATE_DIR", dir_in(&root, "gateway-state")),
            ("PIRC_TRUSTED_PROXIES", "127.0.0.1,::1".to_owned()),
            ("PIRC_IDENTITY_HEADER", "x-pirc-user".to_owned()),
            ("PIRC_ALLOWED_USERS", USER.to_owned()),
            ("PIRC_ALLOWED_ORIGINS", ORIGIN.to_owned()),
            ("PIRC_ALLOWED_HOSTS", HOST.to_owned()),
            ("PIRC_NODE_TOKENS", node_tokens),
            ("PIRC_MODELS_FILE", models.display().to_string()),
            ("PIRC_TIMEZONE", "UTC".to_owned()),
        ];
        override_env(&mut env, options.env.clone());
        let gateway = Process::spawn(
            "gateway",
            &bin_dir.join("pirc-gateway"),
            &root,
            &dir_in(&root, "gateway-home"),
            &env,
        );

        let node = if options.without_node {
            None
        } else {
            Some(Self::spawn_node(
                bin_dir,
                &root,
                &format!("ws://127.0.0.1:{port}"),
            ))
        };

        let mut cluster = Self {
            node,
            gateway,
            llm,
            port,
            dir,
        };
        cluster
            .wait_ready(if options.without_node { 0 } else { 1 })
            .await?;
        Ok(cluster)
    }

    fn spawn_node(bin_dir: &Path, root: &Path, gateway_url: &str) -> Process {
        let workspace = dir_in(root, "workspace");
        fs::write(Path::new(&workspace).join("README.md"), "conformance\n").unwrap();
        let config_dir = dir_in(root, "node-config");
        // Side requests would consume scripted replies; tests that need them opt in.
        fs::write(
            Path::new(&config_dir).join("config.json"),
            json!({ "features": { "sessionTitle": { "enabled": false },
                "autoMode": { "useModel": false } } })
            .to_string(),
        )
        .unwrap();
        let srt = root.join("fake-srt.sh");
        fs::write(&srt, FAKE_SRT).unwrap();
        fs::set_permissions(&srt, fs::Permissions::from_mode(0o755)).unwrap();
        let env = [
            ("PIRC_NODE_ID", NODE_ID.to_owned()),
            ("PIRC_NODE_TOKEN", NODE_TOKEN.to_owned()),
            ("PIRC_DAEMON_URL", gateway_url.to_owned()),
            ("PIRC_ALLOWED_USERS", USER.to_owned()),
            ("PIRC_STATE_DIR", dir_in(root, "node-state")),
            ("PIRC_CONFIG_DIR", config_dir),
            (
                "PIRC_WORKSPACES",
                json!([{ "id": "test", "path": workspace, "displayName": "Test",
                    "defaults": {} }])
                .to_string(),
            ),
            ("PIRC_SANDBOX_SRT", srt.display().to_string()),
            ("PIRC_BROWSER", "false".to_owned()),
            ("PIRC_SHUTDOWN_GRACE_MS", "200".to_owned()),
        ];
        Process::spawn(
            "node",
            &bin_dir.join("pirc-node"),
            root,
            &dir_in(root, "node-home"),
            &env,
        )
    }

    /// `http://127.0.0.1:<port>`
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn api(&self) -> Api {
        Api::new(self.base_url())
    }

    /// Values that differ between runs, to be replaced in recorded transcripts.
    pub fn volatile(&self) -> Vec<(String, &'static str)> {
        vec![
            (
                self.dir
                    .path()
                    .canonicalize()
                    .unwrap()
                    .display()
                    .to_string(),
                "<tmp>",
            ),
            (self.dir.path().display().to_string(), "<tmp>"),
            (self.llm.base_url(), "<llm>"),
            (format!("127.0.0.1:{}", self.port), "<gateway>"),
        ]
    }

    /// Wait until the gateway answers and, when a node was started, lists
    /// it. A gateway without nodes may refuse the request (tests of its
    /// trust configuration); an answer in the gateway's own shape is enough
    /// then. `Err` when the gateway exits first: its port was probably taken.
    async fn wait_ready(&mut self, nodes: u64) -> Result<(), String> {
        let api = self.api();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.gateway.exited() {
                self.gateway.dump();
                return Err(format!("the gateway exited during startup ({status})"));
            }
            if let Some(node) = &mut self.node
                && let Some(status) = node.exited()
            {
                node.dump();
                panic!("the node exited during startup ({status})");
            }
            if let Ok(response) = api
                .try_send("GET", "/api/health", &crate::browser_headers(), None)
                .await
            {
                let ready = if nodes == 0 {
                    is_gateway_answer(&response)
                } else {
                    response.status == 200 && response.body["nodes"] == nodes
                };
                if ready {
                    return Ok(());
                }
            }
            if Instant::now() > deadline {
                self.dump_logs();
                panic!("cluster did not become ready with {nodes} node(s)");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn dump_logs(&self) {
        self.gateway.dump();
        if let Some(node) = &self.node {
            node.dump();
        }
    }
}

impl Drop for Cluster {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.dump_logs();
        }
        // Fields then drop in order: the node stops before the gateway.
    }
}

/// A node alone, connected to a gateway the test plays
/// ([`crate::FakeGateway`]).
pub struct LoneNode {
    process: Process,
    /// Root of the node's temporary directories.
    pub dir: TempDir,
}

impl LoneNode {
    /// Start a node against `ws://127.0.0.1:<gateway_port>`, or `None` (test
    /// skipped) when `PIRC_CONFORMANCE_BIN_DIR` is unset.
    pub fn start(gateway_port: u16) -> Option<Self> {
        let bin_dir = bin_dir()?;
        let (dir, root) = run_dir();
        let url = format!("ws://127.0.0.1:{gateway_port}");
        let process = Cluster::spawn_node(&bin_dir, &root, &url);
        Some(Self { process, dir })
    }

    /// Values that differ between runs, to be replaced in recorded transcripts.
    pub fn volatile(&self) -> Vec<(String, &'static str)> {
        let canonical = self.dir.path().canonicalize().unwrap();
        vec![
            (canonical.display().to_string(), "<tmp>"),
            (self.dir.path().display().to_string(), "<tmp>"),
        ]
    }
}

impl Drop for LoneNode {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.process.dump();
        }
    }
}

/// A fresh run directory and its canonical path. Not under /tmp: agents may
/// write there, and the node warns when its state lies inside a path its
/// agents may write.
fn run_dir() -> (TempDir, PathBuf) {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/conformance");
    fs::create_dir_all(&base).expect("conformance directory");
    let dir = tempfile::Builder::new()
        .prefix("run-")
        .tempdir_in(&base)
        .expect("temporary directory");
    let root = dir.path().canonicalize().expect("temporary directory path");
    (dir, root)
}

/// `/api/health` itself, or one of the gateway's own error bodies.
fn is_gateway_answer(response: &Response) -> bool {
    (response.status == 200 && response.body["ok"] == true)
        || response.body["error"]["code"].is_string()
}

/// Executables under test, or `None` when the suite is not requested.
fn bin_dir() -> Option<PathBuf> {
    let Some(dir) = std::env::var_os(BIN_DIR_VARIABLE) else {
        // Not a silent pass where the suite must run.
        assert!(
            std::env::var_os(REQUIRED_VARIABLE).is_none(),
            "{REQUIRED_VARIABLE} is set but {BIN_DIR_VARIABLE} is not"
        );
        eprintln!("{BIN_DIR_VARIABLE} is not set; skipping conformance test");
        return None;
    };
    let dir = PathBuf::from(dir);
    // Relative paths are relative to the repository root, like `bun run` scripts.
    let dir = if dir.is_absolute() {
        dir
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(dir)
    };
    Some(
        dir.canonicalize()
            .unwrap_or_else(|error| panic!("{BIN_DIR_VARIABLE} {}: {error}", dir.display())),
    )
}

fn dir_in(root: &Path, name: &str) -> String {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    dir.display().to_string()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("free port")
        .port()
}

fn override_env(env: &mut Vec<(&'static str, String)>, overrides: Vec<(&'static str, String)>) {
    for (name, value) in overrides {
        env.retain(|(existing, _)| *existing != name);
        env.push((name, value));
    }
}

/// A child process logging to a file, stopped when dropped. It stays in the
/// test's process group, so an interrupted test run (Ctrl-C) stops it too.
/// Known gap: a test binary killed outright (SIGKILL) leaves its children
/// and their `target/conformance/run-*` directory behind.
struct Process {
    name: &'static str,
    child: Child,
    log: PathBuf,
    stopped: bool,
}

impl Process {
    fn spawn(
        name: &'static str,
        program: &Path,
        root: &Path,
        home: &str,
        env: &[(&'static str, String)],
    ) -> Self {
        let log = root.join(format!("{name}.log"));
        let file = File::create(&log).unwrap();
        let child = Command::new(program)
            .current_dir(root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .envs(env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(file.try_clone().unwrap())
            .stderr(file)
            .spawn()
            .unwrap_or_else(|error| panic!("cannot start {}: {error}", program.display()));
        Self {
            name,
            child,
            log,
            stopped: false,
        }
    }

    /// The exit status, once the process has exited.
    fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// SIGTERM (a node then stops its agents), then SIGKILL after a grace period.
    fn stop(&mut self) {
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        let pid = Pid::from_raw(self.child.id() as i32);
        let _ = kill(pid, Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.exited().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// The last 8 KiB of the log, for a failing test.
    fn dump(&self) {
        let Ok(mut file) = File::open(&self.log) else {
            return;
        };
        let length = file.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = file.seek(SeekFrom::Start(length.saturating_sub(8192)));
        let mut tail = String::new();
        let _ = file.read_to_string(&mut tail);
        eprintln!(
            "---- {} log ({}) ----\n{tail}",
            self.name,
            self.log.display()
        );
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}
