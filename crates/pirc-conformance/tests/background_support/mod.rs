//! Shared by the background-task transcripts (`agent_background*`):
//! masking of what a task generates per run, and waiting for its effects.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use pirc_conformance::AgentRun;
use regex::Regex;
use serde_json::{Value, json};

/// A task id in a summary line (`<id> · <status>`).
static SUMMARY_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([0-9a-f]{8}) · ").unwrap());
/// A task's log file (`<tmp>/pirc-background-XXXXXX/<id>.log`).
static LOG_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pirc-background-[A-Za-z0-9]{6}/([0-9a-f]{8})\.log").unwrap());
/// A pid inside JSON text a script returned.
static PID_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\\?"pid\\?":\d+"#).unwrap());

/// Task ids (`randomUUID().slice(0, 8)`) become `<task:N>`, the log
/// directory `pirc-background-<dir>` and pids `<pid>`, before the
/// [`pirc_conformance::Recorder`] (which would take an 8-digit id for a
/// session entry's) sees them.
#[derive(Default)]
pub struct TaskMask {
    ids: HashMap<String, String>,
}

impl TaskMask {
    pub fn mask(&mut self, value: Value) -> Value {
        self.learn(&value);
        self.apply(value)
    }

    /// A step name, with the task ids already seen masked.
    pub fn step(&self, step: &str) -> String {
        self.text(step)
    }

    fn remember(&mut self, id: &str) {
        let count = self.ids.len() + 1;
        self.ids
            .entry(id.to_owned())
            .or_insert_with(|| format!("<task:{count}>"));
    }

    fn learn(&mut self, value: &Value) {
        match value {
            Value::String(text) => {
                for regex in [&*SUMMARY_ID, &*LOG_PATH] {
                    for found in regex.captures_iter(text) {
                        self.remember(&found[1]);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| self.learn(item)),
            Value::Object(object) => {
                // A task as the panel, a result or `details` show it.
                if object.contains_key("startedAt")
                    && let Some(Value::String(id)) = object.get("id")
                {
                    self.remember(id);
                }
                object.values().for_each(|item| self.learn(item));
            }
            _ => {}
        }
    }

    fn apply(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(&text)),
            Value::Array(items) => items.into_iter().map(|item| self.apply(item)).collect(),
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, item)| {
                        if key == "pid" && item.is_number() {
                            return (key, json!("<pid>"));
                        }
                        (key, self.apply(item))
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    fn text(&self, text: &str) -> String {
        let mut text = pirc_conformance::mask_background_log_dir(text);
        text = PID_TEXT
            .replace_all(&text, |found: &regex::Captures| {
                let quote = if found[0].starts_with('\\') {
                    "\\\""
                } else {
                    "\""
                };
                format!("{quote}pid{quote}:{quote}<pid>{quote}")
            })
            .into_owned();
        for (id, shown) in &self.ids {
            if text.contains(id.as_str()) {
                text = text.replace(id.as_str(), shown);
            }
        }
        text
    }
}

/// Create `name` in the workspace: the trigger a task's command waits for
/// (`until [ -e name ]`), so it finishes at a known point of the
/// transcript.
pub fn release(agent: &AgentRun, name: &str) {
    std::fs::write(agent.workspace.join(name), "").unwrap();
}

/// A shell command that waits for [`release`] of `name`, then runs `then`.
pub fn after(name: &str, then: &str) -> String {
    format!("until [ -e {name} ]; do sleep 0.02; done; {then}")
}

/// Whether `line` is a `notify` whose message contains `text`.
pub fn notified(line: &Value, text: &str) -> bool {
    line["type"] == "extension_ui_request"
        && line["method"] == "notify"
        && line["message"].as_str().is_some_and(|m| m.contains(text))
}

/// Whether `line` ends a custom message of `custom_type`.
pub fn custom_end(line: &Value, custom_type: &str) -> bool {
    line["type"] == "message_end" && line["message"]["customType"] == custom_type
}

/// Whether a process still exists (Linux; elsewhere always `false`).
pub fn alive(pid: u64) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
        && std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                // A zombie waits only for its parent's `wait`.
                stat.rsplit(')')
                    .next()
                    .is_some_and(|rest| !rest.trim_start().starts_with('Z'))
            })
            .unwrap_or(false)
}

/// Wait until `pid` is gone, up to `limit`; whether it is.
pub async fn gone(pid: u64, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    while alive(pid) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// The log file a start reported (`Log: <path>`).
pub fn log_path(content: &str) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("Log: "))
        .expect("a log path")
        .to_owned()
}

/// Wait until a task's log (at `path`) contains `text`. The log, not
/// `background_output`, so the agent sees no extra command.
pub async fn log_contains(path: &str, text: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let log = std::fs::read(path).unwrap_or_default();
        if String::from_utf8_lossy(&log).contains(text) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{path} never contained {text:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
