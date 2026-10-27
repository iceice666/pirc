use crate::db::{Db, Session, Store, atomic};
use pirc_protocol::ModeId;
use rusqlite::{Connection, params};
use serde_json::json;

fn seed(conn: &Connection) {
    conn.sync_remote_workspaces(
        "node",
        &[
            ("chats".into(), "Chats".into(), ModeId::new("chat").unwrap()),
            (
                "project".into(),
                "Project".into(),
                ModeId::new("chat").unwrap(),
            ),
            (
                "repo".into(),
                "Repository".into(),
                ModeId::new("directory").unwrap(),
            ),
            (
                "custom".into(),
                "Custom".into(),
                ModeId::new("research").unwrap(),
            ),
        ],
    )
    .unwrap();
}

fn create(conn: &Connection, workspace: &str, remote: &str) -> Session {
    conn.create_session(
        &format!("node:{workspace}"),
        &format!("node://node/{remote}"),
        "node",
        remote,
        "alice",
    )
    .unwrap()
}

#[test]
fn every_legacy_identity_has_a_durable_binding_without_private_session_details() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    for (workspace, mode) in [
        ("chats", "chat"),
        ("project", "chat"),
        ("repo", "directory"),
        ("custom", "research"),
    ] {
        let session = create(&conn, workspace, workspace);
        let public = session.public();
        assert_eq!(public["id"], session.id);
        assert_eq!(public["workspaceId"], format!("node:{workspace}"));
        assert_eq!(
            public["binding"],
            json!({
                "version":1,
                "membership":{"revision":1,"legacyWorkspaceId":format!("node:{workspace}")},
                "execution":{"generation":1,"workspaceId":format!("node:{workspace}"),"nodeId":"node","modeId":mode}
            })
        );
        for key in ["piSessionId", "privateSessionPath", "ownerUser"] {
            assert!(public.get(key).is_none(), "{key}");
        }
        assert_eq!(
            conn.get_session(&session.id).unwrap().binding,
            session.binding
        );
    }
    assert_eq!(conn.list_sessions().unwrap().len(), 4);
}

#[test]
fn first_mapping_and_runner_or_control_lifetimes_do_not_change_binding_versions() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    // Same insert as U1 acceptance: an accepted public session without a Node ID yet.
    conn.execute("INSERT INTO sessions(id,workspace_id,private_session_path,name,node_id,owner_user,created_at,updated_at) VALUES('pending','node:repo','submission://pending','Input','node','alice',10,10)", []).unwrap();
    let before = conn.get_session("pending").unwrap().binding;
    conn.execute("UPDATE sessions SET pi_session_id='first',private_session_path='node://node/first' WHERE id='pending'", []).unwrap();
    conn.execute(
        "UPDATE sessions SET runner_epoch=4,runner_state='running',name='Named' WHERE id='pending'",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO leases(session_id,client_id,generation,expires_at,updated_at,owner_user) VALUES('pending','phone',8,9999999999,1,'alice')", []).unwrap();
    conn.execute(
        "UPDATE leases SET generation=9,client_id='web' WHERE session_id='pending'",
        [],
    )
    .unwrap();
    seed(&conn); // Node reconnect with the same workspace ID/mode.
    conn.recover_startup().unwrap();
    assert_eq!(conn.get_session("pending").unwrap().binding, before);
    // An actual remapping of an established private session is distinguishable.
    conn.execute(
        "UPDATE sessions SET pi_session_id='replacement' WHERE id='pending'",
        [],
    )
    .unwrap();
    let after = conn.get_session("pending").unwrap().binding;
    assert_eq!(after.execution.generation, 2);
    assert_eq!(after.membership, before.membership);
}

#[test]
fn legacy_mapping_and_mode_changes_advance_only_the_relevant_versions_atomically() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let session = create(&conn, "repo", "run");
    let other = create(&conn, "repo", "other");
    conn.execute(
        "UPDATE sessions SET node_id='new-node' WHERE id=?",
        [&session.id],
    )
    .unwrap();
    let binding = conn.get_session(&session.id).unwrap().binding;
    assert_eq!(binding.membership.revision, 1);
    assert_eq!(binding.execution.generation, 2);
    assert_eq!(binding.execution.node_id.as_deref(), Some("new-node"));
    // Storage adapter coverage, not a supported public switch operation.
    conn.execute(
        "UPDATE sessions SET workspace_id='node:custom' WHERE id=?",
        [&session.id],
    )
    .unwrap();
    let binding = conn.get_session(&session.id).unwrap().binding;
    assert_eq!(binding.membership.revision, 2);
    assert_eq!(binding.membership.legacy_workspace_id, "node:custom");
    assert_eq!(binding.execution.generation, 3);
    assert_eq!(binding.execution.mode_id, "research");
    conn.sync_remote_workspaces(
        "node",
        &[(
            "custom".into(),
            "Renamed".into(),
            ModeId::new("new-mode").unwrap(),
        )],
    )
    .unwrap();
    let binding = conn.get_session(&session.id).unwrap().binding;
    assert_eq!(binding.membership.revision, 3);
    assert_eq!(binding.execution.generation, 4);
    assert_eq!(binding.execution.mode_id, "new-mode");
    assert_eq!(conn.get_session(&other.id).unwrap().binding, other.binding);
    let result: crate::error::ApiResult<()> = atomic(&conn, |tx| {
        tx.execute(
            "UPDATE sessions SET workspace_id='node:repo' WHERE id=?",
            [&session.id],
        )?;
        Err(crate::error::ApiError::invalid_input())
    });
    assert!(result.is_err());
    assert_eq!(conn.get_session(&session.id).unwrap().binding, binding);
}

#[test]
fn checkpoint_continuation_reuses_its_binding_and_private_workspace_ownership() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    conn.claim_checkpoint_workspace("node:repo", "alice")
        .unwrap();
    let first = conn
        .create_checkpoint_session(
            "node:repo",
            "node://node/recovered",
            "node",
            "recovered",
            "alice",
        )
        .unwrap();
    let retry = conn
        .create_checkpoint_session(
            "node:repo",
            "node://node/recovered",
            "node",
            "recovered",
            "alice",
        )
        .unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(retry.binding, first.binding);
    assert!(
        conn.create_checkpoint_session(
            "node:repo",
            "node://node/recovered",
            "node",
            "recovered",
            "bob"
        )
        .is_err()
    );
    assert_eq!(conn.list_sessions().unwrap().len(), 1);
}

#[test]
fn failed_creation_and_deletion_leave_no_orphan_binding() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let result: crate::error::ApiResult<()> = atomic(&conn, |tx| {
        create(tx, "project", "aborted");
        Err(crate::error::ApiError::invalid_input())
    });
    assert!(result.is_err());
    let count = || {
        conn.query_row("SELECT count(*) FROM conversation_bindings", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(count(), 0);
    let session = create(&conn, "project", "kept");
    conn.begin_session_deletion(&session.id, "alice").unwrap();
    conn.finish_session_deletion(&session.id).unwrap();
    assert_eq!(count(), 0);
    assert!(conn.session_deletion(&session.id).unwrap().is_some());
}

#[test]
fn migration_is_restart_safe_under_concurrent_opens_and_preserves_existing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.sqlite");
    let db = Db::open(&path).unwrap();
    let identities = {
        let conn = db.lock();
        seed(&conn);
        let mut identities = Vec::new();
        for i in 0..64 {
            let session = create(
                &conn,
                ["chats", "project", "repo", "custom"][i % 4],
                &format!("old-{i}"),
            );
            conn.execute("INSERT INTO memory_entries(id,owner_user,kind,content,status,revision,origins_json,sources_json,created_at,updated_at,created_by_session) VALUES(?1,'alice','fact','keep content','active',3,'[]','[]',1,2,?1)", [&session.id]).unwrap();
            conn.execute("INSERT INTO commands(id,session_id,payload_hash,payload_json,status,created_at,updated_at) VALUES(?1,?1,'old-hash','{}','accepted',1,2)", [&session.id]).unwrap();
            identities.push(session);
        }
        // Exact 1020 shape: no new table or triggers, original data untouched.
        conn.execute_batch(concat!(include_str!("test_remove_policies.sql"), "DROP TRIGGER conversation_binding_insert; DROP TRIGGER conversation_binding_mapping; DROP TRIGGER conversation_binding_mode; DROP TABLE conversation_bindings; PRAGMA user_version=1020;")).unwrap();
        identities
    };
    drop(db);
    let barrier = std::sync::Barrier::new(6);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..6)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let db = Db::open(&path).unwrap();
                    assert_eq!(db.lock().list_sessions().unwrap().len(), 64);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    });
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    for expected in identities {
        let actual = conn.get_session(&expected.id).unwrap();
        assert_eq!(actual.public(), expected.public());
        assert_eq!(actual.owner_user, expected.owner_user);
        assert_eq!(actual.pi_session_id, expected.pi_session_id);
        let (content, revision, source): (String, i64, String) = conn
            .query_row(
                "SELECT content,revision,created_by_session FROM memory_entries WHERE id=?",
                [&actual.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (content.as_str(), revision, source.as_str()),
            ("keep content", 3, actual.id.as_str())
        );
        assert_eq!(conn.get_command(&actual.id).unwrap().status, "accepted");
    }
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM conversation_bindings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        64
    );
    // The original workspace and all referenced private mappings remain in place.
    assert_eq!(
        conn.query_row("SELECT count(*) FROM workspaces", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    let public = conn.list_sessions().unwrap();
    assert!(public.iter().all(|s| s.runner_epoch == 0));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM leases", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let invalid = conn.execute(
        "UPDATE conversation_bindings SET generation=? WHERE session_id=?",
        params![0, public[0].id],
    );
    assert!(invalid.is_err());
}

#[test]
fn invalid_historical_workspace_reference_refuses_migration_without_hiding_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.sqlite");
    let db = Db::open(&path).unwrap();
    let id = {
        let conn = db.lock();
        seed(&conn);
        let session = create(&conn, "repo", "orphan");
        conn.execute_batch(concat!(include_str!("test_remove_policies.sql"), "DROP TRIGGER conversation_binding_insert; DROP TRIGGER conversation_binding_mapping; DROP TRIGGER conversation_binding_mode; DROP TABLE conversation_bindings; PRAGMA user_version=1020; PRAGMA foreign_keys=OFF; DELETE FROM workspaces WHERE id='node:repo';")).unwrap();
        session.id
    };
    drop(db);
    assert!(Db::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1020
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='conversation_bindings'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT pi_session_id FROM sessions WHERE id=?", [id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "orphan"
    );
}
