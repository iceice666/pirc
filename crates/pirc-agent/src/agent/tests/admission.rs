//! First-message acknowledgements exercise the real Agent and RPC dispatcher.
use super::*;

struct BeforeStartGate {
    entered: Rc<Notify>,
    release: Rc<Notify>,
    fail: bool,
}
impl Feature for BeforeStartGate {
    fn name(&self) -> &'static str {
        "admission-gate"
    }
    fn before_agent_start<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            if self.fail {
                Err("startup refused".into())
            } else {
                Ok(None)
            }
        })
    }
}

fn config(dir: &std::path::Path) -> AgentConfig {
    crate::tools::testing::config(&dir.display().to_string(), json!({}))
}
fn gate(run: &mut ScriptedRun, fail: bool) -> (Rc<Notify>, Rc<Notify>) {
    let entered = Rc::new(Notify::new());
    let release = Rc::new(Notify::new());
    run.features.push(Rc::new(BeforeStartGate {
        entered: entered.clone(),
        release: release.clone(),
        fail,
    }));
    (entered, release)
}
async fn input(agent: &Rc<Agent>, kind: &str) -> Result<Option<Value>, String> {
    crate::rpc::handle_command(agent, &json!({"type":kind,"message":"first message"})).await
}
async fn idle(agent: &Agent) {
    tokio::time::timeout(Duration::from_secs(2), agent.idle())
        .await
        .unwrap();
}

#[tokio::test]
async fn admission_ack_waits_for_deferred_start_and_persisted_user_message() {
    tokio::task::LocalSet::new().run_until(async {
        let dir = tempfile::tempdir().unwrap();
        let mut run = ScriptedRun::new(vec![(vec![AssistantContent::Text { text: "done".into(), text_signature: None }], StopReason::Stop)]);
        let (entered, release) = gate(&mut run, false);
        let agent = run.agent(dir.path(), config(dir.path()));
        let task = { let agent = agent.clone(); tokio::task::spawn_local(async move { input(&agent,"prompt").await }) };
        entered.notified().await;
        assert!(!task.is_finished());
        assert!(agent.all_messages().is_empty());
        assert!(run.stream.requests.borrow().is_empty());
        release.notify_one();
        assert!(task.await.unwrap().is_ok());
        let reopened = SessionStore::open(dir.path().join("session"), &agent.config.workspace).unwrap();
        assert!(matches!(reopened.all_messages().first(), Some(Message::User{ content: UserContent::Text(text), .. }) if text == "first message"));
        idle(&agent).await;
        assert_eq!(run.stream.requests.borrow().len(), 1);
    }).await;
}

#[tokio::test]
async fn admission_failure_on_stale_storage_never_infers_from_old_history() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for kind in ["prompt", "steer", "follow_up"] {
                for deferred in [false, true] {
                    let dir = tempfile::tempdir().unwrap();
                    let mut run = ScriptedRun::new(vec![]);
                    let gates = deferred.then(|| gate(&mut run, false));
                    let agent = run.agent(dir.path(), config(dir.path()));
                    agent
                        .append_message(Message::User {
                            content: UserContent::Text("old history".into()),
                            timestamp: 1,
                        })
                        .unwrap();
                    let path = dir.path().join("session/session.jsonl");
                    let mut disk = std::fs::read(&path).unwrap();
                    disk.push(b'\n');
                    std::fs::write(&path, &disk).unwrap();
                    let task = {
                        let agent = agent.clone();
                        tokio::task::spawn_local(async move { input(&agent, kind).await })
                    };
                    if let Some((entered, release)) = gates {
                        entered.notified().await;
                        assert!(!task.is_finished());
                        release.notify_one();
                    }
                    let error = task.await.unwrap().unwrap_err();
                    assert_eq!(error, ADMISSION_OUTCOME_UNKNOWN);
                    let response = crate::rpc::response(&json!({"type":kind}), Err(error));
                    assert_eq!(response["success"], false);
                    assert_eq!(response["errorCode"], "admission_outcome_unknown");
                    idle(&agent).await;
                    assert!(run.stream.requests.borrow().is_empty());
                    assert_eq!(agent.all_messages().len(), 1);
                    assert_eq!(std::fs::read(&path).unwrap(), disk);
                }
            }
        })
        .await;
}

#[tokio::test]
async fn admission_refused_by_feature_stops_before_inference() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let mut run = ScriptedRun::new(vec![]);
            let (entered, release) = gate(&mut run, true);
            let agent = run.agent(dir.path(), config(dir.path()));
            agent
                .append_message(Message::User {
                    content: UserContent::Text("old history".into()),
                    timestamp: 1,
                })
                .unwrap();
            let task = {
                let agent = agent.clone();
                tokio::task::spawn_local(async move { input(&agent, "prompt").await })
            };
            entered.notified().await;
            release.notify_one();
            assert_eq!(task.await.unwrap().unwrap_err(), ADMISSION_OUTCOME_UNKNOWN);
            idle(&agent).await;
            assert!(!agent.store.borrow().write_failed());
            assert_eq!(agent.all_messages().len(), 1);
            assert!(run.stream.requests.borrow().is_empty());
        })
        .await;
}

#[tokio::test]
async fn admission_wait_can_be_stopped_without_releasing_the_startup_gate() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let mut run = ScriptedRun::new(vec![]);
            let (entered, _release) = gate(&mut run, false);
            let agent = run.agent(dir.path(), config(dir.path()));
            let task = {
                let agent = agent.clone();
                tokio::task::spawn_local(async move { input(&agent, "prompt").await })
            };
            entered.notified().await;
            tokio::time::timeout(
                Duration::from_secs(2),
                crate::rpc::handle_command(&agent, &json!({"type":"abort"})),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(task.await.unwrap().unwrap_err(), ADMISSION_OUTCOME_UNKNOWN);
            assert!(agent.all_messages().is_empty());
            assert!(run.stream.requests.borrow().is_empty());
        })
        .await;
}

#[tokio::test]
async fn concurrent_prompt_is_rejected_without_stealing_the_first_receipt() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let mut run = ScriptedRun::new(vec![(
                vec![AssistantContent::Text {
                    text: "done".into(),
                    text_signature: None,
                }],
                StopReason::Stop,
            )]);
            let (entered, release) = gate(&mut run, false);
            let agent = run.agent(dir.path(), config(dir.path()));
            let task = {
                let agent = agent.clone();
                tokio::task::spawn_local(async move { input(&agent, "prompt").await })
            };
            entered.notified().await;
            let error = input(&agent, "prompt").await.unwrap_err();
            assert!(error.starts_with("Agent is already running"));
            assert!(!task.is_finished());
            release.notify_one();
            assert!(task.await.unwrap().is_ok());
            idle(&agent).await;
            assert_eq!(
                agent
                    .all_messages()
                    .iter()
                    .filter(|m| matches!(m, Message::User { .. }))
                    .count(),
                1
            );
        })
        .await;
}

struct HiddenContext;
impl Feature for HiddenContext {
    fn name(&self) -> &'static str {
        "admission-context"
    }
    fn before_agent_start<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async {
            Ok(Some(BeforeStart {
                system_prompt: None,
                messages: vec![Message::Custom {
                    custom_type: "test-context".into(),
                    content: "context".into(),
                    display: false,
                    details: None,
                    timestamp: 2,
                }],
            }))
        })
    }
}

#[tokio::test]
async fn admission_partly_persisted_is_unknown_not_rejected_or_repeated() {
    tokio::task::LocalSet::new().run_until(async {
        let dir = tempfile::tempdir().unwrap();
        let mut run = ScriptedRun::new(vec![]);
        run.features.push(Rc::new(HiddenContext));
        let file = dir.path().join("session/session.jsonl");
        // After the user's durable message, disturb the journal before hidden
        // context is appended. The first append succeeded; retrying is unsafe.
        let writer = file.clone();
        let emit = Rc::new(move |event:Value| {
            if event["type"] == "message_end" && event["message"]["role"] == "user" {
                let mut raw = std::fs::read(&writer).unwrap(); raw.push(b'\n');
                std::fs::write(&writer,raw).unwrap();
            }
        });
        let agent = run.agent_with_emitter(dir.path(),config(dir.path()),Some(emit));
        assert_eq!(input(&agent,"prompt").await.unwrap_err(),ADMISSION_OUTCOME_UNKNOWN);
        idle(&agent).await;
        assert!(run.stream.requests.borrow().is_empty());
        assert_eq!(agent.all_messages().len(),1);
        let reopened = SessionStore::open(dir.path().join("session"),&agent.config.workspace).unwrap();
        assert_eq!(reopened.all_messages().len(),1);
        assert!(matches!(reopened.all_messages().first(),Some(Message::User { content:UserContent::Text(text),.. }) if text == "first message"));
    }).await;
}

#[tokio::test]
async fn admission_cancel_kills_the_before_prompt_hook_and_its_child() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let run = ScriptedRun::new(vec![]);
            let mut settings = config(dir.path());
            settings
                .hooks
                .before_prompt
                .push(crate::config::HookConfig {
                    command: "sleep 30 & echo $! > child.pid; wait".into(),
                    matcher: None,
                    timeout_ms: 60_000,
                });
            let agent = run.agent(dir.path(), settings);
            let task = {
                let agent = agent.clone();
                tokio::task::spawn_local(async move { input(&agent, "prompt").await })
            };
            let pid_file = dir.path().join("child.pid");
            let pid: i32 = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(&pid_file)
                        && let Ok(pid) = text.trim().parse::<i32>()
                    {
                        break pid;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(!task.is_finished());
            agent.abort();
            idle(&agent).await;
            assert_eq!(task.await.unwrap().unwrap_err(), ADMISSION_OUTCOME_UNKNOWN);
            assert!(agent.all_messages().is_empty());
            assert!(run.stream.requests.borrow().is_empty());
            tokio::time::timeout(Duration::from_secs(2), async {
                while nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
                    != Err(nix::errno::Errno::ESRCH)
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("hook child outlived the cancelled admission");
        })
        .await;
}
