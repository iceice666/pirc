use super::super::side::Side;
use super::*;
use crate::workspace_memory::tests::Fixture;

fn side(runner: &Runner) -> Side {
    let side = Side {
        id: crate::util::uuid(),
        abort: Arc::new(watch::channel(false).0),
    };
    runner.lock().sandbox_requests.insert(
        side.id.clone(),
        SideRequest {
            abort: side.abort.clone(),
            dialog: None,
            task: None,
        },
    );
    side
}
#[tokio::test]
async fn approval_cannot_outlive_runner_epoch_mode_directory_or_withdrawal() {
    let f = Fixture::new().await;
    let row = f.node.db.lock().get_session(&f.current).unwrap();
    let runner = super::memory_concurrency_tests::register(&f, row);
    let cwd = runner.workspace.canonical_path.clone();
    let request = side(&runner);
    request.abort.send_replace(true);
    assert!(
        runner
            .start_host(&request, "true", &cwd, Duration::from_secs(5))
            .is_err()
    );
    let request = side(&runner);
    // Reusing an RPC ID cannot borrow its replacement's approval channel.
    runner.lock().sandbox_requests.insert(
        request.id.clone(),
        SideRequest {
            abort: Arc::new(watch::channel(false).0),
            dialog: None,
            task: None,
        },
    );
    assert!(
        runner
            .start_host(&request, "true", &cwd, Duration::from_secs(5))
            .is_err()
    );
    let request = side(&runner);
    let mode_id = f.mode.id.clone();
    f.node
        .modes
        .write()
        .unwrap()
        .get_mut(&mode_id)
        .unwrap()
        .workspace_memory = false;
    assert!(
        runner
            .start_host(&request, "true", &cwd, Duration::from_secs(5))
            .is_err()
    );
    f.node
        .modes
        .write()
        .unwrap()
        .insert(mode_id, f.mode.clone());
    assert!(
        runner
            .start_host(&request, "true", "/", Duration::from_secs(5))
            .is_err()
    );
    let sub = PathBuf::from(&cwd).join("approved");
    std::fs::create_dir(&sub).unwrap();
    std::fs::remove_dir(&sub).unwrap();
    std::os::unix::fs::symlink("/", &sub).unwrap();
    assert!(
        runner
            .start_host(
                &request,
                "true",
                sub.to_str().unwrap(),
                Duration::from_secs(5)
            )
            .is_err()
    );
    let ticket = runner
        .start_host(&request, "printf approved", &cwd, Duration::from_secs(5))
        .unwrap();
    assert_eq!(ticket.result().await.unwrap()["output"], "approved");
    let request = side(&runner);
    f.node.db.lock().increment_epoch(&f.current).unwrap();
    assert!(
        runner
            .start_host(&request, "true", &cwd, Duration::from_secs(5))
            .is_err()
    );
    runner.exit(Some(0), None);
    f.node.close().await;
}
#[tokio::test]
async fn runner_exit_cancels_host_jobs_even_after_side_entry_is_replaced() {
    let f = Fixture::new().await;
    let row = f.node.db.lock().get_session(&f.current).unwrap();
    let runner = super::memory_concurrency_tests::register(&f, row);
    let request = side(&runner);
    let ticket = runner
        .start_host(
            &request,
            "exec /bin/sleep 30",
            &runner.workspace.canonical_path,
            Duration::from_secs(60),
        )
        .unwrap();
    runner.lock().sandbox_requests.remove(&request.id);
    runner.exit(Some(0), None);
    // Exit alone sends cancellation; a caller requiring drainage waits for the
    // Node-owned registry even though the runner and side entry are both gone.
    f.node.runners.stop_session(&f.current).await.unwrap();
    assert_eq!(ticket.result().await.unwrap()["aborted"], true);
    f.node.close().await;
}

#[tokio::test]
async fn runner_stop_cancels_approved_commands_before_agent_exit() {
    let f = Fixture::new().await;
    let row = f.node.db.lock().get_session(&f.current).unwrap();
    let runner = super::memory_concurrency_tests::register(&f, row);
    let request = side(&runner);
    let ticket = runner
        .start_host(
            &request,
            "exec /bin/sleep 30",
            &runner.workspace.canonical_path,
            Duration::from_secs(60),
        )
        .unwrap();
    // This fixture has no Agent replying to abort and no exit event. Cancellation
    // must occur when Stop begins, without waiting for either acknowledgement.
    runner.stop(Duration::from_millis(1)).await;
    assert!(!runner.lock().closed);
    assert!(*request.abort.borrow());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(4), ticket.result())
            .await
            .unwrap()
            .unwrap()["aborted"],
        true
    );
    runner.exit(Some(0), None);
    f.node.close().await;
}
