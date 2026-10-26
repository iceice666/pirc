//! Exercise command locking and persisted outcomes through the real manager.
//! The fake process answers RPC lines; no sandbox or external provider runs.
use super::super::{CommandPayload, InitialSettings};
use super::*;
use crate::store::{CommandStatus, Store};
use crate::workspace_memory::tests::Fixture;

fn register(f: &Fixture) -> (Arc<Runner>, mpsc::UnboundedReceiver<Outbound>) {
    let row = f.node.db.lock().get_session(&f.current).unwrap();
    let (stdin, lines) = mpsc::unbounded_channel();
    let runner = Arc::new(Runner {
        node: Arc::downgrade(&f.node),
        session_id: row.id.clone(),
        workspace: f.node.db.lock().get_workspace(&row.workspace_id).unwrap(),
        mode: f.mode.clone(),
        epoch: row.runner_epoch,
        pid: None,
        prepared: Prepared::new(
            PathBuf::new(),
            vec![],
            vec![],
            Default::default(),
            vec![],
            None,
            || {},
        ),
        persistence: None,
        stdin,
        inner: Mutex::default(),
        view: Mutex::default(),
        reaped: AtomicBool::new(true),
        exited: watch::channel(false).0,
    });
    f.node.runners.lock().runners.insert(row.id, runner.clone());
    (runner, lines)
}
fn receive(f: &Fixture, id: &str, payload: &CommandPayload) {
    let json = serde_json::to_value(payload).unwrap();
    f.node
        .db
        .lock()
        .receive_command(id, &f.current, &crate::util::payload_hash(&json), &json)
        .unwrap();
}
async fn next(lines: &mut mpsc::UnboundedReceiver<Outbound>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(2), lines.recv())
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&line.line).unwrap()
}
fn answer(runner: &Arc<Runner>, request: &Value, body: Value) {
    let mut reply = body;
    reply["type"] = json!("response");
    reply["id"] = request["id"].clone();
    runner.handle_value(reply).unwrap();
}

#[tokio::test]
async fn stop_overtakes_pending_admission_and_unknown_receipt_stays_deduplicated() {
    let f = Fixture::new().await;
    let (runner, mut lines) = register(&f);
    let lease = f
        .node
        .db
        .lock()
        .acquire_lease(&f.current, "phone", false, 60_000)
        .unwrap();
    let payload = CommandPayload::Prompt {
        message: "first".into(),
        upload_ids: None,
    };
    receive(&f, "first-send", &payload);
    let send = {
        let node = f.node.clone();
        let session = f.current.clone();
        let payload = payload.clone();
        tokio::spawn(async move {
            node.runners
                .dispatch(
                    &session,
                    "first-send",
                    &payload,
                    "alice",
                    ("phone", lease.generation),
                )
                .await
        })
    };
    let prompt = next(&mut lines).await;
    assert_eq!(prompt["type"], "prompt");
    assert!(!send.is_finished());
    assert_eq!(
        f.node.db.lock().get_command("first-send").unwrap().status,
        CommandStatus::Dispatched
    );
    let settings = CommandPayload::SetThinking {
        level: "low".into(),
    };
    receive(&f, "settings", &settings);
    let change = {
        let node = f.node.clone();
        let session = f.current.clone();
        tokio::spawn(async move {
            node.runners
                .dispatch(
                    &session,
                    "settings",
                    &settings,
                    "alice",
                    ("phone", lease.generation),
                )
                .await
        })
    };
    receive(&f, "stop", &CommandPayload::Stop);
    let stop = {
        let node = f.node.clone();
        let session = f.current.clone();
        tokio::spawn(async move {
            node.runners
                .dispatch(
                    &session,
                    "stop",
                    &CommandPayload::Stop,
                    "alice",
                    ("phone", lease.generation),
                )
                .await
        })
    };
    let clear = next(&mut lines).await;
    assert_eq!(clear["type"], "clear_queue");
    answer(&runner, &clear, json!({"success":true}));
    let abort = next(&mut lines).await;
    assert_eq!(abort["type"], "abort");
    answer(&runner, &abort, json!({"success":true}));
    stop.await.unwrap().unwrap();
    assert!(!send.is_finished());
    answer(
        &runner,
        &prompt,
        json!({"success":false,"errorCode":"admission_outcome_unknown","error":"inspect before retrying"}),
    );
    send.await.unwrap().unwrap();
    let settings = next(&mut lines).await;
    assert_eq!(settings["type"], "set_thinking_level");
    answer(&runner, &settings, json!({"success":true}));
    change.await.unwrap().unwrap();
    let json = serde_json::to_value(&payload).unwrap();
    let (row, duplicate) = f
        .node
        .db
        .lock()
        .receive_command(
            "first-send",
            &f.current,
            &crate::util::payload_hash(&json),
            &json,
        )
        .unwrap();
    assert!(duplicate);
    assert_eq!(row.status, CommandStatus::OutcomeUnknown);
    assert!(lines.try_recv().is_err());
    assert_eq!(
        f.node.db.lock().get_command("stop").unwrap().status,
        CommandStatus::Accepted
    );
    runner.exit(Some(0), None);
    f.node.close().await;
}

#[tokio::test]
async fn dropping_an_admission_answer_is_unknown_even_with_a_live_runner() {
    let f = Fixture::new().await;
    let (runner, mut lines) = register(&f);
    let lease = f
        .node
        .db
        .lock()
        .acquire_lease(&f.current, "phone", false, 60_000)
        .unwrap();
    let payload = CommandPayload::Prompt {
        message: "first".into(),
        upload_ids: None,
    };
    receive(&f, "first-send", &payload);
    let send = {
        let node = f.node.clone();
        let session = f.current.clone();
        tokio::spawn(async move {
            node.runners
                .dispatch(
                    &session,
                    "first-send",
                    &payload,
                    "alice",
                    ("phone", lease.generation),
                )
                .await
        })
    };
    let prompt = next(&mut lines).await;
    runner.lock().pending.remove(prompt["id"].as_str().unwrap());
    assert!(runner.alive());
    send.await.unwrap().unwrap();
    assert_eq!(
        f.node.db.lock().get_command("first-send").unwrap().status,
        CommandStatus::OutcomeUnknown
    );
    runner.exit(Some(0), None);
    f.node.close().await;
}

fn initial(f: &Fixture) -> (CommandPayload, InitialSettings, i64) {
    let payload = CommandPayload::Prompt {
        message: "immutable first text".into(),
        upload_ids: Some(vec![]),
    };
    receive(f, "initial-send", &payload);
    let db = f.node.db.lock();
    db.execute("INSERT INTO session_creations(owner_user,operation_id,workspace_id,submission_hash,session_id,state,created_at) VALUES('alice','creation-1','repo',?1,?2,'ready',1)",rusqlite::params!["a".repeat(64),f.current]).unwrap();
    db.execute("INSERT INTO creation_initial_admissions(owner_user,operation_id,session_id,command_id,input_hash,created_at,updated_at) VALUES('alice','creation-1',?1,'initial-send','hash',1,1)",[&f.current]).unwrap();
    let lease = db
        .acquire_lease(&f.current, "phone", false, 60_000)
        .unwrap();
    (
        payload,
        InitialSettings {
            provider: "fake".into(),
            model_id: "frozen-model".into(),
            thinking: pirc_protocol::ThinkingLevel::Low,
        },
        lease.generation,
    )
}
#[tokio::test]
async fn initial_settings_and_message_share_one_serialized_admission() {
    let f = Fixture::new().await;
    let (runner, mut lines) = register(&f);
    let (payload, settings, generation) = initial(&f);
    let node = f.node.clone();
    let session = f.current.clone();
    let send = tokio::spawn(async move {
        node.runners
            .dispatch_initial(
                &session,
                "initial-send",
                &payload,
                "alice",
                ("phone", generation),
                &settings,
            )
            .await
    });
    let model = next(&mut lines).await;
    assert_eq!(model["type"], "set_model");
    assert_eq!(model["modelId"], "frozen-model");
    assert!(lines.try_recv().is_err());
    answer(&runner, &model, json!({"success":true}));
    let thinking = next(&mut lines).await;
    assert_eq!(thinking["type"], "set_thinking_level");
    assert_eq!(thinking["level"], "low");
    answer(&runner, &thinking, json!({"success":true}));
    let prompt = next(&mut lines).await;
    assert_eq!(prompt["type"], "prompt");
    assert_eq!(prompt["message"], "immutable first text");
    answer(&runner, &prompt, json!({"success":true}));
    send.await.unwrap().unwrap();
    assert_eq!(
        f.node.db.lock().get_command("initial-send").unwrap().status,
        CommandStatus::Accepted
    );
    assert!(
        crate::session_creation::admission::require_generic(&f.node.db.lock(), &f.current).is_ok()
    );
    assert!(lines.try_recv().is_err());
    runner.exit(Some(0), None);
    f.node.close().await;
}
#[tokio::test]
async fn stop_during_initial_configuration_permanently_prevents_the_prompt_from_being_queued() {
    let f = Fixture::new().await;
    let (runner, mut lines) = register(&f);
    let (payload, settings, generation) = initial(&f);
    let node = f.node.clone();
    let session = f.current.clone();
    let send = tokio::spawn(async move {
        node.runners
            .dispatch_initial(
                &session,
                "initial-send",
                &payload,
                "alice",
                ("phone", generation),
                &settings,
            )
            .await
    });
    let model = next(&mut lines).await;
    assert_eq!(model["type"], "set_model");
    crate::session_creation::admission::request_stop(&f.node.db.lock(), &f.current, "alice")
        .unwrap();
    answer(&runner, &model, json!({"success":true}));
    assert!(send.await.unwrap().is_err());
    assert_eq!(
        f.node.db.lock().get_command("initial-send").unwrap().status,
        CommandStatus::Rejected
    );
    assert!(lines.try_recv().is_err());
    assert!(
        crate::session_creation::admission::require_sendable(
            &f.node.db.lock(),
            &f.current,
            "initial-send",
            "alice"
        )
        .is_err()
    );
    runner.exit(Some(0), None);
    f.node.close().await;
}
