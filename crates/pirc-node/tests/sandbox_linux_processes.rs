//! Real PID-namespace retirement, including setsid and open writable descriptors.
//! This is a native Linux acceptance test, not satisfied by the macOS mock tests.
#![cfg(target_os = "linux")]
mod sandbox_linux_support;

use pirc_node::sandbox::{Prepared, Sandbox, processes::State};
use sandbox_linux_support::fixture;
use std::{path::Path, process::Stdio, time::Duration};

async fn state(prepared: &Prepared, expected: State) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let current = prepared.process_scope_state();
            if current == expected {
                break;
            }
            assert_ne!(
                current,
                State::Unconfirmed,
                "namespace identity was not captured"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process scope did not reach expected state");
}
async fn exists(path: &Path) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("sandbox child did not start");
}
fn command(prepared: &Prepared, root: &Path, name: &str) -> tokio::process::Child {
    // The detached descendant keeps a writable descriptor open. Killing only
    // the wrapper's process group must not be enough to make this test pass.
    let mut command = prepared.command().unwrap();
    let child = command
        .args([
            "-c",
            r#"
        setsid /bin/sh -c '
            trap "" HUP TERM
            exec 8>>"$1"
            echo ready >"$2"
            while :; do printf x >&8; sleep 0.02; done
        ' detached "$1.data" "$1.ready" </dev/null >/dev/null 2>&1 &
        while :; do sleep 1; done
    "#,
            "agent",
            name,
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    prepared.process_spawned(child.id().unwrap());
    child
}

#[tokio::test]
async fn retires_detached_writers_without_touching_peer_or_later_user_edits() {
    let Some(f) = fixture("namespace-retirement") else {
        assert_ne!(
            std::env::var("PIRC_PROCESS_SCOPE_REQUIRED").as_deref(),
            Ok("1"),
            "bubblewrap is required"
        );
        return;
    };
    let a = f.sandbox.prepare(f.input("a", None)).await.unwrap();
    let b = f.sandbox.prepare(f.input("b", None)).await.unwrap();
    let root = f.root.join("workspace");
    let mut a_child = command(&a, &root, "a");
    let mut b_child = command(&b, &root, "b");
    state(&a, State::Running).await;
    state(&b, State::Running).await;
    exists(&root.join("a.ready")).await;
    exists(&root.join("b.ready")).await;
    let saved = a
        .process_snapshot()
        .identity
        .expect("durable kernel identity");
    // A later Node incarnation has no original pidfd. Re-open solely from the
    // frozen kernel identity; peer B and user files must still be untouched.
    assert_eq!(
        pirc_node::sandbox::linux::processes::retire_saved(&saved).await,
        State::Terminated
    );
    assert_eq!(
        a.wait_processes(Duration::from_secs(8)).await,
        State::Terminated
    );
    tokio::time::timeout(Duration::from_secs(8), a_child.wait())
        .await
        .unwrap()
        .unwrap();
    std::fs::write(root.join("a.data"), "user's later edit").unwrap();
    let before = std::fs::metadata(root.join("b.data")).unwrap().len();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        std::fs::read_to_string(root.join("a.data")).unwrap(),
        "user's later edit"
    );
    assert!(std::fs::metadata(root.join("b.data")).unwrap().len() > before);
    assert_eq!(b.process_scope_state(), State::Running);
    a.terminate_processes();
    assert_eq!(
        b.process_scope_state(),
        State::Running,
        "old teardown must not kill the peer"
    );
    let mut changed_boot = saved.clone();
    changed_boot.boot_id = "00000000-0000-0000-0000-000000000000".into();
    assert_eq!(
        pirc_node::sandbox::linux::processes::retire_saved(&changed_boot).await,
        State::Unconfirmed
    );
    assert_eq!(
        pirc_node::sandbox::linux::processes::retire_saved(&saved).await,
        State::Terminated
    );
    assert_eq!(b.process_scope_state(), State::Running);

    b.terminate_processes();
    assert_eq!(
        b.wait_processes(Duration::from_secs(8)).await,
        State::Terminated
    );
    tokio::time::timeout(Duration::from_secs(8), b_child.wait())
        .await
        .unwrap()
        .unwrap();
    a.cleanup();
    b.cleanup();
}

#[tokio::test]
async fn wrapper_exit_is_observed_through_the_separately_pinned_namespace() {
    let Some(f) = fixture("namespace-wrapper-exit") else {
        assert_ne!(
            std::env::var("PIRC_PROCESS_SCOPE_REQUIRED").as_deref(),
            Ok("1"),
            "bubblewrap is required"
        );
        return;
    };
    let prepared = f.sandbox.prepare(f.input("crashed", None)).await.unwrap();
    let root = f.root.join("workspace");
    let mut child = command(&prepared, &root, "crashed");
    state(&prepared, State::Running).await;
    exists(&root.join("crashed.ready")).await;
    child.kill().await.unwrap();
    // No new PID lookup here. Repeated retirement keeps using the same handle.
    prepared.terminate_processes();
    assert_eq!(
        prepared.wait_processes(Duration::from_secs(8)).await,
        State::Terminated
    );
    let before = std::fs::read(root.join("crashed.data")).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read(root.join("crashed.data")).unwrap(), before);
}
