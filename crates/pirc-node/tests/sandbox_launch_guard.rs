//! Real bridge process: EOF/malformed input refuses before listeners or agent.
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;
#[tokio::test]
async fn bridge_never_executes_a_command_when_node_dies_before_permission() {
    let dir = tempfile::tempdir().unwrap();
    for data in [
        b"".as_slice(),
        b"PIRC-LAUNCH-",
        b"{\"type\":\"configure\"}\n",
    ] {
        let marker = dir.path().join("forbidden");
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_pirc-node"))
            .args([
                "sandbox-bridge",
                "/unused-proxy",
                "--",
                "/bin/sh",
                "-c",
                "printf forbidden > \"$1\"",
                "agent",
            ])
            .arg(&marker)
            .env("PIRC_NATIVE_LAUNCH_GUARD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        child.stdin.as_mut().unwrap().write_all(data).await.unwrap();
        // Closing the owning pipe is what an abrupt Node exit does as well.
        child.stdin.take();
        let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(125),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!marker.exists());
        assert!(output.stdout.is_empty());
    }
}
