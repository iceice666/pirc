use super::*;
use crate::store::Db;

fn request(op: PotsOperation) -> PotsRequest {
    PotsRequest {
        user: "test-user".into(),
        dispatch_id: "dispatch".into(),
        binding_id: "task".into(),
        generation: 1,
        operation: op,
    }
}

async fn node() -> (tempfile::TempDir, Node) {
    use pirc_config::{Env, NodeConfig};
    use pirc_protocol::{ModeId, NodeRole, mode::default_work};
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let root = dir.path();
    let state = root.join("state").to_string_lossy().into_owned();
    let config = root.join("config").to_string_lossy().into_owned();
    let env = Env::new(
        [
            ("PIRC_NODE_ID", "test-node"),
            ("PIRC_NODE_TOKEN", "0123456789abcdef0123456789abcdef"),
            ("PIRC_DAEMON_URL", "ws://127.0.0.1:8787"),
            ("PIRC_ALLOWED_USERS", "test-user"),
            ("PIRC_STATE_DIR", state.as_str()),
            ("PIRC_CONFIG_DIR", config.as_str()),
            ("PIRC_BROWSER", "false"),
            ("HOME", root.to_str().unwrap()),
        ],
        root,
    );
    let config = NodeConfig::load(&env, NodeRole::Node).unwrap();
    let node = crate::services::Services::start(config, env).await.unwrap();
    node.replace_modes(vec![default_work()]).await;
    let workspace = root.join("repo");
    std::fs::create_dir(&workspace).unwrap();
    node.db
        .lock()
        .add_workspace(
            "workspace",
            "test-node",
            "Repo",
            workspace.to_str().unwrap(),
            ModeId::new("directory").unwrap(),
        )
        .unwrap();
    (dir, node)
}

fn prepare_request() -> PotsRequest {
    request(PotsOperation::Prepare {
        workspace_id: "workspace".into(),
        content: "Explicit instruction only".into(),
        expires_at: i64::MAX,
    })
}

#[tokio::test]
async fn prepare_is_deterministic_immutable_and_does_not_execute() {
    let (_dir, node) = node().await;
    let request = prepare_request();
    let first = execute(&node, &request).await.unwrap();
    assert_eq!(first["state"], "prepared");
    assert_eq!(first["sessionId"], identity(&request));
    assert_eq!(execute(&node, &request).await.unwrap(), first);
    assert!(node.runners.get(&identity(&request)).is_none());
    let mut changed = request.clone();
    changed.operation = PotsOperation::Prepare {
        workspace_id: "workspace".into(),
        content: "changed".into(),
        expires_at: i64::MAX,
    };
    assert_eq!(execute(&node, &changed).await.unwrap_err().status, 409);
    changed = request.clone();
    changed.binding_id = "other".into();
    assert_eq!(execute(&node, &changed).await.unwrap_err().status, 409);
    changed = request.clone();
    changed.generation += 1;
    assert_eq!(execute(&node, &changed).await.unwrap_err().status, 409);
    {
        let db = node.db.lock();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    node.close().await;
}

#[tokio::test]
async fn takeover_before_prepare_and_before_send_never_delivers() {
    let (_dir, node) = node().await;
    let cancel = request(PotsOperation::Control {
        action: PotsControl::TakeOver,
    });
    assert_eq!(execute(&node, &cancel).await.unwrap()["state"], "cancelled");
    let result = execute(&node, &prepare_request()).await.unwrap();
    assert_eq!(result, json!({"sessionId":null,"state":"cancelled"}));
    assert_eq!(
        execute(&node, &request(PotsOperation::Start))
            .await
            .unwrap(),
        result
    );
    assert!(
        claim_send(&node.db.lock(), &request(PotsOperation::Start))
            .unwrap()
            .is_none()
    );
    assert!(node.runners.get(&identity(&cancel)).is_none());

    let mut prepared = prepare_request();
    prepared.dispatch_id = "prepared".into();
    execute(&node, &prepared).await.unwrap();
    let mut cancel = prepared.clone();
    cancel.generation = 2;
    cancel.operation = PotsOperation::Control {
        action: PotsControl::TakeOver,
    };
    assert_eq!(execute(&node, &cancel).await.unwrap()["state"], "cancelled");
    assert!(claim_send(&node.db.lock(), &prepared).unwrap().is_none());
    node.close().await;
}

#[tokio::test]
async fn stop_only_ledger_owned_session_and_generation_checked() {
    let (_dir, node) = node().await;
    execute(&node, &prepare_request()).await.unwrap();
    let mut control = request(PotsOperation::Control {
        action: PotsControl::Stop,
    });
    control.binding_id = "forged".into();
    assert_eq!(execute(&node, &control).await.unwrap_err().status, 409);
    control.binding_id = "task".into();
    control.generation = 2;
    assert_eq!(execute(&node, &control).await.unwrap()["state"], "stopped");
    control.generation = 1;
    assert_eq!(execute(&node, &control).await.unwrap()["state"], "stopped");
    assert_eq!(
        execute(&node, &request(PotsOperation::Status))
            .await
            .unwrap()["state"],
        "stopped"
    );
    assert_eq!(
        execute(&node, &request(PotsOperation::Start))
            .await
            .unwrap()["state"],
        "stopped"
    );
    node.close().await;
}

#[test]
fn durable_sending_claim_is_not_replayed_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("node.sqlite");
    let request = request(PotsOperation::Start);
    {
        let db = Db::open(&path).unwrap();
        db.lock().execute("INSERT INTO pots_dispatches(owner,dispatch_id,binding_id,generation,workspace_id,content,session_id,state,expires_at) VALUES(?1,?2,?3,1,'workspace','instruction',?4,'prepared',9223372036854775807)",
            params![request.user, request.dispatch_id, request.binding_id, identity(&request)]).unwrap();
        assert!(claim_send(&db.lock(), &request).unwrap().is_some());
    }
    let db = Db::open(&path).unwrap();
    let dispatch = require(&db.lock(), &request).unwrap();
    assert_eq!(dispatch.status()["state"], "uncertain");
    assert_eq!(
        start_status(&dispatch).unwrap_err().code,
        "dispatch_uncertain"
    );
    assert!(claim_send(&db.lock(), &request).unwrap().is_none());
    let mut control = request.clone();
    control.generation = 2;
    fence(&db.lock(), &control).unwrap();
    assert!(claim_send(&db.lock(), &request).unwrap().is_none());
}

#[test]
fn takeover_does_not_claim_already_delivered_execution_was_stopped() {
    let db = Db::memory();
    let request = request(PotsOperation::Start);
    db.lock().execute("INSERT INTO pots_dispatches(owner,dispatch_id,binding_id,generation,state) VALUES(?1,?2,?3,1,'delivered')",
        params![request.user, request.dispatch_id, request.binding_id]).unwrap();
    let mut control = request.clone();
    control.generation = 2;
    assert_eq!(
        fence(&db.lock(), &control).unwrap().status()["state"],
        "delivered"
    );
    assert!(claim_send(&db.lock(), &request).unwrap().is_none());
    control.generation = 1;
    assert!(fence(&db.lock(), &control).is_err());
    control.binding_id = "other".into();
    control.generation = 3;
    assert!(fence(&db.lock(), &control).is_err());
}

#[test]
fn instruction_limits_are_utf8_bytes_and_owner_scoped() {
    let mut request = prepare_request();
    if let PotsOperation::Prepare { content, .. } = &mut request.operation {
        *content = "é".repeat(10_001);
    }
    assert!(validate(&request).is_err());
    let first = identity(&request);
    request.user = "another-user".into();
    assert_ne!(first, identity(&request));
}

#[tokio::test]
async fn prepared_session_rejects_ordinary_prompt_and_delivery_and_expiry_cancels() {
    let (_dir, node) = node().await;
    let prepared = prepare_request();
    execute(&node, &prepared).await.unwrap();
    let id = identity(&prepared);
    assert_eq!(
        require_generic_input(&node.db.lock(), &id)
            .unwrap_err()
            .code,
        "pots_dispatch_reserved"
    );
    let lease = node
        .db
        .lock()
        .acquire_lease(&id, "browser", false, 60_000)
        .unwrap();
    let response = node.router.handle(&node, pirc_protocol::NodeHttpRequest {
        method: pirc_protocol::HttpMethod::Post, url: format!("/api/sessions/{id}/commands"), user: prepared.user.clone(),
        payload: Some(json!({"commandId":"forged-prompt","clientId":"browser","generation":lease.generation,"payload":{"type":"prompt","message":"competing user run"}})),
        body_base64: None, content_type: None,
    }).await;
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body.unwrap()["error"]["code"],
        "pots_dispatch_reserved"
    );
    let response = node
        .router
        .handle(
            &node,
            pirc_protocol::NodeHttpRequest {
                method: pirc_protocol::HttpMethod::Post,
                url: format!("/api/sessions/{id}/deliver"),
                user: prepared.user.clone(),
                payload: Some(
                    json!({"customType":"scheduled-run","content":"competing scheduled run"}),
                ),
                body_base64: None,
                content_type: None,
            },
        )
        .await;
    assert_eq!(response.status, 409);
    assert!(node.runners.get(&id).is_none());
    node.db
        .lock()
        .execute(
            "UPDATE pots_dispatches SET expires_at=1 WHERE session_id=?1",
            [&id],
        )
        .unwrap();
    assert!(claim_send(&node.db.lock(), &prepared).unwrap().is_none());
    assert_eq!(
        require(&node.db.lock(), &prepared).unwrap().status()["state"],
        "cancelled"
    );
    assert!(require_generic_input(&node.db.lock(), &id).is_ok());
    assert!(claim_send(&node.db.lock(), &prepared).unwrap().is_none());
    node.close().await;
}

#[tokio::test]
async fn deleted_execution_keeps_stopped_tombstone_and_can_be_cancelled() {
    let (_dir, node) = node().await;
    let prepared = prepare_request();
    execute(&node, &prepared).await.unwrap();
    let id = identity(&prepared);
    node.db
        .lock()
        .execute(
            "UPDATE pots_dispatches SET state='delivered' WHERE session_id=?1",
            [&id],
        )
        .unwrap();
    node.db
        .lock()
        .begin_session_deletion(&id, &prepared.user)
        .unwrap();
    node.db.lock().finish_session_deletion(&id).unwrap();
    let status = execute(&node, &request(PotsOperation::Status))
        .await
        .unwrap();
    assert_eq!(status["state"], "stopped");
    assert_eq!(
        execute(
            &node,
            &request(PotsOperation::Control {
                action: PotsControl::Stop
            })
        )
        .await
        .unwrap(),
        status
    );
    assert_eq!(execute(&node, &prepared).await.unwrap(), status);
    assert!(claim_send(&node.db.lock(), &prepared).unwrap().is_none());
    node.close().await;
}
