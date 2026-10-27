use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use pirc_conformance::{Cluster, browser_headers};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

pub struct ClientProcess {
    pub child: Child,
    pub log: PathBuf,
}
impl ClientProcess {
    pub async fn stage(&mut self, directory: &Path, name: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        let path = directory.join(format!("{name}.json"));
        loop {
            if let Ok(bytes) = fs::read(&path) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            assert!(
                self.child.try_wait().unwrap().is_none() && Instant::now() < deadline,
                "client never reached {name}: {}",
                fs::read_to_string(&self.log).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    pub async fn finish(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "client failed: {}",
                    fs::read_to_string(&self.log).unwrap_or_default()
                );
                return;
            }
            assert!(Instant::now() < deadline, "client cleanup timed out");
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
}
impl Drop for ClientProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        // Stop only the test-owned client process; browser helpers close their own profile.
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

pub async fn verify(cluster: &Cluster, operations: &[Value]) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while cluster.llm.requests().len() < operations.len() {
        assert!(Instant::now() < deadline, "missing actual model request");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(cluster.llm.requests().len(), operations.len());
    let mut commands = Vec::new();
    let mut bindings = std::collections::HashMap::new();
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
        let public = &history.body["session"];
        let binding = &public["binding"];
        assert_eq!(binding["version"], 1);
        assert_eq!(binding["membership"]["revision"], 1);
        assert_eq!(
            binding["membership"]["legacyWorkspaceId"],
            public["workspaceId"]
        );
        assert_eq!(binding["execution"]["generation"], 1);
        assert_eq!(binding["execution"]["workspaceId"], public["workspaceId"]);
        assert_eq!(binding["execution"]["nodeId"], public["nodeId"]);
        assert_eq!(binding["execution"]["modeId"], "chat");
        assert!(public.get("piSessionId").is_none());
        bindings.insert(session.to_owned(), binding.clone());
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
    for session in sessions.body["sessions"].as_array().unwrap() {
        assert_eq!(
            Some(&session["binding"]),
            bindings.get(session["id"].as_str().unwrap())
        );
    }
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
