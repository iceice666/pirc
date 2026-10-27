use super::*;
use crate::{
    conversation_bindings::policies,
    db::{CapabilitiesPatch, Db},
};
use pirc_protocol::ModeId;

fn setup(conn: &Connection) -> Session {
    conn.sync_remote_workspaces(
        "node",
        &[(
            "repo".into(),
            "Repo".into(),
            ModeId::new("directory").unwrap(),
        )],
    )
    .unwrap();
    policies::install_catalog(conn, &crate::app::test_modes()).unwrap();
    conn.create_session(
        "node:repo",
        "node://node/session",
        "node",
        "session",
        "alice",
    )
    .unwrap()
}
fn change(conn: &Connection) {
    conn.patch_workspace_capabilities(
        "node:repo",
        &serde_json::from_value::<CapabilitiesPatch>(json!({"web_search":false})).unwrap(),
    )
    .unwrap();
}
fn prompt() -> Value {
    json!({"type":"prompt","message":"hello"})
}
fn origin(conn: &Connection, id: &str) -> Option<Binding> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT binding_json FROM command_environments WHERE command_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    raw.map(|v| serde_json::from_str(&v).unwrap())
}

#[test]
fn stale_visible_environment_is_rejected_without_reserving_command_or_losing_input() {
    let db = Db::memory();
    let conn = db.lock();
    let old = setup(&conn);
    change(&conn);
    let current = conn.get_session(&old.id).unwrap();
    assert!(current.binding.execution.generation > old.binding.execution.generation);
    for expected in [Some(&old.binding), None] {
        let error = receive(&conn, &current, "alice", "cmd", &prompt(), expected).unwrap_err();
        assert_eq!(
            error.code,
            if expected.is_some() {
                "stale_environment"
            } else {
                "environment_required"
            }
        );
        assert!(conn.get_command("cmd").is_err());
        assert_eq!(origin(&conn, "cmd"), None);
    }
    // A newly initiated action may use refreshed intent; retries never invent it.
    assert!(
        !receive(
            &conn,
            &current,
            "alice",
            "cmd",
            &prompt(),
            Some(&current.binding)
        )
        .unwrap()
        .1
    );
    assert_eq!(origin(&conn, "cmd"), Some(current.binding));
}

#[test]
fn fresh_expected_binding_cannot_hide_a_routing_change_after_claim() {
    let db = Db::memory();
    let conn = db.lock();
    let old = setup(&conn);
    change(&conn);
    let current = conn.get_session(&old.id).unwrap();
    assert_eq!(
        receive(
            &conn,
            &old,
            "alice",
            "cmd",
            &prompt(),
            Some(&current.binding)
        )
        .unwrap_err()
        .code,
        "stale_environment"
    );
    assert!(conn.get_command("cmd").is_err());
}

#[test]
fn stop_remains_available_from_stale_and_legacy_clients() {
    let db = Db::memory();
    let conn = db.lock();
    let old = setup(&conn);
    change(&conn);
    let current = conn.get_session(&old.id).unwrap();
    for (id, expected) in [("stop-old", Some(&old.binding)), ("stop-legacy", None)] {
        let payload = json!({"type":"stop"});
        assert!(
            !receive(&conn, &current, "alice", id, &payload, expected)
                .unwrap()
                .1
        );
        assert_eq!(origin(&conn, id), Some(current.binding.clone()));
        assert!(
            receive(&conn, &current, "alice", id, &payload, expected)
                .unwrap()
                .1
        );
    }
}

#[test]
fn unchanged_legacy_client_is_supported_but_other_binding_fields_are_not_ignored() {
    let db = Db::memory();
    let conn = db.lock();
    let session = setup(&conn);
    assert!(
        !receive(&conn, &session, "alice", "legacy", &prompt(), None)
            .unwrap()
            .1
    );
    for mutate in [
        |b: &mut Binding| b.membership.revision += 1,
        |b: &mut Binding| b.membership.legacy_workspace_id = "another".into(),
        |b: &mut Binding| b.execution.node_id = Some("other-node".into()),
        |b: &mut Binding| b.execution.mode_id = "chat".into(),
        |b: &mut Binding| b.execution.workspace_id = "other".into(),
        |b: &mut Binding| b.version = 2,
    ] {
        let mut expected = session.binding.clone();
        mutate(&mut expected);
        assert_eq!(
            receive(&conn, &session, "alice", "bad", &prompt(), Some(&expected))
                .unwrap_err()
                .code,
            "stale_environment"
        );
        assert!(conn.get_command("bad").is_err());
    }
}

#[test]
fn original_receipts_survive_restart_and_policy_changes_without_redispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let original = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        let session = setup(&conn);
        receive(
            &conn,
            &session,
            "alice",
            "cmd",
            &prompt(),
            Some(&session.binding),
        )
        .unwrap();
        conn.update_command("cmd", "outcome_unknown", None, Some("response lost"))
            .unwrap();
        change(&conn);
        session
    };
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    let current = conn.get_session(&original.id).unwrap();
    for expected in [Some(&original.binding), None] {
        let (receipt, duplicate) =
            receive(&conn, &current, "alice", "cmd", &prompt(), expected).unwrap();
        assert!(duplicate);
        assert_eq!(receipt.status, "outcome_unknown");
        assert_eq!(origin(&conn, "cmd"), Some(original.binding.clone()));
    }
    assert_eq!(
        receive(
            &conn,
            &current,
            "alice",
            "cmd",
            &prompt(),
            Some(&current.binding)
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    assert_eq!(
        receive(
            &conn,
            &current,
            "alice",
            "cmd",
            &json!({"type":"stop"}),
            None
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    assert_eq!(
        receive(&conn, &current, "mallory", "cmd", &prompt(), None)
            .unwrap_err()
            .status,
        403
    );
}

#[test]
fn failure_to_record_environment_rolls_back_command_and_original_origin_is_immutable() {
    let db = Db::memory();
    let conn = db.lock();
    let session = setup(&conn);
    conn.execute_batch("CREATE TRIGGER fail_origin BEFORE INSERT ON command_environments BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    assert!(
        receive(
            &conn,
            &session,
            "alice",
            "cmd",
            &prompt(),
            Some(&session.binding)
        )
        .is_err()
    );
    assert!(conn.get_command("cmd").is_err());
    conn.execute_batch("DROP TRIGGER fail_origin").unwrap();
    receive(
        &conn,
        &session,
        "alice",
        "cmd",
        &prompt(),
        Some(&session.binding),
    )
    .unwrap();
    assert!(
        conn.execute(
            "UPDATE command_environments SET binding_json=binding_json WHERE command_id='cmd'",
            []
        )
        .is_err()
    );
    conn.execute("DELETE FROM commands WHERE id='cmd'", [])
        .unwrap();
    assert_eq!(origin(&conn, "cmd"), None);
}

#[test]
fn independent_devices_racing_same_id_admit_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let session = {
        let db = Db::open(&path).unwrap();
        setup(&db.lock())
    };
    let gate = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = &path;
                let gate = &gate;
                let session = &session;
                scope.spawn(move || {
                    let db = Db::open(path).unwrap();
                    gate.wait();
                    receive(
                        &db.lock(),
                        session,
                        "alice",
                        "cmd",
                        &prompt(),
                        Some(&session.binding),
                    )
                    .unwrap()
                    .1
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|duplicate| !**duplicate).count(), 1);
    let db = Db::open(&path).unwrap();
    assert_eq!(origin(&db.lock(), "cmd"), Some(session.binding));
}

#[test]
fn migration_does_not_invent_an_environment_for_historical_commands() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let old = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        let session = setup(&conn);
        conn.receive_command(
            "historical",
            &session.id,
            &payload_hash(&prompt()),
            &prompt(),
        )
        .unwrap();
        conn.execute_batch("DROP TRIGGER command_environment_immutable; DROP TABLE command_environments; PRAGMA user_version=1024;").unwrap();
        session
    };
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    assert_eq!(origin(&conn, "historical"), None);
    change(&conn);
    let current = conn.get_session(&old.id).unwrap();
    assert!(
        receive(
            &conn,
            &current,
            "alice",
            "historical",
            &prompt(),
            Some(&old.binding)
        )
        .unwrap()
        .1
    );
    assert_eq!(origin(&conn, "historical"), None);
}

#[test]
fn deleting_session_cannot_admit_new_work_or_replay_old_receipts() {
    let db = Db::memory();
    let conn = db.lock();
    let session = setup(&conn);
    receive(
        &conn,
        &session,
        "alice",
        "accepted",
        &prompt(),
        Some(&session.binding),
    )
    .unwrap();
    conn.begin_session_deletion(&session.id, "alice").unwrap();
    for (id, payload) in [
        ("accepted", prompt()),
        ("new", prompt()),
        ("stop", json!({"type":"stop"})),
    ] {
        assert_eq!(
            receive(
                &conn,
                &session,
                "alice",
                id,
                &payload,
                Some(&session.binding)
            )
            .unwrap_err()
            .status,
            409
        );
    }
    assert!(conn.get_command("new").is_err());
    assert!(conn.get_command("stop").is_err());
}
