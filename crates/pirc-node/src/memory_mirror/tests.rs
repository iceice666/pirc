//! Golden cases: `apps/gateway/test/memory-mirror.test.ts`.

use std::cell::{Cell, RefCell};

use super::*;
use crate::store::Db;

const KEY: &str = "cccccccccccccccc";

struct Setup {
    _root: tempfile::TempDir,
    dir: PathBuf,
    file: PathBuf,
    session_dir: String,
    session_id: String,
    db: Db,
    frames: RefCell<Vec<Value>>,
    refuse: Cell<bool>,
    state: RefCell<State>,
}

fn setup() -> Setup {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let dir = base.join("workspace-memory");
    std::fs::create_dir(&dir).unwrap();
    let db = Db::memory();
    let session_dir = base.join("sessions/pi_one").display().to_string();
    db.lock()
        .execute_batch(&format!(
            "INSERT INTO workspaces (id, host_id, display_name, canonical_path, defaults_json, created_at)
             VALUES ('test', 'node', 'Test', '{}', '{{}}', 1);
             INSERT INTO sessions (id, workspace_id, private_session_path, name, owner_user, created_at, updated_at)
             VALUES ('session_1', 'test', '{session_dir}', 'New session', 'me@example.com', 1, 1);",
            base.display()
        ))
        .unwrap();
    Setup {
        _root: root,
        file: dir.join(format!("{KEY}.jsonl")),
        dir,
        session_dir,
        session_id: "session_1".to_owned(),
        db,
        frames: RefCell::new(Vec::new()),
        refuse: Cell::new(false),
        state: RefCell::new(State::default()),
    }
}

impl Setup {
    fn with<T>(&self, work: impl FnOnce(&mut State, &Io<'_>) -> T) -> T {
        let send = |message: &NodeMessage| {
            if self.refuse.get() {
                return false;
            }
            self.frames
                .borrow_mut()
                .push(serde_json::to_value(message).unwrap());
            true
        };
        let lookup = |dir: &str| -> Option<String> {
            self.db
                .lock()
                .query_row(
                    "SELECT id FROM sessions WHERE private_session_path=?",
                    [dir],
                    |row| row.get(0),
                )
                .optional()
                .unwrap()
        };
        let io = Io {
            dir: &self.dir,
            send: &send,
            lookup: &lookup,
        };
        work(&mut self.state.borrow_mut(), &io)
    }

    /// `mirror.connect(send, watermarks)`, without the timer.
    fn connect(&self, watermarks: &[(&str, u64)]) {
        self.with(|state, io| {
            state.connected = true;
            state.acked = watermarks
                .iter()
                .map(|(key, at)| ((*key).to_owned(), *at))
                .collect();
            state.sent.clear();
            state.scan(io);
        });
    }

    fn scan(&self) {
        self.with(|state, io| state.scan(io));
    }

    fn receive(&self, watermark: u64) {
        self.with(|state, io| state.receive(io, KEY, watermark));
    }

    fn frames(&self) -> Vec<Value> {
        self.frames.borrow().clone()
    }
}

fn item(content: &str, session_dir: &str) -> Value {
    json!({
        "id": format!("id-{content}"),
        "content": content,
        "relevance": "high",
        "timestamp": "2026-09-27 10:00",
        "sessionId": "agent-internal-id",
        "sessionDir": session_dir,
        "sourceMemoryIds": ["aaaaaaaaaaaa"],
        "git": { "head": "abcdef123456", "branch": "main", "dirty": false,
            "worktree": "/secret/worktree" },
        "tokenCount": 10,
    })
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

fn append(file: &Path, text: &str) {
    use std::io::Write as _;
    std::fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

#[test]
fn sends_complete_ledger_lines_after_the_acknowledged_offset_without_paths() {
    let s = setup();
    let first = line(json!({ "type": "recorded", "at": 1,
        "items": [item("Staging first", &s.session_dir)] }));
    let second = line(
        json!({ "type": "retired", "at": 2, "ids": ["id-Staging first"],
        "reason": "superseded" }),
    );
    let partial = json!({ "type": "recorded", "at": 3, "items": [item("Later", &s.session_dir)] })
        .to_string();
    std::fs::write(&s.file, format!("{first}{second}{partial}")).unwrap();
    s.connect(&[]);
    let frames = s.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(
        frames[0],
        json!({
            "type": "memory_mirror",
            "ledgerKey": KEY,
            "offset": 0,
            "end": first.len() + second.len(),
            "lines": [
                {
                    "type": "recorded",
                    "items": [{
                        "id": "id-Staging first",
                        "content": "Staging first",
                        "relevance": "high",
                        "timestamp": "2026-09-27 10:00",
                        // The node session, not the agent's own id nor its directory.
                        "sessionId": s.session_id,
                        "git": { "head": "abcdef123456", "branch": "main", "dirty": false },
                        "sourceMemoryIds": ["aaaaaaaaaaaa"],
                    }],
                },
                { "type": "retired", "ids": ["id-Staging first"], "reason": "superseded" },
            ],
        })
    );
    let text = serde_json::to_string(&frames).unwrap();
    assert!(!text.contains("/secret"));
    assert!(!text.contains(&s.session_dir));

    // One frame at a time: nothing more until it is acknowledged.
    s.scan();
    assert_eq!(s.frames().len(), 1);
    // The half-written line waits until it is complete.
    s.receive(frames[0]["end"].as_u64().unwrap());
    assert_eq!(s.frames().len(), 1);
    append(&s.file, "\n");
    s.scan();
    let next = &s.frames()[1];
    assert_eq!(next["offset"], frames[0]["end"]);
    assert_eq!(
        next["end"],
        json!(first.len() + second.len() + partial.len() + 1)
    );
    assert_eq!(next["lines"][0]["type"], "recorded");
    assert_eq!(next["lines"][0]["items"][0]["content"], "Later");
    assert_eq!(next["lines"].as_array().unwrap().len(), 1);
}

#[test]
fn resumes_where_the_gateway_is_starts_over_when_the_ledger_shrank_and_retries() {
    let s = setup();
    let content = line(json!({ "type": "recorded", "at": 1,
        "items": [item("Kept", &s.session_dir)] }));
    std::fs::write(&s.file, &content).unwrap();
    s.connect(&[(KEY, content.len() as u64)]);
    assert!(s.frames().is_empty());

    std::fs::write(&s.file, line(json!({ "type": "cleared", "at": 2 }))).unwrap();
    s.scan();
    let frames = s.frames();
    assert_eq!(frames[0]["offset"], 0);
    assert_eq!(frames[0]["reset"], true);
    assert_eq!(frames[0]["lines"], json!([{ "type": "cleared" }]));

    // A frame that could not be sent is tried again on the next scan.
    s.receive(frames[0]["end"].as_u64().unwrap());
    append(&s.file, &line(json!({ "type": "cleared", "at": 3 })));
    s.refuse.set(true);
    s.scan();
    s.refuse.set(false);
    s.scan();
    let frames = s.frames();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1]["offset"], frames[0]["end"]);
    assert_eq!(frames[1]["lines"], json!([{ "type": "cleared" }]));
    assert!(frames[1].get("reset").is_none());
}

#[test]
fn does_not_mirror_context_snapshots_or_recurse_into_session_directories() {
    let s = setup();
    std::fs::create_dir_all(&s.session_dir).unwrap();
    std::fs::write(
        Path::new(&s.session_dir).join("context.json"),
        r#"{"text":"private context"}"#,
    )
    .unwrap();
    std::fs::write(s.dir.join("context.json"), r#"{"text":"private context"}"#).unwrap();
    std::fs::create_dir(s.dir.join("pi_session")).unwrap();
    std::fs::write(s.dir.join("pi_session/context.json"), "{}").unwrap();
    s.connect(&[]);
    assert!(s.frames().is_empty());
}

#[test]
fn a_line_longer_than_a_chunk_goes_alone_and_a_shrunk_empty_ledger_resets() {
    let s = setup();
    let long = line(json!({ "type": "cleared", "pad": "x".repeat(MIRROR_CHUNK_BYTES) }));
    let short = line(json!({ "type": "cleared", "at": 2 }));
    std::fs::write(&s.file, format!("{long}{short}")).unwrap();
    s.connect(&[]);
    let frames = s.frames();
    assert_eq!(frames[0]["end"], json!(long.len()));
    assert_eq!(frames[0]["lines"], json!([{ "type": "cleared" }]));
    // Torn and unknown lines count towards `end` but are not sent.
    s.receive(frames[0]["end"].as_u64().unwrap());
    let frames = s.frames();
    assert_eq!(frames[1]["offset"], json!(long.len()));
    assert_eq!(frames[1]["end"], json!(long.len() + short.len()));

    // Shrunk to a partial line: a reset with nothing in it.
    s.receive(frames[1]["end"].as_u64().unwrap());
    std::fs::write(&s.file, "{\"type\":").unwrap();
    s.scan();
    let frames = s.frames();
    assert_eq!(
        frames[2],
        json!({ "type": "memory_mirror", "ledgerKey": KEY, "offset": 0, "end": 0,
            "reset": true, "lines": [] })
    );
    // An unknown session directory has no `sessionId`, and stays unknown.
    s.receive(0);
    std::fs::write(
        &s.file,
        line(json!({ "type": "recorded", "items": [item("x", "/elsewhere"), { "id": 1 }] })),
    )
    .unwrap();
    s.receive(0);
    let frames = s.frames();
    let items = frames.last().unwrap()["lines"][0]["items"].clone();
    assert_eq!(items.as_array().unwrap().len(), 1);
    assert!(items[0].get("sessionId").is_none());
}
