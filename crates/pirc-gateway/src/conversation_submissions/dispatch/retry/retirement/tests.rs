use super::*;
use crate::conversation_submissions::{
    acceptance::tests::{identity, register},
    dispatch::retry::tests::{body, input, node, rejected},
    tests::{call, count},
};
use crate::{app::App, db::Db};
use std::sync::Arc;

const OP: &str = "draft-1";
const ID: &str = "unsent-retry";
const PATH: &str = "/api/conversation-submissions/draft-1/retries/unsent-retry";
fn request(first: &Send) -> Retire {
    Retire {
        previous_command_id: first.command.clone(),
        client_id: "phone".into(),
        generation: 1,
    }
}
fn json_request(first: &Send) -> Value {
    json!({"previousCommandId":first.command,"clientId":"phone","generation":1})
}
fn reopen(app: &AppState) -> AppState {
    let other = App::new(
        app.config.clone(),
        Arc::new(Db::open(&app.config.state_dir.join("gateway.sqlite")).unwrap()),
        app.backends.clone(),
        crate::app::test_modes(),
    );
    register(&other);
    other
}
fn assert_fenced(value: &Value, first: &Send) {
    assert_eq!(
        value["retry"],
        json!({"retryId":ID,"previousCommandId":first.command,"status":"not_reserved","retired":true})
    );
    assert_eq!(value["preparation"]["sessionId"], first.session);
}

#[tokio::test]
async fn absent_nonce_is_permanently_fenced_without_a_command_or_node_request() {
    let (app, _dir, first) = rejected(true).await;
    let calls = node(&app, &first, false, true, true);
    let (code, value) = call(
        &app,
        "POST",
        &format!("{PATH}/retire"),
        Some("alice"),
        None,
        Some(json_request(&first)),
    )
    .await;
    assert_eq!(code, 200, "{value}");
    assert_fenced(&value, &first);
    assert!(calls.lock().unwrap().is_empty());
    let restored = reopen(&app);
    restored
        .db
        .lock()
        .execute("DELETE FROM leases", [])
        .unwrap();
    for method in ["GET", "POST"] {
        let path = if method == "POST" {
            format!("{PATH}/retire")
        } else {
            PATH.into()
        };
        let (code, value) = call(
            &restored,
            method,
            &path,
            Some("alice"),
            None,
            (method == "POST").then(|| json_request(&first)),
        )
        .await;
        assert_eq!(code, 200, "{value}");
        assert_fenced(&value, &first);
    }
    let (code, value) = call(
        &restored,
        "POST",
        "/api/conversation-submissions/draft-1/retry",
        Some("alice"),
        None,
        Some(body(&input(&first, ID))),
    )
    .await;
    assert_eq!(code, 409, "{value}");
    assert_eq!(value["error"]["code"], "retry_retired");
    assert_eq!(count(&restored.db.lock(), "commands"), 1);
    assert_eq!(count(&restored.db.lock(), "sessions"), 1);
    assert_eq!(
        count(
            &restored.db.lock(),
            "conversation_submission_retry_attempts"
        ),
        0
    );
    assert_eq!(
        count(
            &restored.db.lock(),
            "conversation_submission_retry_retirements"
        ),
        1
    );
}

#[tokio::test]
async fn only_a_new_explicit_nonce_can_retry_the_unchanged_original_after_retirement() {
    let (app, _dir, first) = rejected(false).await;
    fence(&app, &identity(), OP, ID, &request(&first)).unwrap();
    let next = reserve(&app, &identity(), OP, &input(&first, "explicit-next"))
        .unwrap()
        .unwrap();
    assert_eq!(next.session, first.session);
    assert_eq!(next.hash, first.hash);
    assert_eq!(next.payload, first.payload);
    assert_eq!(next.request["uploadIds"], first.request["uploadIds"]);
    assert_eq!(
        current_number(&app.db.lock(), "alice", OP, &next.command).unwrap(),
        1
    );
    assert_fenced(
        &receipt(&app.db.lock(), "alice", OP, ID).unwrap().unwrap(),
        &first,
    );
    assert_eq!(
        reserve(&app, &identity(), OP, &input(&first, ID))
            .err()
            .unwrap()
            .code,
        "retry_retired"
    );
}

#[tokio::test]
async fn reserved_but_unreceived_command_is_queried_and_never_retired_or_replayed() {
    let (app, _dir, first) = rejected(false).await;
    let next = reserve(&app, &identity(), OP, &input(&first, ID))
        .unwrap()
        .unwrap();
    let calls = node(&app, &first, false, false, true);
    app.db.lock().execute("DELETE FROM leases", []).unwrap();
    let (code, value) = call(
        &app,
        "POST",
        &format!("{PATH}/retire"),
        Some("alice"),
        None,
        Some(json_request(&first)),
    )
    .await;
    assert_eq!(code, 200, "{value}");
    assert_eq!(value["retry"]["commandId"], next.command);
    assert_eq!(value["retry"]["status"], "outcome_unknown");
    assert_ne!(value["retry"]["retired"], true);
    assert!(
        calls
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| *method == HttpMethod::Get)
    );
    assert_eq!(
        count(&app.db.lock(), "conversation_submission_retry_retirements"),
        0
    );
    assert_eq!(count(&app.db.lock(), "commands"), 2);
}

#[tokio::test]
async fn different_predecessors_cannot_reuse_either_kind_of_nonce() {
    for retired in [false, true] {
        let (app, _dir, first) = rejected(false).await;
        if retired {
            fence(&app, &identity(), OP, ID, &request(&first)).unwrap();
        } else {
            reserve(&app, &identity(), OP, &input(&first, ID)).unwrap();
        }
        let mut changed = request(&first);
        changed.previous_command_id = "different-command".into();
        assert_eq!(
            fence(&app, &identity(), OP, ID, &changed).unwrap_err().code,
            "retry_identity_conflict"
        );
        let mut retry = input(&first, ID);
        retry.previous_command_id = changed.previous_command_id;
        assert_eq!(
            reserve(&app, &identity(), OP, &retry).err().unwrap().code,
            "retry_identity_conflict"
        );
    }
}

#[tokio::test]
async fn new_fence_requires_owner_live_device_held_lease_and_known_rejection_without_stop() {
    for change in [
        "owner",
        "device",
        "lease",
        "generation",
        "lease-owner",
        "stop",
        "unknown",
        "accepted",
        "predecessor",
        "deleted",
    ] {
        let (app, _dir, first) = rejected(false).await;
        let mut who = identity();
        let mut req = request(&first);
        match change {
            "owner" => who.user = "bob".into(),
            "device" => who.device_id = Some("revoked".into()),
            "lease" => {
                app.db.lock().execute("DELETE FROM leases", []).unwrap();
            }
            "generation" => req.generation = 2,
            "lease-owner" => {
                app.db
                    .lock()
                    .execute("UPDATE leases SET owner_user='bob'", [])
                    .unwrap();
            }
            "stop" => {
                note_stop(&app.db.lock(), &first.session, "alice").unwrap();
            }
            "unknown" => {
                app.db.lock().execute("UPDATE conversation_submission_dispatches SET state='outcome_unknown',outcome='outcome_unknown'",[]).unwrap();
            }
            "accepted" => {
                app.db.lock().execute("UPDATE conversation_submission_dispatches SET state='accepted',outcome='admitted',admitted_at=1",[]).unwrap();
            }
            "predecessor" => req.previous_command_id = "different".into(),
            "deleted" => {
                app.db
                    .lock()
                    .begin_session_deletion(&first.session, "alice")
                    .unwrap();
                app.db
                    .lock()
                    .finish_session_deletion(&first.session)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(fence(&app, &who, OP, ID, &req).is_err(), "{change}");
        assert_eq!(
            count(&app.db.lock(), "conversation_submission_retry_retirements"),
            0,
            "{change}"
        );
    }
}

#[tokio::test]
async fn revocation_only_fence_does_not_depend_on_model_and_survives_stop_and_deletion() {
    let (app, _dir, first) = rejected(false).await;
    app.backends
        .set_baseline(serde_json::from_value(json!({"providers":{}})).unwrap());
    fence(&app, &identity(), OP, ID, &request(&first)).unwrap();
    note_stop(&app.db.lock(), &first.session, "alice").unwrap();
    app.db
        .lock()
        .begin_session_deletion(&first.session, "alice")
        .unwrap();
    app.db
        .lock()
        .finish_session_deletion(&first.session)
        .unwrap();
    fence(&app, &identity(), OP, ID, &request(&first)).unwrap();
    let value = receipt(&app.db.lock(), "alice", OP, ID).unwrap().unwrap();
    assert_fenced(&value, &first);
    assert_eq!(value["preparation"]["state"], "cancelled");
    assert!(receipt(&app.db.lock(), "bob", OP, ID).is_err());
}

#[tokio::test]
async fn independent_connections_serialize_retirement_against_reservation() {
    for _ in 0..8 {
        let (app, _dir, first) = rejected(true).await;
        let other = reopen(&app);
        let barrier = std::sync::Barrier::new(2);
        let (reserved, retired) = std::thread::scope(|scope| {
            let reserve = scope.spawn(|| {
                barrier.wait();
                reserve(&app, &identity(), OP, &input(&first, ID))
            });
            let retire = scope.spawn(|| {
                barrier.wait();
                fence(&other, &identity(), OP, ID, &request(&first))
            });
            (reserve.join().unwrap(), retire.join().unwrap())
        });
        retired.unwrap();
        let db = app.db.lock();
        let fences = count(&db, "conversation_submission_retry_retirements");
        let reservations = count(&db, "conversation_submission_retry_attempts");
        assert_eq!(fences + reservations, 1);
        assert_eq!(count(&db, "commands"), 1 + reservations);
        if fences == 1 {
            assert_eq!(reserved.err().unwrap().code, "retry_retired");
        } else {
            assert!(reserved.unwrap().is_some());
        }
    }
}

#[tokio::test]
async fn schema_1019_migration_preserves_original_input_and_reserved_retry() {
    let (app, _dir, first) = rejected(true).await;
    let next = reserve(&app, &identity(), OP, &input(&first, "existing"))
        .unwrap()
        .unwrap();
    let before = serde_json::to_value(lookup(&app.db.lock(), "alice", OP).unwrap()).unwrap();
    app.db
        .lock()
        .execute_batch(
            concat!(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/conversation_bindings/test_remove_policies.sql")), "DROP TABLE conversation_submission_retry_retirements; DROP TRIGGER IF EXISTS conversation_binding_insert; DROP TRIGGER IF EXISTS conversation_binding_mapping; DROP TRIGGER IF EXISTS conversation_binding_mode; DROP TABLE IF EXISTS conversation_bindings; PRAGMA user_version=1019;"),
        )
        .unwrap();
    let db = Db::open(&app.config.state_dir.join("gateway.sqlite")).unwrap();
    let conn = db.lock();
    assert_eq!(
        serde_json::to_value(lookup(&conn, "alice", OP).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        current_number(&conn, "alice", OP, &next.command).unwrap(),
        1
    );
    assert_eq!(conn.get_command(&first.command).unwrap().status, "rejected");
    assert_eq!(count(&conn, "commands"), 2);
    assert_eq!(count(&conn, "conversation_submission_retry_retirements"), 0);
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
}
