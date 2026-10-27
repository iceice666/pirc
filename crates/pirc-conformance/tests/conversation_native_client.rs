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
