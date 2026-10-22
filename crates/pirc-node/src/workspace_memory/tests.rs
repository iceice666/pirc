use super::*;
use crate::services::Services;
use pirc_agent::session_store::SessionStore;
use pirc_config::{Env, NodeConfig};
use pirc_protocol::{AssistantMessage, NodeRole, UserContent};
struct Fixture {
    _dir: tempfile::TempDir,
    node: Node,
    current: String,
    mode: pirc_protocol::Mode,
    scope: Scope,
    dir: PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("pirc-w-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temp.path().canonicalize().unwrap();
        for d in ["repo", "state", "config", "home"] {
            std::fs::create_dir(root.join(d)).unwrap();
        }
        let vars: Vec<(String, String)> = vec![
            ("PIRC_NODE_ID".into(), "memory-test".into()),
            (
                "PIRC_NODE_TOKEN".into(),
                "0123456789abcdef0123456789abcdef".into(),
            ),
            ("PIRC_DAEMON_URL".into(), "ws://127.0.0.1:8787".into()),
            (
                "PIRC_STATE_DIR".into(),
                root.join("state").to_string_lossy().into_owned(),
            ),
            (
                "PIRC_CONFIG_DIR".into(),
                root.join("config").to_string_lossy().into_owned(),
            ),
            (
                "HOME".into(),
                root.join("home").to_string_lossy().into_owned(),
            ),
            ("PIRC_BROWSER".into(), "false".into()),
            ("PIRC_ALLOWED_USERS".into(), "alice".into()),
            (
                "PIRC_SANDBOX_SRT".into(),
                "/missing-memory-test-sandbox".into(),
            ),
            (
                "PIRC_WORKSPACES".into(),
                json!([{"id":"repo","path":root.join("repo")}]).to_string(),
            ),
        ];
        let env = Env::new(vars.iter().map(|(k, v)| (k.as_str(), v.as_str())), &root);
        let config = NodeConfig::load(&env, NodeRole::Node).unwrap();
        let node = Services::start(config, env).await.unwrap();
        let mode = pirc_protocol::mode::default_work();
        node.modes.write().unwrap().insert(
            pirc_protocol::mode::ModeId::new("directory").unwrap(),
            mode.clone(),
        );
        let dir = root.join("source");
        std::fs::create_dir(&dir).unwrap();
        SessionStore::open(dir.clone(), root.join("repo").to_str().unwrap()).unwrap();
        let row = node
            .db
            .lock()
            .create_session("repo", dir.to_str().unwrap(), "alice")
            .unwrap();
        let scope = scope(&node, &row.id, &mode, 0, true).unwrap();
        Self {
            _dir: temp,
            node,
            current: row.id,
            mode,
            scope,
            dir,
        }
    }
    fn view(&self) -> View {
        View::new(&self.node, &self.scope, true).unwrap()
    }
    fn context(&self) -> Value {
        execute(&self.view(), "workspace.context", &json!({})).unwrap()
    }
    fn mutate(&self, op: &str, extra: Value) -> ApiResult<Value> {
        let context = self.context();
        let mut args = json!({"jobId":format!("job_{}",crate::util::uuid()),"epoch":context["control"]["epoch"],"generation":context["control"]["generation"],"revision":context["control"]["revision"].as_u64().unwrap_or(0),"boundaries":context["boundaries"],"writersStopped":true});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        execute(&self.view(), op, &args)
    }
    fn turn(&self, text: &str) {
        let mut store = SessionStore::open(self.dir.clone(), "/").unwrap();
        store
            .append(EntryData::Message(Message::User {
                content: UserContent::Text(text.into()),
                timestamp: 1,
            }))
            .unwrap();
        let a:AssistantMessage=serde_json::from_value(json!({"role":"assistant","content":[{"type":"text","text":"Verified"}],"api":"openai-completions","provider":"fake","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"stop","timestamp":1})).unwrap();
        store
            .append(EntryData::Message(Message::Assistant(a)))
            .unwrap();
    }
    fn commit(&self, empty: bool) -> Value {
        let job = execute(&self.view(), "workspace.next", &json!({})).unwrap();
        assert!(!job.is_null());
        let source = &job["sources"][0];
        let mut args = job.as_object().unwrap().clone();
        args.remove("control");
        args.remove("sources");
        for k in ["epoch", "generation", "revision"] {
            args.insert(k.into(), job["control"][k].clone());
        }
        args.insert("items".into(),if empty{json!([])}else{json!([{"content":"Use SQLite for repository state","sources":[{"sessionId":source["sessionId"],"entryId":source["entryId"]}]}])});
        let args = Value::Object(args);
        execute(&self.view(), "workspace.commit", &args).unwrap();
        args
    }
}
#[tokio::test]
async fn cold_cutover_empty_receipt_clear_and_ack_proof_do_not_claim_unprocessed_sources() {
    let f = Fixture::new().await;
    f.turn("Old backlog");
    assert!(f.context()["legacy"].as_bool().unwrap());
    assert_eq!(
        execute(&f.view(), "workspace.next", &json!({}))
            .unwrap_err()
            .code,
        "workspace_cold_cutover_required"
    );
    f.mutate("workspace.cold", json!({})).unwrap();
    assert!(
        execute(&f.view(), "workspace.next", &json!({}))
            .unwrap()
            .is_null()
    );
    f.turn("New empty interaction");
    f.commit(true);
    assert!(f.context()["items"].as_array().unwrap().is_empty());
    assert_eq!(f.context()["control"]["receipts"][0]["outcome"], "empty");
    f.turn("We use SQLite");
    f.commit(false);
    let c = f.context();
    assert_eq!(c["items"].as_array().unwrap().len(), 1);
    let args = json!({"jobId":"clear_ack","epoch":c["control"]["epoch"],"generation":c["control"]["generation"],"revision":c["control"]["revision"],"boundaries":c["boundaries"]});
    execute(&f.view(), "workspace.clear", &args).unwrap();
    let proof = execute(
        &f.view(),
        "workspace.context",
        &json!({"pendingJobs":[args]}),
    )
    .unwrap();
    assert_eq!(proof["jobs"][0]["proof"]["status"], "committed");
    assert!(proof["items"].as_array().unwrap().is_empty());
    assert!(
        execute(&f.view(), "workspace.next", &json!({}))
            .unwrap()
            .is_null()
    );
    f.node.close().await;
}
#[tokio::test]
async fn source_permission_and_deletion_changes_invalidate_captured_views() {
    let f = Fixture::new().await;
    f.mutate("workspace.cold", json!({})).unwrap();
    f.turn("Source");
    let mut view = f.view();
    execute(&view, "workspace.next", &json!({})).unwrap();
    f.node
        .db
        .lock()
        .execute(
            "UPDATE sessions SET owner_user='bob' WHERE id=?",
            [&f.current],
        )
        .unwrap();
    assert_eq!(view.revalidate(true).unwrap_err().code, "forbidden");
    assert!(scope(&f.node, &f.current, &f.mode, 1, true).is_err());
    let mut chat = f.mode.clone();
    chat.workspace_memory = false;
    assert!(scope(&f.node, &f.current, &chat, 0, true).is_err());
    f.node.close().await;
}
#[tokio::test]
async fn view_pages_survive_empty_receipts_but_not_inventory_changes() {
    let f = Fixture::new().await;
    f.mutate("workspace.cold", json!({})).unwrap();
    f.turn("Original");
    f.commit(false);
    let v = execute(&f.view(), "workspace.context", &json!({"view":true})).unwrap();
    let fingerprint =
        pirc_agent::journal::digest(serde_json::to_string(&v["items"]).unwrap().as_bytes());
    f.turn("Nothing durable");
    f.commit(true);
    let next = execute(
        &f.view(),
        "workspace.context",
        &json!({"view":true,"cursor":{"fingerprint":fingerprint,"offset":0}}),
    )
    .unwrap();
    assert_eq!(next["items"], v["items"]);
    let id = next["items"][0]["id"].clone();
    f.mutate("workspace.forget", json!({"id":id})).unwrap();
    assert_eq!(
        execute(
            &f.view(),
            "workspace.context",
            &json!({"view":true,"cursor":{"fingerprint":fingerprint,"offset":0}})
        )
        .unwrap_err()
        .code,
        "workspace_view_changed"
    );
    f.node.close().await;
}
#[test]
fn restored_or_equal_length_ledgers_cannot_cross_an_acknowledged_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger");
    let raw = b"{\"type\":\"cleared\",\"at\":1}\n";
    std::fs::write(&path, raw).unwrap();
    let state = journal::parse(raw).unwrap();
    let remote =
        json!({"version":2,"watermark":raw.len(),"digest":pirc_agent::journal::digest(raw)});
    assert!(mirror_check(&state, &remote, &path).is_ok());
    let replacement = b"{\"type\":\"cleared\",\"at\":2}\n";
    std::fs::write(&path, replacement).unwrap();
    assert_eq!(
        mirror_check(&journal::parse(replacement).unwrap(), &remote, &path)
            .unwrap_err()
            .code,
        "mirror_rollback"
    );
    assert_eq!(
        mirror_check(&journal::parse(&[]).unwrap(), &remote, &path)
            .unwrap_err()
            .code,
        "mirror_rollback"
    );
}

#[tokio::test]
async fn cold_marker_blocks_restored_legacy_before_any_mirror_ack() {
    let f = Fixture::new().await;
    f.mutate("workspace.cold", json!({})).unwrap();
    let path = ledger(&f.node, &f.scope);
    assert!(path.with_extension("lock").is_dir());
    std::fs::write(&path, b"{\"type\":\"cleared\",\"at\":1}\n").unwrap();
    assert_eq!(
        execute(&f.view(), "workspace.context", &json!({}))
            .unwrap_err()
            .code,
        "workspace_versioned_ledger_missing"
    );
    let c = execute(
        &f.view(),
        "workspace.context",
        &json!({"preparingCutover":true}),
    )
    .unwrap();
    assert!(c["items"].as_array().unwrap().is_empty());
    let args = json!({"jobId":"retry_cold","writersStopped":true});
    execute(&f.view(), "workspace.cold", &args).unwrap();
    assert!(!f.context()["legacy"].as_bool().unwrap());
    f.node.close().await;
}

#[tokio::test]
async fn another_session_reads_committed_work_and_clear_rejects_invented_cutoffs() {
    let mut f = Fixture::new().await;
    f.mutate("workspace.cold", json!({})).unwrap();
    f.turn("Use SQLite for repository state");
    f.commit(false);
    let second = f._dir.path().join("second");
    std::fs::create_dir(&second).unwrap();
    SessionStore::open(second.clone(), "/").unwrap();
    let row = f
        .node
        .db
        .lock()
        .create_session("repo", second.to_str().unwrap(), "alice")
        .unwrap();
    f.scope = scope(&f.node, &row.id, &f.mode, 0, true).unwrap();
    assert_eq!(f.context()["items"].as_array().unwrap().len(), 1);
    // B processes A's next raw interaction without starting A's runner.
    assert!(f.node.runners.get(&f.current).is_none());
    f.turn("A complete later interaction from the original session");
    f.commit(true);
    assert!(
        execute(&f.view(), "workspace.next", &json!({}))
            .unwrap()
            .is_null()
    );
    assert_eq!(
        f.mutate("workspace.clear", json!({"boundaries":[]}))
            .unwrap_err()
            .code,
        "workspace_source_changed"
    );
    let mut invalid = f.context()["boundaries"].clone();
    invalid[0]["afterEntryId"] = json!("not-an-original-source");
    assert_eq!(
        f.mutate("workspace.clear", json!({"boundaries":invalid}))
            .unwrap_err()
            .code,
        "workspace_source_changed"
    );
    assert_eq!(f.context()["items"].as_array().unwrap().len(), 1);
    let mut ack_view = f.view();
    public_control(&ack_view, &ack_view.state).unwrap();
    f.node
        .db
        .lock()
        .execute(
            "UPDATE sessions SET owner_user='bob' WHERE id=?",
            [&f.current],
        )
        .unwrap();
    assert!(ack_view.revalidate(true).is_err());
    assert!(f.context()["items"].as_array().unwrap().is_empty());
    f.node.close().await;
}

#[tokio::test]
async fn forgotten_interaction_stays_suppressed_after_assistant_continuation_and_catchup() {
    let f = Fixture::new().await;
    f.mutate("workspace.cold", json!({})).unwrap();
    f.turn("Use SQLite for repository state");
    f.commit(false);
    let id = f.context()["items"][0]["id"].clone();
    f.mutate("workspace.forget", json!({"id":id})).unwrap();
    let mut store = SessionStore::open(f.dir.clone(), "/").unwrap();
    let continued = store.branch().last().unwrap().data.clone();
    assert!(matches!(
        continued,
        EntryData::Message(Message::Assistant(_))
    ));
    store.append(continued).unwrap();
    drop(store);
    assert!(
        execute(&f.view(), "workspace.next", &json!({}))
            .unwrap()
            .is_null()
    );
    f.mutate("workspace.clear", json!({})).unwrap();
    assert!(
        execute(&f.view(), "workspace.next", &json!({"catchup":true}))
            .unwrap()
            .is_null()
    );
    assert!(f.context()["items"].as_array().unwrap().is_empty());
    f.node.close().await;
}
