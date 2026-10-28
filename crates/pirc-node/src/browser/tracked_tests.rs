use super::*;
use crate::workspace_memory::tests::Fixture;
use serde_json::json;
#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
    closes: AtomicUsize,
    fail_close: AtomicBool,
    close_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}
impl BrowserService for Fake {
    fn enabled(&self) -> bool {
        true
    }
    fn handle(&self, _: BrowserTarget, _: String, _: Value) -> BoxFuture<'_, ApiResult<Value>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(json!({})) })
    }
    fn handle_with_abort(
        &self,
        t: BrowserTarget,
        o: String,
        a: Value,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'_, ApiResult<Value>> {
        self.handle(t, o, a)
    }
    fn attach(&self, _: &str, _: FrameSink) -> Detach {
        Box::new(|| {})
    }
    fn input(&self, _: BrowserTarget, _: Value) -> BoxFuture<'_, ApiResult<Option<Value>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(None) })
    }
    fn close_session(&self, _: &str) -> BoxFuture<'_, ApiResult<()>> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        let gate = lock(&self.close_gate).take();
        Box::pin(async move {
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            if self.fail_close.load(Ordering::SeqCst) {
                Err(journal::unresolved())
            } else {
                Ok(())
            }
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}
fn target(f: &Fixture) -> BrowserTarget {
    BrowserTarget {
        session_id: f.current.clone(),
        workspace_id: "repo".into(),
        root: f
            .node
            .db
            .lock()
            .get_workspace("repo")
            .unwrap()
            .canonical_path
            .into(),
    }
}
fn setup(f: &Fixture) -> (Arc<Tracked>, Arc<Fake>) {
    let engine = Arc::new(Fake::default());
    (
        Arc::new(Tracked::new(Arc::downgrade(&f.node), engine.clone())),
        engine,
    )
}
fn summary(f: &Fixture) -> Value {
    serde_json::to_value(journal::summary(&f.node.db.lock(), &f.current).unwrap()).unwrap()
}
#[tokio::test]
async fn canceled_close_is_owned_once_and_a_new_group_needs_a_new_record() {
    let f = Fixture::new().await;
    let (b, engine) = setup(&f);
    let t = target(&f);
    b.handle(t.clone(), "status".into(), json!({}))
        .await
        .unwrap();
    b.input(t.clone(), json!({"type":"text"})).await.unwrap();
    assert_eq!(summary(&f)["groups"], 1);
    let (send, recv) = tokio::sync::oneshot::channel();
    *lock(&engine.close_gate) = Some(recv);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), b.close_session(&f.current))
            .await
            .is_err()
    );
    assert_eq!(engine.closes.load(Ordering::SeqCst), 1);
    assert_eq!(
        b.input(t.clone(), json!({})).await.unwrap_err().code,
        "browser_stop_unconfirmed"
    );
    send.send(()).unwrap();
    b.close_session(&f.current).await.unwrap();
    assert_eq!(engine.closes.load(Ordering::SeqCst), 1);
    assert_eq!(summary(&f)["observersSettled"], 1);
    b.handle(t, "status".into(), json!({})).await.unwrap();
    assert_eq!(summary(&f)["groups"], 2);
    b.close_session(&f.current).await.unwrap();
    b.shutdown().await;
    f.node.close().await;
}
#[tokio::test]
async fn journal_failure_prevents_effects_and_changed_environment_does_not_reuse_a_group() {
    let f = Fixture::new().await;
    let (b, engine) = setup(&f);
    let t = target(&f);
    f.node.db.lock().execute_batch("CREATE TRIGGER reject_browser BEFORE INSERT ON browser_groups BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(b.input(t.clone(), json!({})).await.is_err());
    assert_eq!(engine.calls.load(Ordering::SeqCst), 0);
    f.node
        .db
        .lock()
        .execute_batch("DROP TRIGGER reject_browser;")
        .unwrap();
    b.input(t.clone(), json!({})).await.unwrap();
    f.node
        .db
        .lock()
        .execute(
            "UPDATE workspaces SET canonical_path='/changed' WHERE id='repo'",
            [],
        )
        .unwrap();
    assert_eq!(
        b.input(t.clone(), json!({})).await.unwrap_err().code,
        "stale_environment"
    );
    let mut next = t;
    next.root = "/changed".into();
    assert_eq!(
        b.input(next, json!({})).await.unwrap_err().code,
        "stale_environment"
    );
    assert_eq!(engine.calls.load(Ordering::SeqCst), 1);
    b.close_session(&f.current).await.unwrap();
    f.node.close().await;
}
#[tokio::test]
async fn outcome_failure_survives_a_new_manager_and_blocks_deletion() {
    for fail_storage in [false, true] {
        let f = Fixture::new().await;
        let (b, engine) = setup(&f);
        let t = target(&f);
        b.input(t, json!({})).await.unwrap();
        if fail_storage {
            f.node.db.lock().execute_batch("CREATE TRIGGER reject_close BEFORE UPDATE OF state ON browser_groups BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        } else {
            engine.fail_close.store(true, Ordering::SeqCst);
        }
        assert_eq!(
            b.close_session(&f.current).await.unwrap_err().code,
            "browser_stop_unconfirmed"
        );
        assert_eq!(summary(&f)["unresolved"], 1);
        let (new, untouched) = setup(&f);
        assert_eq!(
            new.close_session(&f.current).await.unwrap_err().code,
            "browser_stop_unconfirmed"
        );
        assert_eq!(
            new.input(target(&f), json!({})).await.unwrap_err().code,
            "browser_stop_unconfirmed"
        );
        assert_eq!(untouched.calls.load(Ordering::SeqCst), 0);
        let file = f.dir.join("later-user-edit");
        std::fs::write(&file, b"kept").unwrap();
        let error = crate::app::delete_owned_session(
            f.node.clone(),
            f.current.clone(),
            "alice".into(),
            Arc::default(),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "browser_stop_unconfirmed");
        assert_eq!(std::fs::read(file).unwrap(), b"kept");
        f.node.close().await;
    }
}
#[tokio::test]
async fn a_transition_fence_blocks_new_browser_work_and_reports_saved_unknown_groups() {
    let f = Fixture::new().await;
    let (b, engine) = setup(&f);
    let t = target(&f);
    b.input(t.clone(), json!({})).await.unwrap();
    let lease = f
        .node
        .db
        .lock()
        .acquire_lease(&f.current, "phone", false, 60_000)
        .unwrap();
    let intent = crate::execution_fences::Intent {
        operation_id: "browser-move".into(),
        plan_hash: "a".repeat(64),
        expected_workspace_id: "repo".into(),
        expected_runner_epoch: 0,
    };
    crate::execution_fences::accept(
        &f.node.db.lock(),
        "alice",
        &f.current,
        &intent,
        "phone",
        lease.generation,
    )
    .unwrap();
    assert_eq!(
        b.input(t, json!({})).await.unwrap_err().code,
        "environment_transition_pending"
    );
    assert_eq!(engine.calls.load(Ordering::SeqCst), 1);
    // The node's actual manager has no live entry for this saved group.
    let receipt = crate::execution_fences::drain(&f.node, "alice", &f.current, "browser-move")
        .await
        .unwrap();
    assert_eq!(receipt.state, "blocked");
    assert_eq!(
        receipt.error_code.as_deref(),
        Some("browser_stop_unconfirmed")
    );
    assert!(!receipt.revocation_confirmed && !receipt.target_installed);
    b.close_session(&f.current).await.unwrap();
    let receipt = crate::execution_fences::drain(&f.node, "alice", &f.current, "browser-move")
        .await
        .unwrap();
    assert_eq!(receipt.state, "supervisor_drained");
    assert_eq!(
        serde_json::to_value(receipt.browser).unwrap()["observersSettled"],
        1
    );
    f.node.close().await;
}
#[test]
fn migration_preserves_unknown_history_and_origin_is_immutable() {
    use crate::store::Db;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("node.sqlite");
    {
        let db = Db::open(&path).unwrap();
        db.lock()
            .execute_batch(include_str!("remove_journal.sql"))
            .unwrap();
        db.lock().pragma_update(None, "user_version", 2017).unwrap();
    }
    let db = Db::open(&path).unwrap();
    let db = db.lock();
    assert_eq!(
        serde_json::to_value(journal::summary(&db, "old").unwrap()).unwrap(),
        json!({"groups":0,"observersSettled":0,"unresolved":0,"historyComplete":false})
    );
    db.execute_batch(
        "INSERT INTO browser_groups VALUES('old','s','w','/origin','previous','active',1,1);",
    )
    .unwrap();
    assert_eq!(
        journal::require_settled(&db, "s", None).unwrap_err().code,
        "browser_stop_unconfirmed"
    );
    for sql in [
        "UPDATE browser_groups SET root='/new'",
        "DELETE FROM browser_groups",
    ] {
        assert!(db.execute(sql, []).is_err());
    }
    journal::Record("old".into()).finish(&db, false).unwrap();
    assert!(journal::Record("old".into()).finish(&db, true).is_err());
}
