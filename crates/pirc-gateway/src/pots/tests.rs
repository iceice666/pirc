use super::*;
use crate::db::{Db, ModeId, Store};
use rusqlite::{Connection, params};
use serde_json::json;
const USER: &str = "alice@example.test";
const OTHER: &str = "bob@example.test";
fn seed(conn: &Connection) -> String {
    conn.sync_remote_workspaces(
        "node",
        &[(
            "work".into(),
            "Work".into(),
            ModeId::new("directory").unwrap(),
        )],
    )
    .unwrap();
    conn.create_session("node:work", "/private/session", "node", "remote", USER)
        .unwrap()
        .id
}
fn input() -> ResponsibilityInput {
    serde_json::from_value(json!({"idempotencyKey":"create-1","purpose":"Watch selected progress","scopes":[{"workspaceId":"node:work","access":"progress"}],"budgets":{"observations":3,"dispatches":0,"concurrency":1}})).unwrap()
}
fn active(conn: &Connection) -> Responsibility {
    let r = create_responsibility(conn, USER, input(), 1).unwrap();
    control_responsibility(
        conn,
        USER,
        &r.id,
        ResponsibilityControl {
            expected_revision: r.revision,
            expected_generation: r.generation,
            action: ResponsibilityAction::Activate,
        },
        2,
    )
    .unwrap()
}
fn ingest(conn: &Connection, session: &str, interaction: &str) -> Vec<Suggestion> {
    ingest_progress(
        conn,
        USER,
        "node:work",
        session,
        0,
        interaction,
        i64::MAX,
        3,
    )
    .unwrap()
}
fn accept(conn: &Connection, s: &Suggestion, command: &str) -> Task {
    accept_tracking(
        conn,
        USER,
        &s.id,
        AcceptInput {
            expected_revision: s.revision,
            command_id: command.into(),
        },
        4,
    )
    .unwrap()
}
fn task_control(conn: &Connection, t: &Task, action: TaskAction) -> Task {
    control_task(
        conn,
        USER,
        &t.id,
        TaskControl {
            expected_revision: t.revision,
            expected_generation: t.control_generation,
            action,
        },
        5,
    )
    .unwrap()
}

#[test]
fn strict_input_and_scope_security() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    for extra in [json!({"actor":"pots"}), json!({"enabled":true})] {
        let mut v = serde_json::to_value(input()).unwrap();
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<ResponsibilityInput>(v).is_err());
    }
    assert!(serde_json::from_value::<TaskControl>(json!({"expectedRevision":1,"expectedGeneration":1,"action":{"type":"take_over","actor":"user"}})).is_err());
    let mut i = input();
    i.budgets.observations = 0;
    assert_eq!(
        create_responsibility(&conn, USER, i, 1).unwrap_err().status,
        400
    );
    let mut i = input();
    i.scopes[0].workspace_id = "missing".into();
    assert_eq!(
        create_responsibility(&conn, USER, i, 1).unwrap_err().status,
        404
    );
    conn.mark_checkpoint_workspace_private("node:work").unwrap();
    assert_eq!(
        create_responsibility(&conn, USER, input(), 1)
            .unwrap_err()
            .status,
        404
    );
    conn.claim_checkpoint_workspace("node:work", OTHER).unwrap();
    assert_eq!(
        create_responsibility(&conn, USER, input(), 1)
            .unwrap_err()
            .status,
        404
    );
}
#[test]
fn explicit_activation_dedup_and_budget_are_quiet() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let r = create_responsibility(&conn, USER, input(), 1).unwrap();
    assert!(!r.enabled);
    assert!(r.coordination_paused);
    assert!(ingest(&conn, &session, "interaction").is_empty());
    control_responsibility(
        &conn,
        USER,
        &r.id,
        ResponsibilityControl {
            expected_revision: 1,
            expected_generation: 1,
            action: ResponsibilityAction::Activate,
        },
        2,
    )
    .unwrap();
    assert_eq!(ingest(&conn, &session, "interaction").len(), 1);
    for _ in 0..5 {
        assert!(ingest(&conn, &session, "interaction").is_empty());
    }
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .observations_used,
        1
    );
    assert_eq!(ingest(&conn, &session, "occurrence-2").len(), 1);
    assert_eq!(ingest(&conn, &session, "occurrence-3").len(), 1);
    assert!(ingest(&conn, &session, "over-budget").is_empty());
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .observations_used,
        3
    );
    assert_eq!(list_suggestions(&conn, USER, 100).unwrap().len(), 3);
    assert!(list_suggestions(&conn, USER, 101).is_err());
    assert!(list_tasks(&conn, USER, 0).is_err());
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .dispatches_used,
        0
    );
}
#[test]
fn create_retry_is_stable_and_conflicting_key_is_rejected() {
    let db = Db::memory();
    let conn = db.lock();
    seed(&conn);
    let r = active(&conn);
    assert_eq!(
        create_responsibility(&conn, USER, input(), 10).unwrap().id,
        r.id
    );
    let mut i = input();
    i.purpose = "Different scope of work".into();
    assert_eq!(
        create_responsibility(&conn, USER, i, 11).unwrap_err().code,
        "idempotency_conflict"
    );
    assert_eq!(list_responsibilities(&conn, USER, 100).unwrap().len(), 1);
}
#[test]
fn track_is_atomic_without_session_and_devices_reconcile() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    active(&conn);
    let s = ingest(&conn, &session, "interaction").remove(0);
    let before: i64 = conn
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    let task = accept(&conn, &s, "web-command");
    let same = accept(&conn, &s, "phone-command");
    assert_eq!(same.id, task.id);
    assert_eq!(same.status, TaskStatus::Tracked);
    assert_eq!(same.execution_session_id, None);
    assert_eq!(same.origin_suggestion_id, s.id);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(list_tasks(&conn, USER, 100).unwrap().len(), 1);
    let err = start_task(
        &conn,
        USER,
        &task.id,
        StartInput {
            expected_revision: 1,
            expected_generation: 1,
            command_id: "start".into(),
        },
        10,
    )
    .unwrap_err();
    assert_eq!(err.code, "not_ready");
    assert_eq!(get_task(&conn, USER, &task.id).unwrap().revision, 1);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert!(
        conn.execute(
            "UPDATE pots_tasks SET origin_suggestion_id='forged' WHERE id=?",
            [task.id]
        )
        .is_err()
    );
}
#[test]
fn snooze_dismiss_revision_fences_and_resolution() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    active(&conn);
    let s = ingest(&conn, &session, "one").remove(0);
    let snoozed = control_suggestion(
        &conn,
        USER,
        &s.id,
        SuggestionControl {
            expected_revision: s.revision,
            action: SuggestionAction::Snooze { until: 50 },
        },
        10,
    )
    .unwrap();
    assert_eq!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: s.revision,
                command_id: "stale".into()
            },
            20
        )
        .unwrap_err()
        .code,
        "revision_conflict"
    );
    assert_eq!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: snoozed.revision,
                command_id: "snoozed".into()
            },
            20
        )
        .unwrap_err()
        .code,
        "not_actionable"
    );
    let dismissed = control_suggestion(
        &conn,
        USER,
        &s.id,
        SuggestionControl {
            expected_revision: snoozed.revision,
            action: SuggestionAction::Dismiss,
        },
        20,
    )
    .unwrap();
    assert!(ingest(&conn, &session, "one").is_empty());
    assert_eq!(
        get_suggestion(&conn, USER, &s.id).unwrap().disposition,
        Disposition::Dismissed
    );
    assert!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: dismissed.revision,
                command_id: "dismissed".into()
            },
            60
        )
        .is_err()
    );
    let s2 = ingest(&conn, &session, "two").remove(0);
    let t = accept(&conn, &s2, "track");
    resolve_progress(&conn, USER, &session, 0, "two", 30).unwrap();
    assert_eq!(
        get_suggestion(&conn, USER, &s2.id).unwrap().disposition,
        Disposition::NeedsRefresh
    );
    assert_eq!(
        get_task(&conn, USER, &t.id).unwrap().status,
        TaskStatus::Tracked
    );
    assert!(
        accept_tracking(
            &conn,
            USER,
            &s2.id,
            AcceptInput {
                expected_revision: s2.revision,
                command_id: "late".into()
            },
            40
        )
        .is_err()
    );
    assert!(
        resolve_progress(&conn, USER, &session, 0, "two", 31)
            .unwrap()
            .is_empty()
    );
    resolve_progress(&conn, USER, &session, 0, "one", 32).unwrap();
    assert_eq!(
        get_suggestion(&conn, USER, &s.id).unwrap().disposition,
        Disposition::Superseded
    );
}
#[test]
fn owner_hiding_and_source_revalidation() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let r = active(&conn);
    let s = ingest(&conn, &session, "one").remove(0);
    let t = accept(&conn, &s, "track");
    assert_eq!(
        get_responsibility(&conn, OTHER, &r.id).unwrap_err().status,
        404
    );
    assert_eq!(get_suggestion(&conn, OTHER, &s.id).unwrap_err().status, 404);
    assert_eq!(get_task(&conn, OTHER, &t.id).unwrap_err().status, 404);
    assert_eq!(
        ingest_progress(
            &conn,
            OTHER,
            "node:work",
            &session,
            0,
            "forged",
            i64::MAX,
            4
        )
        .unwrap_err()
        .status,
        404
    );
    assert!(
        ingest_progress(
            &conn,
            USER,
            "node:work",
            &session,
            1,
            "wrong-epoch",
            i64::MAX,
            4
        )
        .is_err()
    );
    conn.execute("UPDATE sessions SET runner_epoch=1 WHERE id=?", [&session])
        .unwrap();
    assert_eq!(get_suggestion(&conn, USER, &s.id).unwrap_err().status, 404);
    assert!(list_suggestions(&conn, USER, 100).unwrap().is_empty());
    assert!(list_tasks(&conn, USER, 100).unwrap().is_empty());
    assert_eq!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: s.revision,
                command_id: "revoked".into()
            },
            4
        )
        .unwrap_err()
        .status,
        404
    );
}
#[test]
fn pause_observation_is_distinct_from_coordination_and_takeover_is_task_scoped() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let r = active(&conn);
    let s = ingest(&conn, &session, "one").remove(0);
    let a = accept(&conn, &s, "one");
    let s = ingest(&conn, &session, "two").remove(0);
    let b = accept(&conn, &s, "two");
    let a = task_control(&conn, &a, TaskAction::TakeOver);
    assert!(a.taken_over);
    assert!(!get_task(&conn, USER, &b.id).unwrap().taken_over);
    assert!(
        control_task(
            &conn,
            USER,
            &a.id,
            TaskControl {
                expected_revision: 1,
                expected_generation: 1,
                action: TaskAction::ResumeCoordination
            },
            10
        )
        .is_err()
    );
    assert!(
        control_task(
            &conn,
            USER,
            &a.id,
            TaskControl {
                expected_revision: a.revision,
                expected_generation: a.control_generation,
                action: TaskAction::ResumeCoordination
            },
            10
        )
        .is_err()
    );
    let r = get_responsibility(&conn, USER, &r.id).unwrap();
    let r = control_responsibility(
        &conn,
        USER,
        &r.id,
        ResponsibilityControl {
            expected_revision: r.revision,
            expected_generation: r.generation,
            action: ResponsibilityAction::PauseObservation,
        },
        10,
    )
    .unwrap();
    assert!(ingest(&conn, &session, "three").is_empty());
    assert!(r.coordination_paused);
    let r = control_responsibility(
        &conn,
        USER,
        &r.id,
        ResponsibilityControl {
            expected_revision: r.revision,
            expected_generation: r.generation,
            action: ResponsibilityAction::ResumeObservation,
        },
        11,
    )
    .unwrap();
    assert_eq!(r.observations_used, 2);
    assert_eq!(ingest(&conn, &session, "three").len(), 1);
    let stopped = task_control(&conn, &b, TaskAction::Stop);
    assert_eq!(stopped.status, TaskStatus::Stopped);
    assert!(stopped.coordination_paused);
}
#[test]
fn reopened_database_preserves_controls_snooze_and_dedup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pots.sqlite");
    let (rid, sid, session, tid) = {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        let session = seed(&conn);
        let r = active(&conn);
        let s = ingest(&conn, &session, "one").remove(0);
        let t = task_control(&conn, &accept(&conn, &s, "track"), TaskAction::TakeOver);
        let s = ingest(&conn, &session, "two").remove(0);
        control_suggestion(
            &conn,
            USER,
            &s.id,
            SuggestionControl {
                expected_revision: s.revision,
                action: SuggestionAction::Snooze { until: 10000 },
            },
            10,
        )
        .unwrap();
        let r = get_responsibility(&conn, USER, &r.id).unwrap();
        control_responsibility(
            &conn,
            USER,
            &r.id,
            ResponsibilityControl {
                expected_revision: r.revision,
                expected_generation: r.generation,
                action: ResponsibilityAction::PauseCoordination,
            },
            11,
        )
        .unwrap();
        (r.id, s.id, session, t.id)
    };
    let db = Db::open(&path).unwrap();
    let conn = db.lock();
    assert!(
        get_responsibility(&conn, USER, &rid)
            .unwrap()
            .coordination_paused
    );
    assert!(get_task(&conn, USER, &tid).unwrap().taken_over);
    assert_eq!(
        get_suggestion(&conn, USER, &sid).unwrap().snoozed_until,
        Some(10000)
    );
    assert!(ingest(&conn, &session, "two").is_empty());
}
#[test]
fn two_connections_racing_acceptance_return_one_task() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("race.sqlite");
    let db = Db::open(&path).unwrap();
    let s = {
        let conn = db.lock();
        let session = seed(&conn);
        active(&conn);
        ingest(&conn, &session, "one").remove(0)
    };
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let db = Db::open(&path).unwrap();
                barrier.wait();
                accept(&db.lock(), &s, &format!("device-{i}")).id
            })
        })
        .collect();
    let ids: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(ids[0], ids[1]);
    assert_eq!(list_tasks(&db.lock(), USER, 100).unwrap().len(), 1);
}
#[test]
fn removed_checking_and_deleted_sources_never_accept() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    active(&conn);
    let s = ingest(&conn, &session, "one").remove(0);
    conn.execute("INSERT INTO workspace_removals(workspace_id,owner_user,removed_at,status) VALUES(?,?,1,'checking')",params!["node:work",USER]).unwrap();
    assert!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: 1,
                command_id: "checking".into()
            },
            4
        )
        .is_err()
    );
    conn.execute("UPDATE workspace_removals SET status='removed'", [])
        .unwrap();
    assert!(list_suggestions(&conn, USER, 100).unwrap().is_empty());
    conn.execute("DELETE FROM workspace_removals", []).unwrap();
    conn.execute("DELETE FROM sessions WHERE id=?", [&session])
        .unwrap();
    assert!(list_suggestions(&conn, USER, 100).unwrap().is_empty());
}

#[test]
fn concurrent_ingest_reserves_last_budget_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget-race.sqlite");
    let db = Db::open(&path).unwrap();
    let (session, rid) = {
        let conn = db.lock();
        let session = seed(&conn);
        let mut i = input();
        i.budgets.observations = 1;
        let r = create_responsibility(&conn, USER, i, 1).unwrap();
        control_responsibility(
            &conn,
            USER,
            &r.id,
            ResponsibilityControl {
                expected_revision: 1,
                expected_generation: 1,
                action: ResponsibilityAction::Activate,
            },
            2,
        )
        .unwrap();
        (session, r.id)
    };
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let barrier = barrier.clone();
            let session = session.clone();
            std::thread::spawn(move || {
                let db = Db::open(&path).unwrap();
                barrier.wait();
                ingest(&db.lock(), &session, &format!("event-{i}")).len()
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum::<usize>(),
        1
    );
    assert_eq!(
        get_responsibility(&db.lock(), USER, &rid)
            .unwrap()
            .observations_used,
        1
    );
}
#[test]
fn concurrent_creates_reconcile_owner_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("create-race.sqlite");
    let db = Db::open(&path).unwrap();
    seed(&db.lock());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let db = Db::open(&path).unwrap();
                barrier.wait();
                create_responsibility(&db.lock(), USER, input(), 1)
                    .unwrap()
                    .id
            })
        })
        .collect();
    let ids: Vec<_> = threads.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(ids[0], ids[1]);
    assert_eq!(
        list_responsibilities(&db.lock(), USER, 100).unwrap().len(),
        1
    );
}
#[test]
fn insert_failure_rolls_back_acceptance_and_budget_reservation() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let r = active(&conn);
    conn.execute_batch("CREATE TRIGGER deny_suggestion BEFORE INSERT ON pots_suggestions BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(ingest_progress(&conn, USER, "node:work", &session, 0, "one", i64::MAX, 3).is_err());
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .observations_used,
        0
    );
    assert!(list_suggestions(&conn, USER, 100).unwrap().is_empty());
    conn.execute_batch("DROP TRIGGER deny_suggestion").unwrap();
    let s = ingest(&conn, &session, "one").remove(0);
    conn.execute_batch("CREATE TRIGGER deny_link BEFORE UPDATE ON pots_suggestions BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: 1,
                command_id: "failed".into()
            },
            4
        )
        .is_err()
    );
    assert!(list_tasks(&conn, USER, 100).unwrap().is_empty());
    assert_eq!(
        get_suggestion(&conn, USER, &s.id).unwrap().disposition,
        Disposition::Pending
    );
    conn.execute_batch("DROP TRIGGER deny_link").unwrap();
    accept(&conn, &s, "retry");
}
#[test]
fn inbox_cap_is_finite_and_consumes_no_extra_quota() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let mut i = input();
    i.budgets.observations = 1000;
    let r = create_responsibility(&conn, USER, i, 1).unwrap();
    control_responsibility(
        &conn,
        USER,
        &r.id,
        ResponsibilityControl {
            expected_revision: 1,
            expected_generation: 1,
            action: ResponsibilityAction::Activate,
        },
        2,
    )
    .unwrap();
    for n in 0..100 {
        assert_eq!(ingest(&conn, &session, &format!("occurrence-{n}")).len(), 1);
    }
    assert!(ingest(&conn, &session, "over-limit").is_empty());
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .observations_used,
        100
    );
    assert_eq!(list_suggestions(&conn, USER, 100).unwrap().len(), 100);
}
#[test]
fn all_action_unit_variants_reject_forged_fields() {
    for ty in [
        "activate",
        "disable",
        "pause_observation",
        "resume_observation",
        "pause_coordination",
        "resume_coordination",
    ] {
        assert!(
            serde_json::from_value::<ResponsibilityAction>(json!({"type":ty,"actor":"pots"}))
                .is_err()
        );
    }
    assert!(
        serde_json::from_value::<SuggestionAction>(json!({"type":"dismiss","actor":"pots"}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<SuggestionAction>(
            json!({"type":"snooze","until":123,"actor":"pots"})
        )
        .is_err()
    );
    for ty in [
        "pause_coordination",
        "resume_coordination",
        "take_over",
        "stop",
    ] {
        assert!(serde_json::from_value::<TaskAction>(json!({"type":ty,"actor":"pots"})).is_err());
    }
}

#[test]
fn reconnect_refreshes_same_occurrence_without_budget_or_disposition_reset() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let r = active(&conn);
    let s = ingest(&conn, &session, "one").remove(0);
    let s = control_suggestion(
        &conn,
        USER,
        &s.id,
        SuggestionControl {
            expected_revision: 1,
            action: SuggestionAction::Dismiss,
        },
        4,
    )
    .unwrap();
    conn.execute("UPDATE sessions SET runner_epoch=1 WHERE id=?", [&session])
        .unwrap();
    let refreshed = ingest_progress(&conn, USER, "node:work", &session, 1, "one", i64::MAX, 5)
        .unwrap()
        .remove(0);
    assert_eq!(refreshed.id, s.id);
    assert_eq!(refreshed.disposition, Disposition::Dismissed);
    assert_eq!(refreshed.evidence.runner_epoch, 1);
    assert!(refreshed.revision > s.revision);
    assert_eq!(
        get_responsibility(&conn, USER, &r.id)
            .unwrap()
            .observations_used,
        1
    );
    assert_eq!(list_suggestions(&conn, USER, 100).unwrap().len(), 1);
    assert!(
        resolve_progress(&conn, USER, &session, 0, "one", 6)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn overlapping_responsibilities_share_one_issue_and_canonical_task() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    let a = active(&conn);
    let mut i = input();
    i.idempotency_key = "second".into();
    let b = create_responsibility(&conn, USER, i, 1).unwrap();
    control_responsibility(
        &conn,
        USER,
        &b.id,
        ResponsibilityControl {
            expected_revision: 1,
            expected_generation: 1,
            action: ResponsibilityAction::Activate,
        },
        2,
    )
    .unwrap();
    let items = ingest(&conn, &session, "same-issue");
    assert_eq!(items.len(), 1);
    let task = accept(&conn, &items[0], "first");
    assert_eq!(accept(&conn, &items[0], "second").id, task.id);
    assert_eq!(list_suggestions(&conn, USER, 100).unwrap().len(), 1);
    assert_eq!(list_tasks(&conn, USER, 100).unwrap().len(), 1);
    assert_eq!(
        get_responsibility(&conn, USER, &a.id)
            .unwrap()
            .observations_used
            + get_responsibility(&conn, USER, &b.id)
                .unwrap()
                .observations_used,
        1
    );
}
#[test]
fn expired_evidence_never_becomes_actionable_even_after_snooze() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    active(&conn);
    assert!(
        ingest_progress(
            &conn,
            USER,
            "node:work",
            &session,
            0,
            "already-expired",
            10,
            10
        )
        .unwrap()
        .is_empty()
    );
    // The operation clock deterministically checks expiry between observation and accept.
    let until = crate::util::now_ms() + 60_000;
    let s = ingest_progress(
        &conn,
        USER,
        "node:work",
        &session,
        0,
        "soon-expires",
        until,
        3,
    )
    .unwrap()
    .remove(0);
    let s = control_suggestion(
        &conn,
        USER,
        &s.id,
        SuggestionControl {
            expected_revision: 1,
            action: SuggestionAction::Snooze {
                until: until + 1000,
            },
        },
        4,
    )
    .unwrap();
    assert_eq!(
        accept_tracking(
            &conn,
            USER,
            &s.id,
            AcceptInput {
                expected_revision: s.revision,
                command_id: "expired".into()
            },
            until + 1001
        )
        .unwrap_err()
        .code,
        "not_actionable"
    );
    // Reads use wall clock, project a durable expiry to a stale disposition, and
    // never manufacture a pending item simply because snooze elapsed.
    let s = ingest_progress(&conn, USER, "node:work", &session, 0, "wall-expired", 2, 1)
        .unwrap()
        .remove(0);
    assert_eq!(
        get_suggestion(&conn, USER, &s.id).unwrap().disposition,
        Disposition::Superseded
    );
}
#[test]
fn runner_lifecycle_invalidation_does_not_complete_task_or_restore_suggestions() {
    let db = Db::memory();
    let conn = db.lock();
    let session = seed(&conn);
    active(&conn);
    let one = ingest(&conn, &session, "one").remove(0);
    let two = ingest(&conn, &session, "two").remove(0);
    let task = accept(&conn, &one, "track");
    assert_eq!(
        invalidate_session_progress(&conn, USER, &session, 5)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        get_suggestion(&conn, USER, &one.id).unwrap().disposition,
        Disposition::NeedsRefresh
    );
    assert_eq!(
        get_suggestion(&conn, USER, &two.id).unwrap().disposition,
        Disposition::Superseded
    );
    assert_eq!(
        get_task(&conn, USER, &task.id).unwrap().status,
        TaskStatus::Tracked
    );
    assert!(ingest(&conn, &session, "one").is_empty());
    assert!(
        invalidate_session_progress(&conn, USER, &session, 6)
            .unwrap()
            .is_empty()
    );
}
