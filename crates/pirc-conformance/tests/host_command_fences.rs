//! Real Node/Agent/PTC processes: Node-owned approval, ordinary Stop and a
//! durable transition drain share supervised host-command lifetimes.
mod node_link_side_support;
use node_link_side_support::{Gateway, last_message, models, registered, settled_in};
use pirc_conformance::{FakeGateway, LoneNode, NodeOptions};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

async fn approved(gw: &mut Gateway, session: &str, generation: &Value, key: &str, marker: &Path) {
    let sent = gw
        .prompt(
            session,
            generation,
            key,
            "Run the approved bounded host fixture",
        )
        .await;
    assert_eq!(sent["data"]["status"], 202, "{sent}");
    let start = gw.model_start().await;
    let args = json!({"command":format!("echo $$ > '{}'; exec /bin/sleep 30",marker.display()),"reason":"Local owned cancellation fixture","timeout":40});
    gw.reply_tool(
        &start,
        key,
        "ptc",
        json!({"code":format!("return await tools.call('unsandboxed_bash', {args});")}),
    )
    .await;
    let created = gw
        .take(|frame| {
            frame["type"] == "event"
                && frame["sessionId"] == session
                && frame["event"]["type"] == "interaction_created"
        })
        .await;
    assert!(!marker.exists(), "must wait for the human");
    let id = created["event"]["data"]["id"].as_str().unwrap();
    let answer = gw
        .ask(
            "POST",
            &format!("/api/sessions/{session}/interactions/{id}/answer"),
            Some(json!({"clientId":"browser","generation":generation,"answer":{"confirmed":true}})),
        )
        .await;
    assert_eq!(answer["data"]["status"], 200, "{answer}");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !std::fs::read_to_string(marker).is_ok_and(|s| s.trim().parse::<u32>().is_ok()) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("approved host command should start");
}

#[tokio::test(flavor = "multi_thread")]
async fn approved_host_commands_settle_before_stop_and_transition_acknowledgement() {
    let server = FakeGateway::bind().await;
    let Some(mut node) = LoneNode::start_with(
        server.port(),
        NodeOptions {
            env: vec![
                ("PIRC_BROWSER", "false".into()),
                ("TMPDIR", "{run_dir}".into()),
            ],
            ..Default::default()
        },
    ) else {
        return;
    };
    let mut gw = Gateway::new(server.accept().await);
    gw.link.recv().await;
    gw.link
        .send(&registered(models("fake", "fake-model", "low"), json!({})))
        .await;
    let (a, control) = gw.session().await;
    let (b, peer_control) = gw.session().await;
    let first = node.dir.path().join("workspace/host-first");
    approved(&mut gw, &a, &control, "first-host", &first).await;
    // Another session's inference must survive stopping the host owner.
    gw.prompt(&b, &peer_control, "peer", "Finish independently")
        .await;
    let peer = gw.model_start().await;
    let shared = node.dir.path().join("workspace/user.txt");
    std::fs::write(&shared, "user's later change").unwrap();
    gw.reply_tool(&peer, "peer-write-blocked", "ptc", json!({"code":"return await tools.call('write', {path:'user.txt',content:'must not overwrite'});"})).await;
    let peer = gw.model_start().await;
    assert!(
        last_message(&peer).to_string().contains("host command"),
        "{}",
        last_message(&peer)
    );
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "user's later change"
    );
    let first_pid = std::fs::read_to_string(&first).unwrap();
    let stopped = gw
        .command(&a, &control, "stop-host", json!({"type":"stop"}))
        .await;
    assert_eq!(stopped["data"]["status"], 202, "{stopped}");
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", first_pid.trim()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success(),
        "Stop must await its owned host leader"
    );
    let repeated = gw
        .command(&a, &control, "stop-host", json!({"type":"stop"}))
        .await;
    assert_eq!(repeated["data"]["status"], 200, "{repeated}");
    assert_eq!(repeated["data"]["body"]["duplicate"], true);
    assert_eq!(repeated["data"]["body"]["command"]["status"], "accepted");
    // Once the observer settles, a fresh peer call may acquire the range.
    gw.reply_tool(&peer, "peer-write-after-stop", "ptc", json!({"code":"return await tools.call('write', {path:'peer-result.txt',content:'peer completed'});"})).await;
    let peer = gw.model_start().await;
    assert_eq!(
        std::fs::read_to_string(node.dir.path().join("workspace/peer-result.txt")).unwrap(),
        "peer completed"
    );
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "user's later change"
    );
    gw.reply_text(&peer, "Independent reply survived.").await;
    gw.take(settled_in(&b)).await;
    // Ordinary Stop retains a usable conversation, and a fresh command still
    // needs a fresh human approval. Then transition drain must join that command.
    let second = node.dir.path().join("workspace/host-second");
    approved(&mut gw, &a, &control, "second-host", &second).await;
    let second_pid = std::fs::read_to_string(&second).unwrap();
    let base = format!("/api/sessions/{a}");
    let before = gw.ask("GET", &format!("{base}/snapshot"), None).await;
    let fenced=gw.ask("POST",&format!("{base}/execution-fences"),Some(json!({"intent":{"operationId":"host-switch","planHash":"a".repeat(64),"expectedWorkspaceId":"test","expectedRunnerEpoch":before["data"]["body"]["session"]["runnerEpoch"]},"clientId":"browser","generation":control}))).await;
    assert_eq!(fenced["data"]["status"], 200, "{fenced}");
    let drained = gw
        .ask(
            "POST",
            &format!("{base}/execution-fences/host-switch/drain"),
            Some(json!({})),
        )
        .await;
    let receipt = &drained["data"]["body"]["transition"];
    assert_eq!(receipt["state"], "supervisor_drained", "{drained}");
    assert_eq!(receipt["hostCommands"]["launches"], 2);
    assert_eq!(receipt["hostCommands"]["observersSettled"], 2);
    assert_eq!(receipt["hostCommands"]["unresolved"], 0);
    assert_eq!(receipt["hostCommands"]["historyComplete"], false);
    assert_eq!(receipt["revocationConfirmed"], false);
    assert_eq!(receipt["targetInstalled"], false);
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", second_pid.trim()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success(),
        "Drain must await its owned host leader"
    );
    node.restart(false);
    let mut gw = Gateway::new(server.accept().await);
    gw.link.recv().await;
    gw.link
        .send(&registered(models("fake", "fake-model", "low"), json!({})))
        .await;
    let saved = gw
        .ask("GET", &format!("{base}/execution-fences/host-switch"), None)
        .await;
    assert_eq!(
        saved["data"]["body"]["transition"]["hostCommands"],
        receipt["hostCommands"]
    );
    assert_eq!(std::fs::read_to_string(first).unwrap(), first_pid);
    assert_eq!(std::fs::read_to_string(second).unwrap(), second_pid);
}
