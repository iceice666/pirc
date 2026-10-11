//! Shared by `node_workspaces` and `node_chat`: masking of the workspace ids
//! a node generates (`workspace_<uuid with underscores>`, which the
//! transcript's uuid pattern does not match), and a node process started by
//! the test itself, for startup checks that need a chosen state directory
//! and the node's exit status.

#![allow(dead_code)]

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use pirc_conformance::{NODE_ID, NODE_TOKEN, USER};
use serde_json::{Value, json};

/// Replaces generated values the transcript's normalizer does not know
/// before a value reaches it: chat and directory workspace ids
/// (`workspace_<uuid with underscores>`) become `<workspace:N>`.
#[derive(Default)]
pub struct Ids {
    known: Vec<(String, String)>,
}

impl Ids {
    /// Give `id` the next placeholder (once).
    pub fn add(&mut self, id: &str) {
        if !self.known.iter().any(|(known, _)| known == id) {
            let placeholder = format!("<workspace:{}>", self.known.len() + 1);
            self.known.push((id.to_owned(), placeholder));
        }
    }

    /// Every `workspace_…` id in `value` gets a placeholder, in order of appearance.
    pub fn learn(&mut self, value: &Value) {
        match value {
            Value::String(text) => {
                for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                    if is_workspace_id(word) {
                        self.add(word);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| self.learn(item)),
            Value::Object(object) => {
                for (key, item) in object {
                    self.learn(&Value::String(key.clone()));
                    self.learn(item);
                }
            }
            _ => {}
        }
    }

    pub fn text(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (id, placeholder) in &self.known {
            text = text.replace(id.as_str(), placeholder);
        }
        text
    }

    /// `value` with known ids replaced (learning new ones first).
    pub fn value(&mut self, value: &Value) -> Value {
        self.learn(value);
        self.mask(value)
    }

    fn mask(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => items.iter().map(|item| self.mask(item)).collect(),
            Value::Object(object) => object
                .iter()
                .map(|(key, item)| (self.text(key), self.mask(item)))
                .collect::<serde_json::Map<_, _>>()
                .into(),
            other => other.clone(),
        }
    }

    pub fn response(
        &mut self,
        response: &pirc_conformance::Response,
    ) -> pirc_conformance::Response {
        let mut response = response.clone();
        response.body = self.value(&response.body);
        response
    }
}

fn is_workspace_id(word: &str) -> bool {
    let Some(rest) = word.strip_prefix("workspace_") else {
        return false;
    };
    let groups: Vec<&str> = rest.split('_').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length
                && group
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        })
}

/// JSON with object keys sorted at every level, numbers and strings as
/// `JSON.stringify` writes them (TS `canonicalJson` in agent/config.ts).
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let inner: Vec<String> = entries
                .into_iter()
                .map(|(key, item)| {
                    format!("{}:{}", Value::String(key.clone()), canonical_json(item))
                })
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        other => other.to_string(),
    }
}

/// The node executable and its arguments for a role, as the cluster picks
/// them (`PIRC_CONFORMANCE_NODE_BIN [chat]`, else the bin dir's
/// `pirc-node`/`pirc-chat`), or `None` (test skipped) without a bin dir.
pub fn node_command(chat: bool) -> Option<(PathBuf, Vec<&'static str>)> {
    let Some(dir) = std::env::var_os("PIRC_CONFORMANCE_BIN_DIR") else {
        assert!(
            std::env::var_os("PIRC_CONFORMANCE_REQUIRED").is_none(),
            "PIRC_CONFORMANCE_REQUIRED is set but PIRC_CONFORMANCE_BIN_DIR is not"
        );
        eprintln!("PIRC_CONFORMANCE_BIN_DIR is not set; skipping conformance test");
        return None;
    };
    let resolve = |path: PathBuf| {
        let path = if path.is_absolute() {
            path
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(path)
        };
        path.canonicalize()
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    };
    if let Some(bin) = std::env::var_os("PIRC_CONFORMANCE_NODE_BIN") {
        let bin = resolve(PathBuf::from(bin));
        return Some((bin, if chat { vec!["chat"] } else { Vec::new() }));
    }
    let dir = resolve(PathBuf::from(dir));
    Some((
        dir.join(if chat { "pirc-chat" } else { "pirc-node" }),
        Vec::new(),
    ))
}

/// Same fake srt as the cluster's: runs the agent unconfined.
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

/// A run directory shared by several node processes: `home`, `state`,
/// `config` and `workspace` stay between them, so one node can start on the
/// state another left.
pub struct NodeRoot {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl NodeRoot {
    pub fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/conformance");
        fs::create_dir_all(&base).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("run-")
            .tempdir_in(&base)
            .unwrap();
        let root = dir.path().canonicalize().unwrap();
        for name in ["node-home", "node-state", "node-config", "workspace"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(root.join("workspace/README.md"), "conformance\n").unwrap();
        fs::write(
            root.join("node-config/config.json"),
            json!({ "features": { "sessionTitle": { "enabled": false },
                "autoMode": { "useModel": false } } })
            .to_string(),
        )
        .unwrap();
        let srt = root.join("fake-srt.sh");
        fs::write(&srt, FAKE_SRT).unwrap();
        fs::set_permissions(&srt, fs::Permissions::from_mode(0o755)).unwrap();
        Self { dir, root }
    }

    /// The configured workspace a coding node gets (`PIRC_WORKSPACES`), as
    /// the cluster configures it.
    pub fn workspaces(&self) -> String {
        json!([{ "id": "test", "path": self.root.join("workspace"), "displayName": "Test",
            "defaults": {} }])
        .to_string()
    }

    /// The node environment the cluster uses (without `PIRC_WORKSPACES`),
    /// against a gateway on `port`, then `extra` (overriding).
    pub fn env(&self, port: u16, extra: &[(&str, String)]) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = [
            ("PIRC_NODE_ID", NODE_ID.to_owned()),
            ("PIRC_NODE_TOKEN", NODE_TOKEN.to_owned()),
            ("PIRC_DAEMON_URL", format!("ws://127.0.0.1:{port}")),
            ("PIRC_ALLOWED_USERS", USER.to_owned()),
            ("PIRC_STATE_DIR", self.path("node-state")),
            ("PIRC_CONFIG_DIR", self.path("node-config")),
            ("PIRC_SANDBOX_SRT", self.path("fake-srt.sh")),
            ("PIRC_BROWSER", "false".to_owned()),
            ("PIRC_SHUTDOWN_GRACE_MS", "200".to_owned()),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect();
        for (name, value) in extra {
            env.retain(|(existing, _)| existing != name);
            env.push(((*name).to_owned(), value.clone()));
        }
        env
    }

    pub fn path(&self, name: &str) -> String {
        self.root.join(name).display().to_string()
    }

    /// Values that differ between runs.
    pub fn volatile(&self) -> Vec<(String, &'static str)> {
        vec![
            (self.root.display().to_string(), "<tmp>"),
            (self.dir.path().display().to_string(), "<tmp>"),
        ]
    }
}

/// One node process, logging to `<root>/<name>.log`; killed when dropped.
pub struct NodeProcess {
    child: Child,
    log: PathBuf,
    stopped: bool,
}

impl NodeProcess {
    pub fn spawn(
        root: &NodeRoot,
        name: &str,
        command: &(PathBuf, Vec<&'static str>),
        env: &[(String, String)],
    ) -> Self {
        let log = root.root.join(format!("{name}.log"));
        let file = File::create(&log).unwrap();
        let child = Command::new(&command.0)
            .args(&command.1)
            .current_dir(&root.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", root.path("node-home"))
            .envs(env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(file.try_clone().unwrap())
            .stderr(file)
            .spawn()
            .unwrap_or_else(|error| panic!("cannot start {}: {error}", command.0.display()));
        Self {
            child,
            log,
            stopped: false,
        }
    }

    /// Wait (up to 20 s) for the process to exit by itself.
    pub fn wait_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.stopped = true;
                return status;
            }
            if Instant::now() > deadline {
                self.dump();
                panic!("the node did not exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// SIGTERM, as an operator stopping the service; SIGKILL after 5 s.
    pub fn stop(&mut self) -> Option<ExitStatus> {
        if std::mem::replace(&mut self.stopped, true) {
            return None;
        }
        let _ = kill(Pid::from_raw(self.child.id() as i32), Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        None
    }

    pub fn log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub fn dump(&self) {
        eprintln!(
            "---- node log ({}) ----\n{}",
            self.log.display(),
            self.log()
        );
    }
}

impl Drop for NodeProcess {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.dump();
        }
        self.stop();
    }
}
