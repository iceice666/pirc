//! Admission binds browser/device intent to the configured environment. This
//! does not prove active sandbox revocation after a command has been admitted.
use pirc_conformance::{CHATS_WORKSPACE_ID, Cluster, GatewayOptions, HOST, browser_headers};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn browser_and_paired_device_keep_intent_across_policy_changes() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        chat_node: true,
        agent_core_only: true,
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let api = cluster.api();
    let web = browser_headers();
    let created = api
        .send(
            "POST",
            "/api/sessions",
            &web,
            Some(json!({"workspaceId":CHATS_WORKSPACE_ID})),
        )
        .await;
    assert_eq!(created.status, 201, "{}", created.body);
    let id = created.body["session"]["id"].as_str().unwrap();
    let base = format!("/api/sessions/{id}");
    let binding = created.body["session"]["binding"].clone();
    assert_eq!(binding["execution"]["generation"], 1);
    let lease = api
        .send(
            "POST",
            &format!("{base}/control/acquire"),
            &web,
            Some(json!({"clientId":"web"})),
        )
        .await;
    assert_eq!(lease.status, 200, "{}", lease.body);
    let mut request = json!({"commandId":"original", "clientId":"web", "generation":lease.body["lease"]["generation"], "expectedBinding":binding, "payload":{"type":"set_thinking","level":"high"}});
    let accepted = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &web,
            Some(request.clone()),
        )
        .await;
    assert_eq!(accepted.status, 202, "{}", accepted.body);
    assert_eq!(accepted.body["command"]["status"], "accepted");
    let changed = api
        .send(
            "PATCH",
            &format!("/api/workspaces/{CHATS_WORKSPACE_ID}/capabilities"),
            &web,
            Some(json!({"capabilities":{"web_search":false}})),
        )
        .await;
    assert_eq!(changed.status, 200, "{}", changed.body);
    let environment = api
        .send("GET", &format!("{base}/environment"), &web, None)
        .await;
    let fresh = environment.body["binding"].clone();
    assert_eq!(fresh["execution"]["generation"], 2);
    assert_eq!(environment.body["enforcement"], "not_tracked");
    let duplicate = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &web,
            Some(request.clone()),
        )
        .await;
    assert_eq!(duplicate.status, 200, "{}", duplicate.body);
    assert_eq!(duplicate.body["duplicate"], true);
    request["commandId"] = json!("stale");
    let stale = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &web,
            Some(request.clone()),
        )
        .await;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.body["error"]["code"], "stale_environment");
    assert_eq!(
        api.send("GET", &format!("{base}/commands/stale"), &web, None)
            .await
            .status,
        404
    );
    request.as_object_mut().unwrap().remove("expectedBinding");
    let legacy = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &web,
            Some(request.clone()),
        )
        .await;
    assert_eq!(legacy.body["error"]["code"], "environment_required");
    request["commandId"] = json!("stop");
    request["payload"] = json!({"type":"stop"});
    assert_eq!(
        api.send(
            "POST",
            &format!("{base}/commands"),
            &web,
            Some(request.clone())
        )
        .await
        .status,
        202
    );

    let pair = api
        .send(
            "POST",
            "/api/devices",
            &web,
            Some(json!({"name":"environment-check"})),
        )
        .await;
    let phone = vec![
        ("host", HOST.into()),
        (
            "authorization",
            format!("Bearer {}", pair.body["token"].as_str().unwrap()),
        ),
    ];
    let lease = api
        .send(
            "POST",
            &format!("{base}/control/acquire"),
            &phone,
            Some(json!({"clientId":"phone", "force":true})),
        )
        .await;
    assert_eq!(lease.status, 200, "{}", lease.body);
    request = json!({"commandId":"phone-stale", "clientId":"phone", "generation":lease.body["lease"]["generation"], "expectedBinding":binding, "payload":{"type":"set_thinking","level":"low"}});
    let stale = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &phone,
            Some(request.clone()),
        )
        .await;
    assert_eq!(stale.body["error"]["code"], "stale_environment");
    let phone_view = api
        .send("GET", &format!("{base}/environment"), &phone, None)
        .await;
    assert_eq!(phone_view.body["binding"], fresh);
    request["commandId"] = json!("phone-fresh");
    request["expectedBinding"] = fresh;
    let accepted = api
        .send(
            "POST",
            &format!("{base}/commands"),
            &phone,
            Some(request.clone()),
        )
        .await;
    assert_eq!(accepted.status, 202, "{}", accepted.body);
    let duplicate = api
        .send("POST", &format!("{base}/commands"), &phone, Some(request))
        .await;
    assert_eq!(duplicate.body["duplicate"], true);
    assert!(
        cluster.llm.requests().is_empty(),
        "settings, rejections and receipt queries never infer"
    );
}
