//! `apps/gateway/test/memory-store.test.ts`.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};

use super::store::{Action, Budgets, Change, Entry, NoteInput, Store};
use pirc_providers::backends::BackendService;

use crate::app::{App, empty_models};
use crate::db::Db;
use crate::error::ApiResult;

const ME: &str = "me@example.com";
const OTHER: &str = "other@example.com";

/// A gateway over an in-memory database, for tests that need an [`App`].
pub fn app() -> (Arc<App>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let env = pirc_config::Env::new(
        [
            (
                "PIRC_NODE_TOKENS",
                r#"{"n1":"0123456789abcdef0123456789abcdef"}"#,
            ),
            ("PIRC_TRUSTED_PROXIES", "127.0.0.1"),
            ("PIRC_ALLOWED_ORIGINS", "https://a.example"),
            ("PIRC_ALLOWED_HOSTS", "a.example"),
            ("PIRC_ALLOWED_USERS", ME),
            ("PIRC_STATE_DIR", state.to_str().unwrap()),
            ("PIRC_TIMEZONE", "UTC"),
            ("PIRC_MEMORY_USER_CHARS", "60"),
            ("PIRC_MEMORY_NOTE_CHARS", "80"),
            ("HOME", "/home/test"),
        ],
        "/",
    );
    let config = pirc_config::GatewayConfig::load(&env).unwrap();
    let backends = BackendService::open(&state, empty_models()).unwrap();
    (
        App::new(
            config,
            Arc::new(Db::memory()),
            backends,
            crate::app::test_modes(),
        ),
        dir,
    )
}

fn store(conn: &Connection) -> Store<'_> {
    Store::new(conn, Budgets { user: 60, note: 80 })
}

fn from_chat() -> Change {
    Change {
        actor: "session:s1".into(),
        origins: json!(["assistant"]),
        sources: json!({ "sessionId": "s1" }),
    }
}

fn code<T>(result: ApiResult<T>) -> &'static str {
    match result {
        Ok(_) => panic!("expected a failure"),
        Err(error) => error.code,
    }
}

fn add(content: &str) -> NoteInput {
    NoteInput {
        action: Action::Add,
        id: None,
        content: Some(content.into()),
        base_revision: None,
    }
}

fn edit(action: Action, id: &str, content: Option<&str>, base: Option<i64>) -> NoteInput {
    NoteInput {
        action,
        id: Some(id.into()),
        content: content.map(str::to_owned),
        base_revision: base,
    }
}

fn note(store: &Store<'_>, content: &str, user: &str) -> ApiResult<Entry> {
    store
        .write_note(user, &add(content), &from_chat())
        .map(|(entry, _)| entry)
}

#[test]
fn notes_are_added_replaced_and_removed_with_every_revision_logged() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let added = note(&store, "m5pro  holds\n the pirc repo", ME).unwrap();
    assert_eq!(
        (added.kind.as_str(), added.content.as_str(), added.revision),
        ("note", "m5pro holds the pirc repo", 1)
    );
    assert!(added.id.starts_with('n') && added.id.len() == 9);
    // Adding the same fact again (ignoring case and spacing) changes nothing.
    let (same, unchanged) = store
        .write_note(ME, &add("M5PRO holds the pirc repo"), &from_chat())
        .unwrap();
    assert!(unchanged);
    assert_eq!(same.id, added.id);

    // A replace must name the revision it saw; anything else returns the current one.
    let stale = store
        .write_note(
            ME,
            &edit(Action::Replace, &added.id, Some("x"), Some(0)),
            &from_chat(),
        )
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
    assert_eq!(
        stale.details,
        Some(json!({ "id": added.id, "revision": 1, "content": "m5pro holds the pirc repo" }))
    );
    let replaced = store
        .write_note(
            ME,
            &edit(
                Action::Replace,
                &added.id,
                Some("lumo holds the pirc repo"),
                Some(1),
            ),
            &Change {
                origins: json!(["assistant", "tool:bash"]),
                ..from_chat()
            },
        )
        .unwrap()
        .0;
    assert_eq!(replaced.revision, 2);
    assert_eq!(replaced.origins, json!(["assistant", "tool:bash"]));
    let removed = store
        .write_note(
            ME,
            &edit(Action::Remove, &added.id, None, Some(2)),
            &from_chat(),
        )
        .unwrap()
        .0;
    assert_eq!((removed.status.as_str(), removed.revision), ("removed", 3));
    let history: Vec<(i64, String, Option<String>)> = store
        .history(ME, &added.id)
        .unwrap()
        .into_iter()
        .map(|v| (v.revision, v.op, v.content))
        .collect();
    assert_eq!(
        history,
        [
            (3, "remove".into(), None),
            (2, "replace".into(), Some("lumo holds the pirc repo".into())),
            (1, "add".into(), Some("m5pro holds the pirc repo".into())),
        ]
    );
    assert_eq!(store.context(ME).unwrap()["notes"], json!([]));
}

#[test]
fn notes_from_fetched_content_are_marked_in_the_context() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let write = |content: &str, origins: Value| {
        store
            .write_note(
                ME,
                &add(content),
                &Change {
                    origins,
                    ..from_chat()
                },
            )
            .unwrap()
            .0
    };
    write("fetched", json!(["assistant", "tool:bash:network"]));
    write(
        "browsed",
        json!(["assistant", "tool:browser_snapshot", "tool:read"]),
    );
    write("local", json!(["assistant", "tool:bash"]));
    // The user's own words count more than a page they asked about.
    write("quoted", json!(["assistant", "tool:web_fetch", "user"]));
    let context = store.context(ME).unwrap();
    let mut fetched: Vec<(&str, bool)> = context["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| {
            (
                note["content"].as_str().unwrap(),
                note.get("fetched") == Some(&json!(true)),
            )
        })
        .collect();
    // Notes written in the same millisecond come in id order: sort.
    fetched.sort();
    assert_eq!(
        fetched,
        [
            ("browsed", true),
            ("fetched", true),
            ("local", false),
            ("quoted", false),
        ]
    );
}

#[test]
fn notes_stay_within_the_budget_one_entry_per_fact() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    note(&store, &"a".repeat(50), ME).unwrap();
    let full = note(&store, &"b".repeat(31), ME).unwrap_err();
    assert_eq!(full.code, "memory_full");
    assert_eq!(
        full.message,
        "MEMORY is full (50/80 characters, 31 more needed); replace or remove entries to make room"
    );
    assert_eq!(
        code(note(&store, &"c".repeat(1001), ME)),
        "payload_too_large"
    );
    assert_eq!(code(note(&store, "   ", ME)), "invalid_input");
    assert_eq!(
        store.usage(ME).unwrap()["note"],
        json!({ "used": 50, "max": 80 })
    );
}

#[test]
fn secrets_are_stripped_before_storing() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = note(&store, &format!("deploy token ghp_{}", "a".repeat(36)), ME).unwrap();
    assert_eq!(entry.content, "deploy token ghp_[REDACTED]");
}

#[test]
fn the_assistant_never_touches_user_entries_directly() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = store
        .insert_user(ME, "Prefers short answers.", "s1")
        .unwrap();
    assert_eq!(
        code(store.write_note(
            ME,
            &edit(Action::Replace, &entry.id, Some("x"), Some(1)),
            &from_chat()
        )),
        "forbidden"
    );
}

#[test]
fn users_are_kept_apart() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let mine = note(&store, "mine", ME).unwrap();
    assert_eq!(code(store.entry(OTHER, &mine.id)), "not_found");
    assert_eq!(store.context(OTHER).unwrap()["notes"], json!([]));
}

#[test]
fn forgetting_erases_every_version_and_refuses_the_text_again() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = store.insert_user(ME, "Has two cats.", "s1").unwrap();
    conn.execute(
        "UPDATE memory_entries SET content='Has three cats.', revision=2 WHERE id=?",
        [&entry.id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_log (owner_user,entry_id,revision,op,content,origins_json,sources_json,actor,at) VALUES (?,?,2,'replace','Has three cats.','[\"user\"]','{}','user',0)",
        [ME, &entry.id],
    )
    .unwrap();
    // A database from before the rewrite still has USER proposals, which
    // carry the text too.
    conn.execute_batch(
        "CREATE TABLE memory_proposals (
           id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT,
           target_revision INTEGER, content TEXT, content_hash TEXT, quote TEXT NOT NULL,
           sources_json TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL,
           created_at INTEGER NOT NULL, decided_at INTEGER
         );",
    )
    .unwrap();
    for (id, target, content, status) in [
        ("p1", None, Some("Has two cats."), "approved"),
        ("p2", Some(entry.id.as_str()), None, "pending"),
    ] {
        conn.execute(
            "INSERT INTO memory_proposals VALUES (?,?,'add',?,NULL,?,?,'I have two cats','{}','s1',?,0,NULL)",
            rusqlite::params![
                id,
                ME,
                target,
                content,
                content.map(super::text::content_hash),
                status
            ],
        )
        .unwrap();
    }

    store.forget(ME, &entry.id).unwrap();
    let forgotten = store.entry(ME, &entry.id).unwrap();
    assert_eq!(
        (
            forgotten.status.as_str(),
            forgotten.content.as_str(),
            &forgotten.origins,
            &forgotten.sources
        ),
        ("forgotten", "", &json!([]), &json!({}))
    );
    let history: Vec<(String, Option<String>)> = store
        .history(ME, &entry.id)
        .unwrap()
        .into_iter()
        .map(|v| (v.op, v.content))
        .collect();
    assert_eq!(history, [("forget".to_owned(), None)]);
    let proposals: Vec<(Option<String>, String, String)> = conn
        .prepare("SELECT content, quote, status FROM memory_proposals ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        proposals,
        [
            (None, String::new(), "approved".to_owned()),
            (None, String::new(), "rejected".to_owned())
        ]
    );
    // Neither version can come back, whatever the case or spacing.
    assert_eq!(code(note(&store, "has  TWO cats.", ME)), "forgotten");
    assert_eq!(code(note(&store, "Has three cats.", ME)), "forgotten");
    assert_eq!(code(store.restore(ME, &entry.id, Some(1))), "forgotten");
    // Another user's identical text is unaffected.
    assert_eq!(
        note(&store, "Has two cats.", OTHER).unwrap().content,
        "Has two cats."
    );
    // Idempotent.
    store.forget(ME, &entry.id).unwrap();
}

#[test]
fn removed_notes_and_earlier_versions_are_restored_within_the_budget() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = note(&store, "first version", ME).unwrap();
    store
        .write_note(
            ME,
            &edit(Action::Replace, &entry.id, Some("second version"), Some(1)),
            &from_chat(),
        )
        .unwrap();
    store
        .write_note(
            ME,
            &edit(Action::Remove, &entry.id, None, Some(2)),
            &from_chat(),
        )
        .unwrap();
    let back = store.restore(ME, &entry.id, None).unwrap();
    assert_eq!(
        (back.status.as_str(), back.content.as_str(), back.revision),
        ("active", "second version", 4)
    );
    let back = store.restore(ME, &entry.id, Some(1)).unwrap();
    assert_eq!(
        (back.content.as_str(), back.revision, &back.origins),
        ("first version", 5, &json!(["assistant"]))
    );
    let latest = &store.history(ME, &entry.id).unwrap()[0];
    assert_eq!(
        (latest.op.as_str(), latest.actor.as_str()),
        ("restore", "user:me@example.com")
    );
    assert_eq!(code(store.restore(ME, &entry.id, Some(3))), "not_found");
    note(&store, &"f".repeat(66), ME).unwrap();
    let removed = store
        .write_note(
            ME,
            &edit(Action::Remove, &entry.id, None, Some(5)),
            &from_chat(),
        )
        .unwrap()
        .0;
    note(&store, &"g".repeat(10), ME).unwrap();
    assert_eq!(code(store.restore(ME, &removed.id, None)), "memory_full");
}
