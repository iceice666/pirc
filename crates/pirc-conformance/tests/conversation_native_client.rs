//! Actual paired Kotlin first-send engine in fresh JVM processes. Not Android OS.
mod conversation_clients_support;
use conversation_clients_support::{ClientProcess, verify};
use pirc_conformance::{Cluster, GatewayOptions, HOST, Reply, browser_headers};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

fn client(runtime: &Value, config: &Path, directory: &Path, phase: &str) -> ClientProcess {
    let log = directory.join(format!("native-{phase}.log"));
    let output = File::create(&log).unwrap();
    ClientProcess {
        child: Command::new(runtime["java"].as_str().unwrap())
            .arg("-cp")
            .arg(runtime["classpath"].as_str().unwrap())
            .arg("dev.pirc.pirc_mobile.NativeFirstSendLive")
            .arg(config)
            .arg(phase)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap(),
        log,
    }
}
async fn pair(cluster: &Cluster, name: &str) -> Value {
    let response = cluster
        .api()
        .send(
            "POST",
            "/api/devices",
            &browser_headers(),
            Some(json!({"name":name})),
        )
        .await;
    assert_eq!(response.status, 201, "{}", response.body);
    response.body
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the prepared Kotlin JVM runtime and real binaries; see first-send-acceptance.md"]
async fn native_reopens_lost_receipts_and_revoked_device_cannot_send_or_erase_local_input() {
    let runtime: Value = serde_json::from_slice(
        &fs::read(
            std::env::var_os("PIRC_NATIVE_FIRST_SEND_RUNTIME")
                .expect("prepare the native runtime first"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut cluster = Cluster::start_with(GatewayOptions {
        chat_node: true,
        agent_core_only: true,
        ..Default::default()
    })
    .await
    .expect("set PIRC_CONFORMANCE_BIN_DIR");
    cluster.llm.push([
        Reply::Text("Native first completed".into()),
        Reply::Text("Native second completed".into()),
    ]);
    let primary = pair(&cluster, "native-primary").await;
    let secondary = pair(&cluster, "native-secondary").await;
    let directory = cluster.dir.path().join("native-acceptance");
    fs::create_dir(&directory).unwrap();
    let config = directory.join("config.json");
    let file = File::create(&config).unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    serde_json::to_writer(
        file,
        &json!({
            "gateway":format!("http://127.0.0.1:{}",cluster.port), "host":HOST, "directory":directory,
            "token":primary["token"], "secondToken":secondary["token"],
        }),
    )
    .unwrap();
    let mut first = client(&runtime, &config, &directory, "send");
    let pending = first.stage(&directory, "before-restart").await;
    first.finish().await;
    let operations = pending["operations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    let commands = verify(&cluster, operations).await;
    cluster.restart_node(true).await;
    cluster.restart_gateway(true).await;
    let mut reopened = client(&runtime, &config, &directory, "recover");
    let recovered = reopened.stage(&directory, "recovered").await;
    let recovered_operations = recovered["operations"].as_array().unwrap();
    assert_eq!(recovered_operations.len(), operations.len());
    for ((operation, previous), command) in
        recovered_operations.iter().zip(operations).zip(&commands)
    {
        assert_eq!(operation["id"], previous["id"]);
        assert_eq!(operation["session"], previous["session"]);
        assert_eq!(operation["command"].as_str().unwrap(), command);
    }
    let revoked = cluster
        .api()
        .send(
            "DELETE",
            &format!("/api/devices/{}", primary["device"]["id"].as_str().unwrap()),
            &browser_headers(),
            None,
        )
        .await;
    assert_eq!(revoked.status, 204, "{}", revoked.body);
    fs::write(directory.join("revoked.json"), b"{}").unwrap();
    let result = reopened.stage(&directory, "result").await;
    reopened.finish().await;
    assert_eq!(result["revokedRefused"], true);
    assert_eq!(verify(&cluster, operations).await, commands);
    let absent = cluster
        .api()
        .send(
            "GET",
            "/api/conversation-submissions/revoked-new",
            &browser_headers(),
            None,
        )
        .await;
    assert_eq!(absent.status, 404, "{}", absent.body);
}

async fn verify_competition(cluster: &Cluster, operations: &[Value], after_restart: bool) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(10);
    while cluster.llm.requests().is_empty() {
        assert!(Instant::now() < deadline, "native takeover did not infer");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        cluster.llm.requests().len(),
        1,
        "only the admitted input may run"
    );
    let input = cluster.llm.requests()[0]["messages"].to_string();
    assert!(input.contains("First message race-admit"));
    assert!(!input.contains("First message race-stop"));
    assert!(!input.contains("First message race-delete"));
    for operation in operations {
        let id = operation["id"].as_str().unwrap();
        let session = operation["session"].as_str().unwrap();
        let cleanup_deadline = Instant::now() + Duration::from_secs(15);
        let receipt = loop {
            let receipt = cluster
                .api()
                .send(
                    "GET",
                    &format!("/api/conversation-submissions/{id}/receipt"),
                    &browser_headers(),
                    None,
                )
                .await;
            assert_eq!(receipt.status, 200, "{}", receipt.body);
            if id != "race-delete"
                || !after_restart
                || receipt.body["preparation"]["cleanupPending"] == false
            {
                break receipt;
            }
            assert!(
                Instant::now() < cleanup_deadline,
                "accepted cleanup did not finish: {}",
                receipt.body
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        };
        let preparation = &receipt.body["preparation"];
        assert_eq!(preparation["state"], operation["state"]);
        assert_eq!(preparation["sessionId"], session);
        assert_eq!(
            preparation["messageAdmission"]["commandId"],
            operation["command"]
        );
        if id == "race-stop" {
            assert_eq!(preparation["messageAdmission"]["stopConfirmed"], true);
        }
        let snapshot = cluster
            .api()
            .send(
                "GET",
                &format!("/api/sessions/{session}/snapshot"),
                &browser_headers(),
                None,
            )
            .await;
        if id == "race-delete" {
            assert_eq!(snapshot.status, 404, "{}", snapshot.body);
            // Gateway staging cleanup sweeps every minute and immediately at startup.
            // Deletion fences execution even while that separate durable cleanup is pending.
            if after_restart {
                assert_eq!(preparation["cleanupPending"], false);
                assert!(
                    !cluster
                        .dir
                        .path()
                        .join("gateway-state/submission-staging")
                        .join(session)
                        .exists()
                );
            }
            assert!(preparation.get("submission").is_none());
        } else {
            assert_eq!(snapshot.status, 200, "{}", snapshot.body);
            let entries = snapshot.body["history"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["role"] == "user")
                .count();
            assert_eq!(entries, usize::from(id == "race-admit"));
        }
    }
    let sessions = cluster
        .api()
        .send("GET", "/api/sessions", &browser_headers(), None)
        .await;
    assert_eq!(sessions.status, 200);
    assert_eq!(sessions.body["sessions"].as_array().unwrap().len(), 2);
    let mut files = fs::read_dir(cluster.dir.path().join("node-state/uploads"))
        .unwrap()
        .map(|entry| fs::read(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(
        files,
        vec![
            b"Original bytes for race-admit".to_vec(),
            b"Original bytes for race-stop".to_vec()
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the prepared Kotlin runtime, Web dependencies, dedicated test browser and real binaries"]
async fn native_takeover_stop_and_delete_fence_delayed_web_dispatch_across_restart() {
    let runtime: Value = serde_json::from_slice(
        &fs::read(
            std::env::var_os("PIRC_NATIVE_FIRST_SEND_RUNTIME")
                .expect("prepare the native runtime first"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut cluster = Cluster::start_with(GatewayOptions {
        chat_node: true,
        agent_core_only: true,
        ..Default::default()
    })
    .await
    .expect("set PIRC_CONFORMANCE_BIN_DIR");
    cluster
        .llm
        .push([Reply::Text("Only the deliberate takeover may run".into())]);
    let paired = pair(&cluster, "native-competitor").await;
    let directory = cluster.dir.path().join("mixed-client-acceptance");
    fs::create_dir(&directory).unwrap();
    let config = directory.join("config.json");
    let file = File::create(&config).unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    serde_json::to_writer(file, &json!({
        "gateway":format!("http://127.0.0.1:{}",cluster.port), "host":HOST, "directory":directory,
        "token":paired["token"], "mode":"competition", "owner":pirc_conformance::USER,
        "origin":pirc_conformance::ORIGIN, "workspace":pirc_conformance::CHATS_WORKSPACE_ID,
    })).unwrap();
    let log = directory.join("web-races.log");
    let output = File::create(&log).unwrap();
    let mut browser = ClientProcess {
        child: Command::new(std::env::var_os("PIRC_TEST_NODE").unwrap_or_else(|| "node".into()))
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .arg("scripts/first-send-browser.mjs")
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap(),
        log,
    };
    let mut native = client(&runtime, &config, &directory, "compete");
    let (pending, done) = tokio::join!(
        browser.stage(&directory, "web-races-done"),
        native.stage(&directory, "native-races-done")
    );
    native.finish().await;
    let operations = pending["operations"].as_array().unwrap();
    assert_eq!(operations.len(), 3);
    let native_operations = done["operations"].as_array().unwrap();
    assert_eq!(native_operations.len(), operations.len());
    for (web, native) in operations.iter().zip(native_operations) {
        for field in ["id", "session", "state", "command"] {
            assert_eq!(web[field], native[field]);
        }
    }
    verify_competition(&cluster, operations, false).await;
    cluster.restart_node(true).await;
    cluster.restart_gateway(true).await;
    let mut recovered = client(&runtime, &config, &directory, "compete-recover");
    fs::write(directory.join("hosts-restarted.json"), b"{}").unwrap();
    let (web, native) = tokio::join!(
        browser.stage(&directory, "web-race-result"),
        recovered.stage(&directory, "native-race-result")
    );
    browser.finish().await;
    recovered.finish().await;
    assert_eq!(web["readOnlyAfterRestart"], true);
    assert_eq!(web["operations"], pending["operations"]);
    assert_eq!(native["operations"], done["operations"]);
    verify_competition(&cluster, operations, true).await;
}
