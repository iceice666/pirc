//! Actual Web client + IndexedDB against the real Gateway, Node and Agent.
//! Explicit browser acceptance (see docs/development/first-send-acceptance.md),
//! separate from the default suite and Android device/OS acceptance.
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use pirc_conformance::{
    CHATS_WORKSPACE_ID, Cluster, GatewayOptions, HOST, ORIGIN, Reply, USER, browser_headers,
};
use serde_json::{Value, json};

struct Browser {
    child: Child,
    log: PathBuf,
}
impl Browser {
    async fn stage(&mut self, directory: &Path, name: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        let path = directory.join(format!("{name}.json"));
        loop {
            if let Ok(bytes) = fs::read(&path) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            assert!(
                self.child.try_wait().unwrap().is_none() && Instant::now() < deadline,
                "browser never reached {name}: {}",
                fs::read_to_string(&self.log).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    async fn finish(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "browser failed: {}",
                    fs::read_to_string(&self.log).unwrap_or_default()
                );
                return;
            }
            assert!(Instant::now() < deadline, "browser cleanup timed out");
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        // This helper closes only its own fresh browser/profile on SIGTERM.
        let _ = kill(Pid::from_raw(self.child.id() as i32), Signal::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn verify(cluster: &Cluster, operations: &[Value]) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while cluster.llm.requests().len() < operations.len() {
        assert!(Instant::now() < deadline, "missing actual model request");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(cluster.llm.requests().len(), operations.len());
    let mut commands = Vec::new();
    for operation in operations {
        let id = operation["id"].as_str().unwrap();
        let session = operation["session"].as_str().unwrap();
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
        assert_eq!(receipt.body["preparation"]["state"], "admitted");
        assert_eq!(receipt.body["preparation"]["sessionId"], session);
        commands.push(
            receipt.body["preparation"]["messageAdmission"]["commandId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        let history = cluster
            .api()
            .send(
                "GET",
                &format!("/api/sessions/{session}/snapshot"),
                &browser_headers(),
                None,
            )
            .await;
        assert_eq!(history.status, 200, "{}", history.body);
        let expected = format!("First message {id}");
        assert_eq!(
            cluster
                .llm
                .requests()
                .iter()
                .filter(|request| request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["role"] == "user"
                        && row["content"].to_string().contains(&expected)))
                .count(),
            1,
            "each original input must infer exactly once"
        );
        assert_eq!(
            history.body["history"]
                .as_array()
                .unwrap()
                .iter()
                .filter(
                    |row| row["role"] == "user" && row["content"].to_string().contains(&expected)
                )
                .count(),
            1,
            "{}",
            history.body
        );
    }
    let sessions = cluster
        .api()
        .send("GET", "/api/sessions", &browser_headers(), None)
        .await;
    assert_eq!(sessions.status, 200, "{}", sessions.body);
    assert_eq!(
        sessions.body["sessions"].as_array().unwrap().len(),
        operations.len()
    );
    let mut files = fs::read_dir(cluster.dir.path().join("node-state/uploads"))
        .unwrap()
        .map(|entry| fs::read(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    files.sort();
    let mut expected = operations
        .iter()
        .map(|op| format!("Original bytes for {}", op["id"].as_str().unwrap()).into_bytes())
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(files, expected);
    commands
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires installed Web dependencies and a dedicated Headless Shell; run the documented live Web acceptance command"]
async fn web_reconciles_lost_reply_and_local_commit_after_browser_and_hosts_restart() {
    let mut cluster = Cluster::start_with(GatewayOptions {
        chat_node: true,
        agent_core_only: true,
        ..Default::default()
    })
    .await
    .expect("set PIRC_CONFORMANCE_BIN_DIR to the Gateway/Node executables");
    cluster.llm.push([
        Reply::Text("First completed once".into()),
        Reply::Text("Second completed once".into()),
        Reply::Text("Third completed once".into()),
    ]);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory = cluster.dir.path().join("web-acceptance");
    fs::create_dir(&directory).unwrap();
    let config = directory.join("config.json");
    fs::write(
        &config,
        serde_json::to_vec(&json!({
            "gateway": format!("http://127.0.0.1:{}", cluster.port),
            "host": HOST, "origin": ORIGIN, "owner": USER,
            "workspace": CHATS_WORKSPACE_ID, "directory": directory,
        }))
        .unwrap(),
    )
    .unwrap();
    let log = directory.join("browser.log");
    let output = File::create(&log).unwrap();
    let mut browser = Browser {
        child: Command::new(std::env::var_os("PIRC_TEST_NODE").unwrap_or_else(|| "node".into()))
            .current_dir(root)
            .arg("scripts/first-send-browser.mjs")
            .arg(config)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap(),
        log,
    };
    let pending = browser.stage(&directory, "before-restart").await;
    let operations = pending["operations"].as_array().unwrap();
    assert_eq!(operations.len(), 3);
    let commands = verify(&cluster, operations).await;
    cluster.restart_node(true).await;
    cluster.restart_gateway(true).await;
    fs::write(directory.join("hosts-restarted.json"), b"{}").unwrap();
    let result = browser.stage(&directory, "result").await;
    browser.finish().await;
    assert_eq!(result["readOnlyAfterRestart"], true);
    assert_eq!(result["operations"], pending["operations"]);
    assert_eq!(verify(&cluster, operations).await, commands);
}
