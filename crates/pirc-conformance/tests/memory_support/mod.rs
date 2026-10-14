//! Helpers shared by the memory and assistant transcripts: scripted memory
//! workers, local-time masking, and a recorder that keeps the workers'
//! side requests apart from the session's own.
#![allow(dead_code)]

use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use pirc_conformance::{AgentRun, ModelReply, Recorder};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Markers of each memory worker's prompt (`llm.route` of the TS tests).
pub const OBSERVER: &str = "NEW CONVERSATION CHUNK:";
pub const REFLECTOR: &str = "Crystallize any missing durable facts";
pub const DROPPER: &str = "Maximum drops allowed this run";
pub const PROMOTER: &str = "NEW SESSION MEMORY:";
const WORKER_TOOLS: [&str; 4] = [
    "record_observations",
    "record_reflections",
    "drop_observations",
    "record_workspace_memory",
];
/// Background work is over once the agent is quiet this long.
pub const QUIET: Duration = Duration::from_millis(1200);

pub fn text(value: &str) -> ModelReply {
    ModelReply::Text(value.to_owned())
}

/// The newest message of a request, as text.
fn last_message(body: &Value) -> String {
    let last =
        &body["messages"].as_array().unwrap()[body["messages"].as_array().unwrap().len() - 1];
    match &last["content"] {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The observer records these observations, citing the chunk's first user
/// entry.
pub fn observe(items: &[(&str, &str, &str)]) -> ModelReply {
    let items: Vec<(String, String, String)> = items
        .iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect();
    ModelReply::computed(move |body| {
        static SOURCE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"\[Source entry id: (\w+)\]\n\[User").unwrap());
        let chunk = last_message(body);
        let Some(found) = SOURCE.captures(&chunk) else {
            return text("Nothing new.");
        };
        let source = found[1].to_owned();
        let observations: Vec<Value> = items
            .iter()
            .map(|(content, relevance, timestamp)| {
                json!({ "timestamp": timestamp, "content": content, "relevance": relevance,
                    "sourceEntryIds": [source] })
            })
            .collect();
        ModelReply::tool(
            "obs",
            "record_observations",
            json!({ "observations": observations }),
        )
    })
}

/// The reflector crystallizes `content` from the observation mentioning
/// `about`.
pub fn reflect(about: &str, content: &str) -> ModelReply {
    let pattern = Regex::new(&format!(
        r"\[([a-f0-9]{{12}})\][^\n]*{}",
        regex::escape(about)
    ))
    .unwrap();
    let content = content.to_owned();
    ModelReply::computed(move |body| {
        let prompt = last_message(body);
        let Some(found) = pattern.captures(&prompt) else {
            return text("Nothing.");
        };
        ModelReply::tool(
            "ref",
            "record_reflections",
            json!({ "reflections": [{ "content": content,
                "supportingObservationIds": [&found[1], &found[1]] },
                { "content": "Two\nlines", "supportingObservationIds": [&found[1]] },
                { "content": "Invented.", "supportingObservationIds": ["ffffffffffff"] }] }),
        )
    })
}

/// The dropper proposes the observation mentioning `about`.
pub fn drop_observations(about: &str) -> ModelReply {
    let pattern = Regex::new(&format!(
        r"\[([a-f0-9]{{12}})\][^\n]*{}",
        regex::escape(about)
    ))
    .unwrap();
    ModelReply::computed(move |body| {
        let prompt = last_message(body);
        let Some(found) = pattern.captures(&prompt) else {
            return text("Nothing.");
        };
        ModelReply::tool(
            "drop",
            "drop_observations",
            json!({ "ids": [&found[1], &found[1], "ffffffffffff", 7], "reason": "covered" }),
        )
    })
}

/// The promoter carries `content` over, citing the new reflection.
pub fn promote(content: &str) -> ModelReply {
    let content = content.to_owned();
    ModelReply::computed(move |body| {
        static REFLECTION: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"\[([a-f0-9]{12})\] reflection:").unwrap());
        let prompt = last_message(body);
        let Some(found) = REFLECTION.captures(&prompt) else {
            return text("Nothing.");
        };
        ModelReply::tool(
            "ws",
            "record_workspace_memory",
            json!({ "add": [{ "content": content, "relevance": "high",
                "sourceMemoryIds": [&found[1]] },
                { "content": "Invented.", "relevance": "high", "sourceMemoryIds": ["invented"] }],
                "retire": ["ffffffffffff"] }),
        )
    })
}

/// `YYYY-MM-DD HH:MM` local times (`localStamp`) vary between runs.
pub fn mask_local(value: &mut Value) {
    static STAMP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}").unwrap());
    match value {
        Value::String(text) => {
            if STAMP.is_match(text) {
                *text = STAMP.replace_all(text, "<local-time>").into_owned();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask_local),
        Value::Object(object) => object.values_mut().for_each(mask_local),
        _ => {}
    }
}

/// Script timings (`activeMs`, `durationMs`, `waitedMs`) vary between runs.
pub fn mask_times(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(mask_times),
        Value::Object(object) => {
            for (key, item) in object.iter_mut() {
                if key.ends_with("Ms") && item.is_number() {
                    *item = json!("<ms>");
                } else {
                    mask_times(item);
                }
            }
        }
        _ => {}
    }
}

fn is_worker(request: &Value) -> bool {
    request["tools"][0]["name"]
        .as_str()
        .is_some_and(|name| WORKER_TOOLS.contains(&name))
}

/// A `ptc` call running one capability, as `ptcCall` in the TS tests.
pub fn ptc(id: &str, name: &str, args: Value) -> (String, String, Value) {
    let code = format!(
        "const r = await tools.call({}, {args});\nif (!r.ok) throw new PtcError(r.error);\nreturn r.data.text;",
        json!(name)
    );
    (id.to_owned(), "ptc".to_owned(), json!({ "code": code }))
}

/// A transcript; memory workers' system prompts are shown once.
pub struct Log {
    pub r: Recorder,
    prompts: Vec<String>,
    /// Session entry ids (8 random hex digits) wherever they appear: the
    /// observer's chunk and observations cite them in text.
    entries: Vec<String>,
    /// How long a turn waits for a memory worker's request started in the
    /// run (held by a gate once it arrives) before taking the requests.
    pub worker_pause: Duration,
    /// Requests taken early and recorded with the next [`Log::requests`].
    held: Vec<Value>,
}

/// The summarizer's request of a compaction (its handoff prompt last).
fn is_handoff(request: &Value) -> bool {
    request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| message["content"].as_str())
        .is_some_and(|text| text.starts_with("Stop working and write a handoff summary"))
}

impl Log {
    fn mask_entries(&mut self, value: &mut Value) {
        static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[0-9a-f]{8}\b").unwrap());
        match value {
            Value::String(text) => {
                let mut out = String::new();
                let mut last = 0;
                for found in ID.find_iter(text) {
                    // Not a part of a UUID.
                    let before = text[..found.start()].ends_with('-');
                    let after = text[found.end()..].starts_with('-');
                    if before || after {
                        continue;
                    }
                    let id = found.as_str().to_owned();
                    let index = match self.entries.iter().position(|seen| *seen == id) {
                        Some(index) => index,
                        None => {
                            self.entries.push(id);
                            self.entries.len() - 1
                        }
                    };
                    out.push_str(&text[last..found.start()]);
                    out.push_str(&format!("<entry:{}>", index + 1));
                    last = found.end();
                }
                if last > 0 {
                    out.push_str(&text[last..]);
                    *text = out;
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.mask_entries(item)),
            Value::Object(object) => object.values_mut().for_each(|item| self.mask_entries(item)),
            _ => {}
        }
    }
}

impl Log {
    pub fn new(agent: &AgentRun) -> Self {
        Self {
            r: Recorder::new(agent),
            prompts: Vec::new(),
            entries: Vec::new(),
            worker_pause: Duration::from_millis(200),
            held: Vec::new(),
        }
    }

    pub fn note(&mut self, step: &str, mut value: Value) {
        mask_local(&mut value);
        mask_times(&mut value);
        self.mask_entries(&mut value);
        self.r.note(step, value);
    }

    /// The run's requests, then the memory workers' apart.
    pub fn requests(&mut self, agent: &AgentRun, step: &str) {
        let mut taken = std::mem::take(&mut self.held);
        taken.extend(agent.take_requests());
        self.record_requests(taken, step);
    }

    fn record_requests(&mut self, taken: Vec<Value>, step: &str) {
        let (workers, main): (Vec<Value>, Vec<Value>) = taken.into_iter().partition(is_worker);
        let mut main = json!(main);
        mask_local(&mut main);
        mask_times(&mut main);
        self.mask_entries(&mut main);
        let Value::Array(main) = main else {
            unreachable!()
        };
        self.r.requests(&format!("{step}: model requests"), main);
        if workers.is_empty() {
            return;
        }
        let workers: Vec<Value> = workers
            .into_iter()
            .map(|mut request| {
                if let Some(prompt) = request["systemPrompt"].as_str().map(str::to_owned) {
                    if self.prompts.contains(&prompt) {
                        request["systemPrompt"] = json!("<seen>");
                    } else {
                        self.prompts.push(prompt);
                    }
                }
                request
            })
            .collect();
        self.note(&format!("{step}: memory requests"), json!(workers));
    }

    /// A prompt and everything until the run settles.
    pub async fn turn(&mut self, agent: &mut AgentRun, step: &str, message: &str) {
        let response = agent
            .call(json!({ "type": "prompt", "message": message }))
            .await;
        self.note(&format!("{step}: response"), response);
        let events = agent.settle().await;
        self.note(&format!("{step}: events"), json!(events));
        tokio::time::sleep(self.worker_pause).await;
        self.requests(agent, step);
    }

    /// A turn whose settling starts an automatic compaction at once: the
    /// summarizer's request may already be in when the turn's requests are
    /// taken, so it is held for the next [`Log::requests`] whichever comes
    /// first.
    pub async fn turn_then_compaction(&mut self, agent: &mut AgentRun, step: &str, message: &str) {
        let response = agent
            .call(json!({ "type": "prompt", "message": message }))
            .await;
        self.note(&format!("{step}: response"), response);
        let events = agent.settle().await;
        self.note(&format!("{step}: events"), json!(events));
        let mut taken = std::mem::take(&mut self.held);
        taken.extend(agent.take_requests());
        let (handoff, run): (Vec<Value>, Vec<Value>) = taken.into_iter().partition(is_handoff);
        self.held = handoff;
        self.record_requests(run, step);
    }

    /// Background work until the session file has `marker`, then until the
    /// agent is quiet.
    pub async fn background(&mut self, agent: &mut AgentRun, step: &str, marker: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        let file = agent.session_dir.join("session.jsonl");
        let mut lines = Vec::new();
        while !std::fs::read_to_string(&file)
            .unwrap_or_default()
            .contains(marker)
        {
            if Instant::now() > deadline {
                let requests = agent.take_requests();
                panic!(
                    "no {marker} in the session\nlines: {lines:#?}\nrequests: {requests:#?}\nsession: {:#?}",
                    agent.session_entries()
                );
            }
            lines.extend(agent.drain(Duration::from_millis(50)).await);
        }
        lines.extend(agent.drain(QUIET).await);
        self.note(&format!("{step}: lines"), json!(lines));
        self.requests(agent, step);
    }

    /// Background work that leaves no session entry: until the agent is
    /// quiet.
    pub async fn background_quiet(&mut self, agent: &mut AgentRun, step: &str) {
        let lines = agent.drain(QUIET).await;
        self.note(&format!("{step}: lines"), json!(lines));
        self.requests(agent, step);
    }

    /// A slash command: its lines up to its response and the notification
    /// that ends it.
    pub async fn slash(&mut self, agent: &mut AgentRun, message: &str) {
        let id = agent
            .command(json!({ "type": "prompt", "message": message }))
            .await;
        let mut lines = Vec::new();
        let (mut answered, mut notified) = (false, false);
        while !(answered && notified) {
            let line = agent.next().await.expect("the agent exited");
            answered |= line["type"] == "response" && line["id"] == id.as_str();
            notified |= line["type"] == "extension_ui_request" && line["method"] == "notify";
            lines.push(line);
        }
        self.note(message, json!(lines));
        self.requests(agent, message);
    }

    pub fn session(&mut self, agent: &AgentRun) {
        self.note("session file", json!(agent.session_entries()));
    }

    pub fn into_value(self) -> Value {
        self.r.into_value()
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?}");
}

/// The workspace as a git repository with one commit (fixed dates, so the
/// same hash on every run).
pub fn git_repository(workspace: &Path) {
    git(workspace, &["init", "-q", "-b", "main"]);
    git(workspace, &["config", "user.email", "t@example.com"]);
    git(workspace, &["config", "user.name", "T"]);
    git(workspace, &["add", "."]);
    git(
        workspace,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The workspace memory directory of a run (`~/.local/state/pirc/
/// workspace-memory` under the agent's home).
fn ledger_dir(workspace: &Path) -> std::path::PathBuf {
    workspace
        .parent()
        .unwrap()
        .join("home/.local/state/pirc/workspace-memory")
}

/// One workspace note a session in this (plain) directory would receive.
pub fn seed_workspace_note(workspace: &Path) {
    let root = workspace.canonicalize().unwrap();
    let key = hex(&Sha256::digest(root.display().to_string().as_bytes()))[..16].to_owned();
    let content = "Deploys go through staging first.";
    let id = hex(&Sha256::digest(content.as_bytes()))[..12].to_owned();
    let line = json!({ "type": "recorded", "at": 1, "items": [{ "id": id, "content": content,
        "relevance": "high", "timestamp": "2026-09-01 10:00", "sessionId": "s1",
        "sessionDir": "/nonexistent", "sourceMemoryIds": ["aaaaaaaaaaaa"], "tokenCount": 20 }] });
    let dir = ledger_dir(workspace);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{key}.jsonl")), format!("{line}\n")).unwrap();
}

/// The lines of the run's workspace memory ledger.
pub fn workspace_ledger(agent: &AgentRun) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(ledger_dir(&agent.workspace)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                if !line.trim().is_empty() {
                    out.push(serde_json::from_str(line).unwrap());
                }
            }
        }
    }
    out
}
