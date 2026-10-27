use super::*;
use crate::{
    db::{CapabilitiesPatch, Db, Store as _},
    memory::store::{Action, Budgets, Change, NoteInput, ProposeInput, Store},
};
use serde_json::json;

const USER: &str = "alice";
fn seed(conn: &Connection) {
    conn.sync_remote_workspaces(
        "node",
        &[
            (
                "a".into(),
                "A".into(),
                pirc_protocol::ModeId::new("chat").unwrap(),
            ),
            (
                "b".into(),
                "B".into(),
                pirc_protocol::ModeId::new("chat").unwrap(),
            ),
        ],
    )
    .unwrap();
    policies::install_catalog(conn, &crate::app::test_modes()).unwrap();
}
fn session(conn: &Connection, name: &str, workspace: &str) -> String {
    conn.create_session(
        workspace,
        &format!("node://node/{name}"),
        "node",
        name,
        USER,
    )
    .unwrap()
    .id
}
fn store(conn: &Connection) -> Store<'_> {
    Store::new(
        conn,
        Budgets {
            user: 100000,
            note: 100000,
        },
    )
}
fn change(id: &str) -> Change {
    Change {
        actor: format!("session:{id}"),
        origins: json!(["assistant"]),
        sources: json!({"sessionId":id,"projectWorkspaceId":"forged-project-label"}),
    }
}
fn note(content: &str) -> NoteInput {
    NoteInput {
        action: Action::Add,
        id: None,
        content: Some(content.into()),
        base_revision: None,
    }
}
fn replace(id: &str, revision: i64, content: &str) -> NoteInput {
    NoteInput {
        action: Action::Replace,
        id: Some(id.into()),
        content: Some(content.into()),
        base_revision: Some(revision),
    }
}
fn propose(content: &str) -> ProposeInput {
    ProposeInput {
        action: Action::Add,
        id: None,
        content: Some(content.into()),
        base_revision: None,
        quote: content.into(),
    }
}
fn project(origin: &Snapshot) -> Option<&str> {
    match &origin.source {
        Source::Session {
            project_workspace_id,
            ..
        } => project_workspace_id.as_deref(),
        _ => None,
    }
}
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn source_is_frozen_at_each_write_and_restore_does_not_reassign_it_to_current_project() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let id = session(&conn, "writer", "node:a");
    let memory = store(&conn);
    let (entry, _) = memory
        .write_note(USER, &note("from A"), &change(&id))
        .unwrap();
    let first = version(&conn, USER, &entry.id, Some(1)).unwrap();
    assert_eq!(project(&first), Some("node:a"));
    conn.execute(
        "UPDATE sessions SET workspace_id='node:b' WHERE id=?",
        [&id],
    )
    .unwrap();
    let (second, _) = memory
        .write_note(USER, &replace(&entry.id, 1, "from B"), &change(&id))
        .unwrap();
    assert_eq!(version(&conn, USER, &entry.id, Some(1)).unwrap(), first);
    let second_origin = version(&conn, USER, &entry.id, Some(2)).unwrap();
    assert_eq!(project(&second_origin), Some("node:b"));
    assert!(matches!(
        second_origin.source,
        Source::Session {
            membership_revision: 2,
            binding_generation: 2,
            ..
        }
    ));
    let restored = memory.restore(USER, &entry.id, Some(1)).unwrap();
    assert_eq!(restored.content, "from A");
    assert_eq!(
        version(&conn, USER, &entry.id, Some(restored.revision)).unwrap(),
        first
    );
    let remove = NoteInput {
        action: Action::Remove,
        id: Some(entry.id.clone()),
        content: None,
        base_revision: Some(restored.revision),
    };
    memory.write_note(USER, &remove, &change(&id)).unwrap();
    assert_eq!(count(&conn, "memory_version_contexts"), 3); // contentless remove adds no source
    let restored = memory.restore(USER, &entry.id, None).unwrap();
    assert_eq!(
        version(&conn, USER, &entry.id, Some(restored.revision)).unwrap(),
        first
    );
    let creator: String = conn
        .query_row(
            "SELECT created_by_session FROM memory_entries WHERE id=?",
            [&entry.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(creator, id);
    assert_eq!(second.revision, 2);
    assert!(
        conn.execute(
            r#"UPDATE memory_version_contexts SET origin_json='{"version":1,"kind":"user"}'"#,
            []
        )
        .is_err()
    );
}

#[test]
fn approval_keeps_proposal_origin_across_move_duplicate_and_gateway_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let (proposal_id, origin) = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        seed(&conn);
        let id = session(&conn, "writer", "node:a");
        let input = propose("prefers tea");
        let (p, _) = store(&conn)
            .propose(USER, &id, &input, &json!({"sessionId":id}))
            .unwrap();
        let original = proposal(&conn, USER, &p.id).unwrap();
        conn.execute(
            "UPDATE sessions SET workspace_id='node:b' WHERE id=?",
            [&id],
        )
        .unwrap();
        let (duplicate, reused) = store(&conn)
            .propose(USER, &id, &input, &json!({"sessionId":id}))
            .unwrap();
        assert!(reused);
        assert_eq!(duplicate.id, p.id);
        assert_eq!(proposal(&conn, USER, &p.id).unwrap(), original);
        (p.id, original)
    };
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    let (_, entry) = store(&conn).approve(USER, &proposal_id, None).unwrap();
    assert_eq!(version(&conn, USER, &entry.id, Some(1)).unwrap(), origin);
    assert_eq!(project(&origin), Some("node:a"));
    assert!(
        conn.execute(
            r#"UPDATE memory_proposal_contexts SET origin_json='{"version":1,"kind":"user"}'"#,
            []
        )
        .is_err()
    );
    store(&conn).forget(USER, &entry.id).unwrap();
    assert_eq!(count(&conn, "memory_version_contexts"), 0);
    assert_eq!(count(&conn, "memory_proposal_contexts"), 0);
    assert_eq!(count(&conn, "memory_log"), 1); // the content-free Forget audit row only
}

#[test]
fn unknown_legacy_proposal_and_restore_never_use_todays_membership() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let id = session(&conn, "writer", "node:a");
    let (p, _) = store(&conn)
        .propose(
            USER,
            &id,
            &propose("legacy preference"),
            &json!({"sessionId":id}),
        )
        .unwrap();
    conn.execute(
        "DELETE FROM memory_proposal_contexts WHERE proposal_id=?",
        [&p.id],
    )
    .unwrap();
    conn.execute(
        "UPDATE sessions SET workspace_id='node:b' WHERE id=?",
        [&id],
    )
    .unwrap();
    let (_, entry) = store(&conn).approve(USER, &p.id, None).unwrap();
    assert_eq!(
        version(&conn, USER, &entry.id, Some(1)).unwrap().source,
        Source::Unknown
    );
    let (n, _) = store(&conn)
        .write_note(USER, &note("old text"), &change(&id))
        .unwrap();
    conn.execute("DELETE FROM memory_version_contexts", [])
        .unwrap();
    store(&conn)
        .write_note(USER, &replace(&n.id, 1, "new text"), &change(&id))
        .unwrap();
    let restored = store(&conn).restore(USER, &n.id, Some(1)).unwrap();
    assert_eq!(
        version(&conn, USER, &n.id, Some(restored.revision))
            .unwrap()
            .source,
        Source::Unknown
    );
}

#[test]
fn concurrent_editors_keep_one_revision_and_its_actual_writer_without_changing_creator() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let (a, b, entry) = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        seed(&conn);
        let a = session(&conn, "a", "node:a");
        let b = session(&conn, "b", "node:b");
        let (entry, _) = store(&conn)
            .write_note(USER, &note("original"), &change(&a))
            .unwrap();
        (a, b, entry.id)
    };
    let gate = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = [(&a, "A edit"), (&b, "B edit")]
            .into_iter()
            .map(|(id, text)| {
                let path = &path;
                let entry = &entry;
                let gate = &gate;
                scope.spawn(move || {
                    let db = Db::open(path).unwrap();
                    gate.wait();
                    store(&db.lock())
                        .write_note(USER, &replace(entry, 1, text), &change(id))
                        .map(|v| (id.clone(), v.0))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    let (writer, latest) = results.iter().find_map(|r| r.as_ref().ok()).unwrap();
    let origin = version(&conn, USER, &entry, Some(2)).unwrap();
    assert!(matches!(origin.source,Source::Session {ref session_id,..} if session_id==writer));
    assert_eq!(
        store(&conn).entry(USER, &entry).unwrap().content,
        latest.content
    );
    assert_eq!(count(&conn, "memory_version_contexts"), 2);
    let creator: String = conn
        .query_row(
            "SELECT created_by_session FROM memory_entries WHERE id=?",
            [&entry],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(creator, a);
}

#[test]
fn provenance_failure_and_cross_owner_source_roll_back_the_memory_write() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let id = session(&conn, "writer", "node:a");
    conn.execute_batch("CREATE TRIGGER fail_origin BEFORE INSERT ON memory_version_contexts BEGIN SELECT RAISE(ABORT,'disk error'); END;").unwrap();
    assert!(
        store(&conn)
            .write_note(USER, &note("must not survive"), &change(&id))
            .is_err()
    );
    assert_eq!(count(&conn, "memory_entries"), 0);
    assert_eq!(count(&conn, "memory_log"), 0);
    conn.execute_batch("DROP TRIGGER fail_origin; CREATE TRIGGER fail_proposal_origin BEFORE INSERT ON memory_proposal_contexts BEGIN SELECT RAISE(ABORT,'disk error'); END;").unwrap();
    assert!(
        store(&conn)
            .propose(
                USER,
                &id,
                &propose("must not survive"),
                &json!({"sessionId":id})
            )
            .is_err()
    );
    assert_eq!(count(&conn, "memory_proposals"), 0);
    conn.execute("UPDATE sessions SET owner_user='bob' WHERE id=?", [&id])
        .unwrap();
    assert_eq!(
        store(&conn)
            .write_note(USER, &note("foreign source"), &change(&id))
            .unwrap_err()
            .status,
        403
    );
    assert_eq!(count(&conn, "memory_entries"), 0);
}

#[test]
fn deleting_an_editor_keeps_other_creators_memory_and_project_scrub_erases_only_its_versions() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let a = session(&conn, "a", "node:a");
    let b = session(&conn, "b", "node:b");
    let (entry, _) = store(&conn)
        .write_note(USER, &note("original A"), &change(&a))
        .unwrap();
    let origin = version(&conn, USER, &entry.id, Some(1)).unwrap();
    store(&conn)
        .write_note(USER, &replace(&entry.id, 1, "edited B"), &change(&b))
        .unwrap();
    let (p, _) = store(&conn)
        .propose(USER, &b, &propose("pending B"), &json!({"sessionId":b}))
        .unwrap();
    store(&conn).forget_session(USER, &b).unwrap();
    assert_eq!(
        store(&conn).entry(USER, &entry.id).unwrap().content,
        "edited B"
    );
    assert_eq!(count(&conn, "memory_version_contexts"), 2);
    assert_eq!(count(&conn, "memory_proposal_contexts"), 0);
    assert!(store(&conn).proposal(USER, &p.id).is_err());
    conn.begin_session_deletion(&b, USER).unwrap();
    conn.finish_session_deletion(&b).unwrap();
    assert_eq!(
        project(&version(&conn, USER, &entry.id, Some(2)).unwrap()),
        Some("node:b")
    );
    store(&conn)
        .delete_project(USER, &[b], "node:b", &[], true)
        .unwrap();
    let restored = store(&conn).entry(USER, &entry.id).unwrap();
    assert_eq!(restored.content, "original A");
    assert_eq!(
        version(&conn, USER, &entry.id, Some(restored.revision)).unwrap(),
        origin
    );
    assert_eq!(count(&conn, "memory_version_contexts"), 2); // original + copied restore; B scrubbed
    store(&conn).forget_session(USER, &a).unwrap();
    assert_eq!(count(&conn, "memory_version_contexts"), 0);
}

#[test]
fn migration_keeps_large_legacy_history_unknown_under_concurrent_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let id = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        seed(&conn);
        let id = session(&conn, "writer", "node:a");
        crate::db::atomic(&conn,|tx|{
            for i in 1..=2048 {
                tx.execute("INSERT INTO memory_log(owner_user,entry_id,revision,op,content,origins_json,sources_json,actor,at) VALUES('alice','old',?,'replace',?,'[]',?,'session:legacy',?)",params![i,format!("historical {i}"),json!({"sessionId":id}).to_string(),i])?;
            } Ok(())
        }).unwrap();
        conn.execute("INSERT INTO memory_entries(id,owner_user,kind,content,status,revision,origins_json,sources_json,created_at,updated_at,created_by_session) VALUES('old','alice','note','historical 2048','active',2048,'[]',?,1,2048,?)",params![json!({"sessionId":id}).to_string(),id]).unwrap();
        conn.execute_batch(concat!(
            include_str!("../test_remove_provenance.sql"),
            "PRAGMA user_version=1022;"
        ))
        .unwrap();
        id
    };
    let gate = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    gate.wait();
                    let db = Db::open(&path).unwrap();
                    assert_eq!(count(&db.lock(), "memory_log"), 2048);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    });
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    assert_eq!(count(&conn, "memory_version_contexts"), 0);
    assert_eq!(count(&conn, "memory_proposal_contexts"), 0);
    assert_eq!(store(&conn).history(USER, "old").unwrap().len(), 2048);
    assert_eq!(
        store(&conn).entry(USER, "old").unwrap().content,
        "historical 2048"
    );
    assert_eq!(
        version(&conn, USER, "old", Some(1024)).unwrap().source,
        Source::Unknown
    );
    let source: String = conn
        .query_row(
            "SELECT sources_json FROM memory_log WHERE revision=2048",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, json!({"sessionId":id}).to_string());
    let (entry, _) = store(&conn)
        .write_note(USER, &note("new after migration"), &change(&id))
        .unwrap();
    assert_eq!(
        project(&version(&conn, USER, &entry.id, Some(1)).unwrap()),
        Some("node:a")
    );
    assert_eq!(count(&conn, "memory_version_contexts"), 1);
}

#[tokio::test]
async fn stale_agent_context_cannot_write_or_propose_under_a_new_environment() {
    let (app, _dir) = crate::memory::tests::app();
    let user = "me@example.com";
    let context = {
        let conn = app.db.lock();
        seed(&conn);
        let id = session(&conn, "writer", "node:a");
        conn.execute(
            "UPDATE sessions SET owner_user=? WHERE id=?",
            params![user, id],
        )
        .unwrap();
        let session = conn.get_session(&id).unwrap();
        let workspace = conn.get_workspace("node:a").unwrap();
        crate::agent_ops::OpContext {
            mode: app.require_mode(&workspace).unwrap(),
            session,
            workspace,
            user: user.into(),
        }
    };
    app.db
        .lock()
        .patch_workspace_capabilities(
            "node:a",
            &serde_json::from_value::<CapabilitiesPatch>(json!({"web_search":false})).unwrap(),
        )
        .unwrap();
    for (op, args) in [
        (
            "memory.note",
            json!({"action":"add","content":"new note","origins":["assistant"]}),
        ),
        (
            "memory.proposeUser",
            json!({"action":"add","content":"new fact","quote":"my words","entryIds":["entry-1"]}),
        ),
    ] {
        let parsed = crate::memory::parse_op(op, &args).unwrap().unwrap();
        let error = crate::memory::run_op(&app, &context, parsed)
            .await
            .unwrap_err();
        assert_eq!(error.code, "stale_environment");
    }
    assert_eq!(count(&app.db.lock(), "memory_entries"), 0);
    assert_eq!(count(&app.db.lock(), "memory_proposals"), 0);
    let mut fresh = context;
    fresh.session = app.db.lock().get_session(&fresh.session.id).unwrap();
    let parsed = crate::memory::parse_op(
        "memory.note",
        &json!({"action":"add","content":"new note","origins":["assistant"]}),
    )
    .unwrap()
    .unwrap();
    let result = crate::memory::run_op(&app, &fresh, parsed).await.unwrap();
    let origin = version(
        &app.db.lock(),
        user,
        result["id"].as_str().unwrap(),
        Some(1),
    )
    .unwrap();
    assert!(matches!(
        origin.source,
        Source::Session {
            binding_generation: 2,
            workspace_policy_revision: 2,
            ..
        }
    ));
}

#[test]
fn user_edit_of_mixed_project_history_has_no_invented_current_project_source() {
    use crate::memory::store::{ProjectChoice, ProjectDecision};
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let a = session(&conn, "a", "node:a");
    let b = session(&conn, "b", "node:b");
    let (entry, _) = store(&conn)
        .write_note(USER, &note("A first"), &change(&a))
        .unwrap();
    store(&conn)
        .write_note(USER, &replace(&entry.id, 1, "B middle"), &change(&b))
        .unwrap();
    store(&conn)
        .write_note(USER, &replace(&entry.id, 2, "A last"), &change(&a))
        .unwrap();
    store(&conn)
        .delete_project(
            USER,
            &[b],
            "node:b",
            &[(
                entry.id.clone(),
                ProjectDecision {
                    revision: 3,
                    choice: ProjectChoice::Edit("user reviewed text".into()),
                },
            )],
            true,
        )
        .unwrap();
    assert_eq!(
        version(&conn, USER, &entry.id, Some(4)).unwrap().source,
        Source::User
    );
    assert_eq!(count(&conn, "memory_version_contexts"), 3); // A first, A last, user edit
    assert_eq!(
        store(&conn).entry(USER, &entry.id).unwrap().content,
        "user reviewed text"
    );
    let scrubbed:Option<String>=conn.query_row("SELECT origin_json FROM memory_version_contexts c JOIN memory_log l ON l.seq=c.log_seq WHERE l.entry_id=? AND l.revision=2",[&entry.id],|r|r.get(0)).optional().unwrap();
    assert!(scrubbed.is_none());
}
