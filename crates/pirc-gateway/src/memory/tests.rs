//! Preferences (`store.rs`), and the test gateway the memory tests share.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;

use super::store::{Change, Preference, Store};
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
    Store::new(conn, 60)
}

fn said(quote: &str) -> Change {
    Change {
        actor: "face:host".into(),
        origins: json!(["user"]),
        sources: json!({ "roomId": "room_general", "quote": quote }),
    }
}

fn code<T>(result: ApiResult<T>) -> &'static str {
    match result {
        Ok(_) => panic!("expected a failure"),
        Err(error) => error.code,
    }
}

fn add(store: &Store<'_>, content: &str, user: &str) -> ApiResult<Preference> {
    store
        .add(user, content, Some("room_general"), &said(content))
        .map(|(preference, _)| preference)
}

#[test]
fn preferences_are_added_once_removed_and_restored_with_every_revision_logged() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let added = add(&store, "Prefers  short\n answers", ME).unwrap();
    assert_eq!(
        (
            added.content.as_str(),
            added.revision,
            added.created_in_room.as_deref()
        ),
        ("Prefers short answers", 1, Some("room_general"))
    );
    assert!(added.id.starts_with('p') && added.id.len() == 9);
    // The same preference again (ignoring case and spacing) changes nothing.
    let (same, unchanged) = store
        .add(ME, "PREFERS short answers", None, &said("x"))
        .unwrap();
    assert!(unchanged);
    assert_eq!(same.id, added.id);

    let removed = store.remove(ME, &added.id, "user:me@example.com").unwrap();
    assert_eq!((removed.status.as_str(), removed.revision), ("removed", 2));
    assert_eq!(store.list(ME, Some("active")).unwrap().len(), 0);
    let back = store.restore(ME, &added.id, None).unwrap();
    assert_eq!((back.status.as_str(), back.revision), ("active", 3));
    let history: Vec<(i64, String, Option<String>, String)> = store
        .history(ME, &added.id)
        .unwrap()
        .into_iter()
        .map(|v| (v.revision, v.op, v.content, v.actor))
        .collect();
    assert_eq!(
        history,
        [
            (
                3,
                "restore".into(),
                Some("Prefers short answers".into()),
                "user:me@example.com".into()
            ),
            (2, "remove".into(), None, "user:me@example.com".into()),
            (
                1,
                "add".into(),
                Some("Prefers short answers".into()),
                "face:host".into()
            ),
        ]
    );
    assert_eq!(code(store.restore(ME, &added.id, Some(2))), "not_found");
}

#[test]
fn preferences_stay_within_the_budget_one_entry_per_fact() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    add(&store, &"a".repeat(50), ME).unwrap();
    let full = add(&store, &"b".repeat(11), ME).unwrap_err();
    assert_eq!(full.code, "memory_full");
    assert_eq!(
        full.message,
        "Preferences are full (50/60 characters, 11 more needed); remove one to make room"
    );
    assert_eq!(
        code(add(&store, &"c".repeat(1001), ME)),
        "payload_too_large"
    );
    assert_eq!(code(add(&store, "   ", ME)), "invalid_input");
    assert_eq!(store.usage(ME).unwrap(), json!({ "used": 50, "max": 60 }));
}

#[test]
fn secrets_are_stripped_before_storing() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = add(&store, &format!("token ghp_{}", "a".repeat(36)), ME).unwrap();
    assert_eq!(entry.content, "token ghp_[REDACTED]");
}

#[test]
fn users_are_kept_apart() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let mine = add(&store, "mine", ME).unwrap();
    assert_eq!(code(store.get(OTHER, &mine.id)), "not_found");
    assert_eq!(store.list(OTHER, None).unwrap().len(), 0);
}

#[test]
fn forgetting_erases_every_version_and_refuses_the_text_again() {
    let db = Db::memory();
    let conn = db.lock();
    let store = store(&conn);
    let entry = add(&store, "Has two cats.", ME).unwrap();
    conn.execute(
        "UPDATE preferences SET content='Has three cats.', revision=2 WHERE id=?",
        [&entry.id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_log (owner_user,entry_id,revision,op,content,origins_json,sources_json,actor,at) VALUES (?,?,2,'replace','Has three cats.','[\"user\"]','{}','user',0)",
        [ME, &entry.id],
    )
    .unwrap();

    store.forget(ME, &entry.id).unwrap();
    let forgotten = store.get(ME, &entry.id).unwrap();
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
    // Neither version can come back, whatever the case or spacing, as a
    // preference or as a fact.
    assert_eq!(code(add(&store, "has  TWO cats.", ME)), "forgotten");
    assert_eq!(code(add(&store, "Has three cats.", ME)), "forgotten");
    let fact = crate::memory_records::person::NewFact {
        content: "has two cats.",
        origin: "user",
        room_id: None,
        face_id: None,
        source_entry_ids: &[],
        actor: "face:host",
    };
    assert_eq!(
        code(crate::memory_records::person::remember(&conn, ME, &fact)),
        "forgotten"
    );
    assert_eq!(code(store.restore(ME, &entry.id, Some(1))), "forgotten");
    // Another user's identical text is unaffected.
    assert_eq!(
        add(&store, "Has two cats.", OTHER).unwrap().content,
        "Has two cats."
    );
    // Idempotent.
    store.forget(ME, &entry.id).unwrap();
}
