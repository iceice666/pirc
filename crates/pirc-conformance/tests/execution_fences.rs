//! Real Node link/restart proof for the transition admission fence. This is not
//! Gateway/UI acceptance or proof of OS-level revocation / replacement mounts.
use pirc_conformance::{FakeGateway, LoneNode, NODE_ID, NodeOptions, USER};
use serde_json::{Value, json};
async fn register(gateway: &FakeGateway) -> pirc_conformance::NodeLink {
    let mut link = gateway.accept().await;
    link.recv_where(|frame| frame["type"] == "register").await;
    link.send(
        &json!({"type":"registered","nodeId":NODE_ID,"models":{"providers":{}},"mirrors":{}}),
    )
    .await;
    link
}
fn req(method: &str, path: &str, payload: Value) -> Value {
    json!({"method":method,"url":path,"user":USER,"payload":payload})
}
#[tokio::test(flavor = "multi_thread")]
async fn persisted_fence_survives_reboot_without_rebinding_or_erasing_context() {
    let gateway = FakeGateway::bind().await;
    let Some(mut node) = LoneNode::start_with(
        gateway.port(),
        NodeOptions {
            chat_node: true,
            agent_core_only: true,
            env: vec![("PIRC_BROWSER", "false".into())],
        },
    ) else {
        return;
    };
    let mut link = register(&gateway).await;
    let capabilities = link
        .request(
            "capabilities",
            req("GET", "/api/execution-fences/capabilities", Value::Null),
        )
        .await;
    assert_eq!(capabilities["data"]["status"], 200, "{capabilities}");
    assert_eq!(capabilities["data"]["body"]["durableAdmissionFence"], true);
    assert_eq!(capabilities["data"]["body"]["confirmsRevocation"], false);
    assert_eq!(capabilities["data"]["body"]["installsEnvironment"], false);
    let create = link
        .request(
            "session",
            req("POST", "/api/sessions", json!({"workspaceId":"chats"})),
        )
        .await;
    assert_eq!(create["data"]["status"], 201, "{create}");
    let session = create["data"]["body"]["session"]["id"].as_str().unwrap();
    let epoch = create["data"]["body"]["session"]["runnerEpoch"].clone();
    let base = format!("/api/sessions/{session}");
    let before = link
        .request(
            "before",
            req("GET", &format!("{base}/snapshot"), Value::Null),
        )
        .await;
    assert_eq!(before["data"]["status"], 200, "{before}");
    let control = link
        .request(
            "control",
            req(
                "POST",
                &format!("{base}/control/acquire"),
                json!({"clientId":"phone"}),
            ),
        )
        .await;
    assert_eq!(control["data"]["status"], 200, "{control}");
    let generation = control["data"]["body"]["lease"]["generation"].clone();
    assert!(generation.is_number(), "{control}");
    let acceptance = req(
        "POST",
        &format!("{base}/execution-fences"),
        json!({"intent":{"operationId":"move-1","planHash":"a".repeat(64),"expectedWorkspaceId":"chats","expectedRunnerEpoch":epoch},"clientId":"phone","generation":generation}),
    );
    // Once acceptance commits, discard that result. A hard restart must not reopen admission.
    link.send(&json!({"type":"request","requestId":"lost-acceptance","data":acceptance.clone()}))
        .await;
    let accepted = link
        .recv_where(|v| v["type"] == "response" && v["requestId"] == "lost-acceptance")
        .await;
    assert_eq!(accepted["data"]["status"], 200, "{accepted}");
    node.restart(true);
    drop(link);
    let mut link = register(&gateway).await;
    let status_path = format!("{base}/execution-fences/move-1");
    let status = link
        .request("status", req("GET", &status_path, Value::Null))
        .await;
    assert_eq!(
        status["data"]["body"]["transition"]["state"], "fenced",
        "{status}"
    );
    let replay = link.request("duplicate", acceptance).await;
    assert_eq!(replay["data"]["body"], status["data"]["body"]);
    let mut conflicting = req(
        "POST",
        &format!("{base}/execution-fences"),
        json!({"intent":{"operationId":"move-1","planHash":"b".repeat(64),"expectedWorkspaceId":"chats","expectedRunnerEpoch":epoch},"clientId":"phone","generation":generation}),
    );
    let conflict = link.request("changed-plan", conflicting.clone()).await;
    assert_eq!(conflict["data"]["status"], 409, "{conflict}");
    conflicting["user"] = json!("outsider");
    assert_eq!(
        link.request("other-user", conflicting).await["data"]["status"],
        403
    );
    let takeover = link
        .request(
            "takeover-for-stop",
            req(
                "POST",
                &format!("{base}/control/acquire"),
                json!({"clientId":"web","force":true}),
            ),
        )
        .await;
    assert_eq!(takeover["data"]["status"], 200, "{takeover}");
    let command = req(
        "POST",
        &format!("{base}/commands"),
        json!({"commandId":"must-not-send","clientId":"phone","generation":generation,"payload":{"type":"prompt","message":"never execute","uploadIds":[]}}),
    );
    let denied = link.request("denied-command", command).await;
    assert_eq!(denied["data"]["status"], 409, "{denied}");
    assert_eq!(
        denied["data"]["body"]["error"]["code"],
        "environment_transition_pending"
    );
    let drained = link
        .request(
            "drain",
            req("POST", &format!("{status_path}/drain"), json!({})),
        )
        .await;
    assert_eq!(
        drained["data"]["body"]["transition"]["state"], "supervisor_drained",
        "{drained}"
    );
    assert_eq!(
        drained["data"]["body"]["transition"]["revocationConfirmed"],
        false
    );
    assert_eq!(
        drained["data"]["body"]["transition"]["targetInstalled"],
        false
    );
    let after = link
        .request(
            "retained-context",
            req("GET", &format!("{base}/snapshot"), Value::Null),
        )
        .await;
    assert_eq!(after["data"]["status"], 200, "{after}");
    assert_eq!(
        after["data"]["body"]["history"],
        before["data"]["body"]["history"]
    );
    assert_eq!(after["data"]["body"]["session"]["workspaceId"], "chats");
    let deleted = link
        .request("delete", req("DELETE", &base, Value::Null))
        .await;
    assert_eq!(deleted["data"]["status"], 204, "{deleted}");
    assert_eq!(
        link.request("tombstone", req("GET", &status_path, Value::Null))
            .await["data"]["body"]["transition"]["state"],
        "deleted"
    );
}
