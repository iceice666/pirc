//! Real Node process/link proof for durable first-send file transfer. The test
//! acts as Gateway; no provider or browser runs. Full client acceptance is separate.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use pirc_conformance::{FakeGateway, LoneNode, NODE_ID, NodeOptions, USER};
use serde_json::json;
use sha2::{Digest, Sha256};

async fn register(gateway: &FakeGateway) -> pirc_conformance::NodeLink {
    let mut link = gateway.accept().await;
    link.recv_where(|frame| frame["type"] == "register").await;
    link.send(
        &json!({"type":"registered","nodeId":NODE_ID,"models":{"providers":{}},"mirrors":{}}),
    )
    .await;
    link
}
#[tokio::test(flavor = "multi_thread")]
async fn creation_attachment_survives_process_crash_and_does_not_revive_after_delete() {
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
    let create = json!({"method":"POST","url":"/api/session-creations","user":USER,"payload":{"operationId":"first-send","workspaceId":"chats","submissionHash":"a".repeat(64)}});
    let created = link.request("create", create.clone()).await;
    assert_eq!(created["data"]["status"], 200, "{created}");
    let session = created["data"]["body"]["creation"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let hash = format!("{:x}", Sha256::digest(b"test"));
    let url = format!(
        "/api/session-creations/first-send/attachments/file-1?submissionHash={}&sha256={hash}&byteSize=4&filename=private-name.txt",
        "a".repeat(64)
    );
    let transfer = json!({"method":"PUT","url":url,"user":USER,"bodyBase64":STANDARD.encode(b"test"),"contentType":"text/plain"});
    let first = link.request("transfer", transfer.clone()).await;
    assert_eq!(first["data"]["status"], 200, "{first}");
    let receipt = first["data"]["body"]["creationAttachment"].clone();
    assert_eq!(receipt["state"], "ready");
    assert_eq!(receipt["upload"]["sha256"], hash);
    let retry = link.request("retry-lost-response", transfer.clone()).await;
    assert_eq!(retry["data"]["body"]["creationAttachment"], receipt);
    node.restart(true);
    drop(link);
    let mut link = register(&gateway).await;
    let lookup = json!({"method":"GET","url":"/api/session-creations/first-send/attachments/file-1","user":USER});
    let recovered = link.request("after-restart", lookup.clone()).await;
    assert_eq!(recovered["data"]["status"], 200, "{recovered}");
    assert_eq!(recovered["data"]["body"]["creationAttachment"], receipt);
    let same_creation = link.request("same-creation", create.clone()).await;
    assert_eq!(
        same_creation["data"]["body"]["creation"]["sessionId"],
        session
    );
    let mut changed = transfer.clone();
    changed["bodyBase64"] = json!(STANDARD.encode(b"oops"));
    assert_eq!(
        link.request("wrong-bytes", changed).await["data"]["status"],
        409
    );
    let deleted = link
        .request(
            "delete",
            json!({"method":"DELETE","url":format!("/api/sessions/{session}"),"user":USER}),
        )
        .await;
    assert_eq!(deleted["data"]["status"], 204, "{deleted}");
    let status = link.request("deleted-status", lookup).await;
    assert_eq!(status["data"]["status"], 200);
    let tombstone = status["data"]["body"]["creationAttachment"].clone();
    assert_eq!(tombstone["state"], "deleted");
    assert_eq!(tombstone["upload"], json!({"id":receipt["upload"]["id"]}));
    assert_eq!(
        link.request("delayed-transfer", transfer).await["data"]["body"]["creationAttachment"],
        tombstone
    );
    assert_eq!(
        link.request("delayed-create", create).await["data"]["body"]["creation"]["state"],
        "deleted"
    );
    // A tombstone exposes no former filename or storage path.
    assert!(tombstone["upload"].get("filename").is_none());
    assert!(tombstone["upload"].get("storageName").is_none());
}
