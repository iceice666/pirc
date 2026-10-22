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

fn item(content: &str, dir: &str) -> Value {
    json!({"id":pirc_agent::features::memory::ledger::hash_id(content),"content":content,"relevance":"high","timestamp":"2026-10-22 10:00","sessionId":"agent-internal-id","sessionDir":dir,"sourceMemoryIds":[],"tokenCount":10})
}
fn line(value: Value) -> String {
    format!("{value}\n")
}
fn append(file: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}
#[test]
fn mirrors_public_projection_and_integrity_in_one_frame() {
    let s = setup();
    let first = line(json!({"type":"recorded","at":1,"items":[item("Knowledge",&s.session_dir)]}));
    std::fs::write(&s.file, &first).unwrap();
    s.connect(&[]);
    let frames = s.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["lines"][0]["items"][0]["sessionId"], s.session_id);
    assert_eq!(
        frames[0]["lines"][1]["digest"],
        pirc_agent::journal::digest(first.as_bytes())
    );
    let text = frames[0].to_string();
    assert!(!text.contains(&s.session_dir));
    s.receive(first.len() as u64);
    assert_eq!(s.frames().len(), 1);
    append(&s.file, "{\"type\":");
    s.scan();
    assert_eq!(s.frames().len(), 1);
}
#[test]
fn resumes_with_checkpoint_and_never_resets_a_shrunken_ledger() {
    let s = setup();
    let raw = line(json!({"type":"recorded","at":1,"items":[item("Before",&s.session_dir)]}));
    std::fs::write(&s.file, &raw).unwrap();
    s.connect(&[(KEY, raw.len() as u64)]);
    let frame = s.frames()[0].clone();
    assert_eq!(frame["offset"], raw.len());
    assert_eq!(frame["end"], raw.len());
    assert_eq!(frame["lines"][0]["type"], "integrity");
    s.receive(raw.len() as u64);
    std::fs::write(&s.file, "").unwrap();
    s.scan();
    assert_eq!(s.frames().len(), 1);
    std::fs::write(&s.file, &raw).unwrap();
    append(&s.file, &line(json!({"type":"cleared","at":2})));
    s.refuse.set(true);
    s.scan();
    s.refuse.set(false);
    s.scan();
    assert_eq!(s.frames().len(), 2);
    assert_eq!(s.frames()[1]["lines"][0]["type"], "cleared");
    assert!(s.frames()[1].get("reset").is_none());
}
#[test]
fn a_complete_v2_clear_and_its_checkpoint_share_one_frame() {
    let s = setup();
    let mut cold = pirc_agent::workspace_journal::frame(&Default::default(), "cold");
    cold.cutover = Some(vec![]);
    let first = line(serde_json::to_value(&cold).unwrap());
    let initial = pirc_agent::workspace_journal::parse(first.as_bytes()).unwrap();
    let mut clear = pirc_agent::workspace_journal::frame(&initial, "clear");
    clear.clear = true;
    clear.generation = "new".into();
    clear.clear_cutoffs = Some(vec![]);
    std::fs::write(
        &s.file,
        format!("{}{}", first, line(serde_json::to_value(clear).unwrap())),
    )
    .unwrap();
    s.connect(&[]);
    let frames = s.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["lines"][0]["type"], "cleared");
    assert_eq!(frames[0]["lines"][1]["type"], "integrity");
}
#[test]
fn refuses_corruption_and_malformed_additions_instead_of_mirroring_retirements() {
    let s = setup();
    std::fs::write(&s.file, line(json!({"type":"recorded","items":[{"id":1}]}))).unwrap();
    s.connect(&[]);
    assert!(s.frames().is_empty());
    std::fs::write(&s.file, "{}\ninvalid\n{\"type\":\"cleared\"}\n").unwrap();
    s.scan();
    assert!(s.frames().is_empty());
}
#[test]
fn does_not_mirror_private_files_or_recurse() {
    let s = setup();
    std::fs::write(s.dir.join("context.json"), "private").unwrap();
    std::fs::create_dir(s.dir.join("nested")).unwrap();
    std::fs::write(s.dir.join("nested/cccccccccccccccc.jsonl"), "private").unwrap();
    s.connect(&[]);
    assert!(s.frames().is_empty());
}
