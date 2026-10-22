use super::*;
use crate::{
    agent::AgentOptions,
    compaction::{self, UsageContext},
    session_store::{EntryData, SessionStore},
    signal::{AbortController, AbortSignal},
    stream::StreamFn,
    tools::testing,
};
use pirc_protocol::{AssistantDelta, AssistantMessage, Usage, UserContent};
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
#[derive(Clone, Copy)]
enum Action {
    Valid,
    Invalid,
    Error,
    SwitchError,
    SwitchInvalid,
    SwitchTimeout,
    Abort,
}
struct Model {
    action: Cell<Action>,
    calls: Cell<usize>,
    agent: RefCell<Weak<Agent>>,
    signals: RefCell<Vec<AbortSignal>>,
    parent: RefCell<Option<AbortController>>,
}
impl StreamFn for Model {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        _delta: &'a mut dyn FnMut(&AssistantDelta),
    ) -> crate::LocalBoxFuture<'a, AssistantMessage> {
        Box::pin(async move {
            self.calls.set(self.calls.get() + 1);
            self.signals.borrow_mut().push(request.signal.clone());
            let agent = self.agent.borrow().upgrade().unwrap();
            let mut answer = agent.empty_assistant();
            answer.provider = request.provider_name;
            answer.model = request.model.id;
            match self.action.get() {
                Action::SwitchError | Action::SwitchInvalid | Action::SwitchTimeout => {
                    agent.set_model("fake", "other").unwrap();
                }
                Action::Abort => {
                    self.parent.borrow().as_ref().unwrap().abort();
                }
                _ => {}
            }
            match self.action.get() {
                Action::SwitchTimeout => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Action::Error | Action::SwitchError => {
                    answer.stop_reason = StopReason::Error;
                    answer.error_message = Some("429 rate limit".into());
                    return answer;
                }
                _ => {}
            }
            let text = if matches!(self.action.get(), Action::Invalid | Action::SwitchInvalid) {
                "invalid".into()
            } else {
                let Message::User {
                    content: UserContent::Text(packet),
                    ..
                } = &request.messages[0]
                else {
                    panic!()
                };
                let payload: Value = serde_json::from_str(packet).unwrap();
                let mut state: handoff::State =
                    serde_json::from_value(payload["base"]["state"].clone()).unwrap_or_default();
                if state.goal.is_empty() {
                    let source = &payload["sources"][0];
                    state.goal.push(handoff::Fact {
                        text: "Continue the requested repository task; verify historical claims."
                            .into(),
                        sources: vec![SourceRef {
                            session_id: source["sessionId"].as_str().unwrap().into(),
                            entry_id: source["entryId"].as_str().unwrap().into(),
                        }],
                    });
                }
                json!({"state":state,"resolvedConstraints":[]}).to_string()
            };
            answer.content = vec![AssistantContent::Text {
                text,
                text_signature: None,
            }];
            answer
        })
    }
}
fn make(dir: &std::path::Path, action: Action, settings: Value) -> (Rc<Agent>, Rc<Model>) {
    let mut config = testing::config(dir.to_str().unwrap(), json!({"compaction":settings}));
    config.models=serde_json::from_value(json!({"providers":{"fake":{"api":"openai-completions","baseUrl":"https://example.test","models":[{"id":"main","contextWindow":8192,"maxTokens":512},{"id":"other","contextWindow":4096,"maxTokens":512}]}},"defaultModel":{"provider":"fake","id":"main"}})).unwrap();
    let model = Rc::new(Model {
        action: Cell::new(action),
        calls: Cell::new(0),
        agent: RefCell::new(Weak::new()),
        signals: RefCell::new(vec![]),
        parent: RefCell::new(None),
    });
    let agent = Agent::new(AgentOptions {
        store: SessionStore::open(dir.join("session"), dir.to_str().unwrap()).unwrap(),
        config,
        capabilities: Default::default(),
        project_instructions: None,
        role: None,
        emit: Rc::new(|_| {}),
        ui: Rc::new(testing::TestUi::default()),
        has_ui: false,
        tools: vec![],
        features: vec![],
        acquire_write: None,
        allowed_tools: None,
        stream_override: Some(model.clone()),
    });
    *model.agent.borrow_mut() = Rc::downgrade(&agent);
    (agent, model)
}
fn seed(agent: &Agent) {
    agent
        .append_entry(EntryData::Message(Message::User {
            content: UserContent::Text("original evidence ".repeat(8000)),
            timestamp: 1,
        }))
        .unwrap();
    let mut reply = agent.empty_assistant();
    reply.content = vec![AssistantContent::Text {
        text: "Verified result".into(),
        text_signature: None,
    }];
    agent
        .append_entry(EntryData::Message(Message::Assistant(reply)))
        .unwrap();
    agent
        .append_entry(EntryData::Message(Message::User {
            content: UserContent::Text("Continue".into()),
            timestamp: 2,
        }))
        .unwrap();
}
fn settings(agent: &Agent) -> CompactionSettings {
    let mut s = agent.compaction_settings();
    s.keep_recent_tokens = 1.0;
    s.warm_cache = false;
    s
}
#[tokio::test]
async fn commits_one_atomic_snapshot_and_reopens_with_the_same_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, model) = make(dir.path(), Action::Valid, json!({}));
    seed(&agent);
    let result = run(
        &agent,
        CompactionReason::Manual,
        &AbortSignal::never(),
        None,
        &settings(&agent),
    )
    .await
    .unwrap();
    assert!(result.ok, "{:?}", result.error);
    assert!(model.calls.get() > 1);
    let raw = agent.branch();
    let snapshots = handoff::valid_snapshots(&raw);
    assert_eq!(snapshots.len(), 1);
    let h = handoff::details(snapshots[0]).unwrap();
    assert!(h.previous_snapshot_id.is_none());
    assert!(h.text_only);
    let reopened = SessionStore::open(dir.path().join("session"), "/").unwrap();
    assert_eq!(reopened.context_entries(), agent.context_entries());
    assert!(
        std::fs::read_to_string(dir.path().join("session/session.jsonl"))
            .unwrap()
            .contains("original evidence")
    );
}
#[tokio::test(start_paused = true)]
async fn model_switch_supersedes_old_errors_invalid_json_and_timeout() {
    for action in [
        Action::SwitchError,
        Action::SwitchInvalid,
        Action::SwitchTimeout,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (agent, model) = make(dir.path(), action, json!({"timeoutMs":500}));
        seed(&agent);
        let result = run(
            &agent,
            CompactionReason::Threshold,
            &AbortSignal::never(),
            None,
            &settings(&agent),
        )
        .await
        .unwrap();
        assert_eq!(result.error.as_deref(), Some("handoff_model_changed"));
        assert_eq!(model.calls.get(), 1);
        assert!(handoff::valid_snapshots(&agent.branch()).is_empty());
        if matches!(action, Action::SwitchTimeout) {
            assert!(model.signals.borrow()[0].aborted());
        }
    }
}
#[tokio::test]
async fn cancellation_wins_and_never_advances_coverage() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, model) = make(dir.path(), Action::Abort, json!({}));
    seed(&agent);
    let parent = AbortController::new();
    *model.parent.borrow_mut() = Some(parent.clone());
    let result = run(
        &agent,
        CompactionReason::Manual,
        &parent.signal(),
        None,
        &settings(&agent),
    )
    .await
    .unwrap();
    assert_eq!(result.error.as_deref(), Some("handoff_aborted"));
    assert!(handoff::valid_snapshots(&agent.branch()).is_empty());
}
#[tokio::test]
async fn retry_identity_survives_restart_and_manual_retry_stays_available() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, model) = make(dir.path(), Action::Invalid, json!({}));
    seed(&agent);
    let first = run(
        &agent,
        CompactionReason::Threshold,
        &AbortSignal::never(),
        None,
        &settings(&agent),
    )
    .await
    .unwrap();
    assert_eq!(first.error.as_deref(), Some("handoff_invalid_output"));
    let (second, second_model) = make(dir.path(), Action::Valid, json!({}));
    let retry = run(
        &second,
        CompactionReason::Threshold,
        &AbortSignal::never(),
        None,
        &settings(&second),
    )
    .await
    .unwrap();
    assert!(retry.error.unwrap().starts_with("handoff_backoff"));
    assert_eq!(second_model.calls.get(), 0);
    let explicit = run(
        &second,
        CompactionReason::Manual,
        &AbortSignal::never(),
        None,
        &settings(&second),
    )
    .await
    .unwrap();
    assert!(explicit.ok, "{:?}", explicit.error);
    assert_eq!(model.calls.get(), 1);
}
#[tokio::test]
async fn chunk_limit_failure_keeps_all_raw_context() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, _) = make(dir.path(), Action::Valid, json!({"maxChunks":1}));
    seed(&agent);
    let before = agent.context_entries();
    let result = run(
        &agent,
        CompactionReason::Manual,
        &AbortSignal::never(),
        None,
        &settings(&agent),
    )
    .await
    .unwrap();
    assert_eq!(result.error.as_deref(), Some("handoff_chunk_limit"));
    assert_eq!(before, agent.context_entries());
}
#[tokio::test]
async fn route_changes_invalidate_calibration_but_prefix_changes_preserve_scale() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, _) = make(dir.path(), Action::Error, json!({}));
    seed(&agent);
    let mut response = agent.empty_assistant();
    response.provider = "fake".into();
    response.model = "main".into();
    response.usage = Usage {
        input: 20000,
        total_tokens: 20000,
        ..crate::messages::empty_usage()
    };
    agent
        .append_entry(EntryData::Message(Message::Assistant(response.clone())))
        .unwrap();
    let route = agent.resolve_model(None).unwrap();
    *agent.usage_context.borrow_mut() = Some(UsageContext {
        message: response,
        prefix: "previous prefix".into(),
        identity: compaction::route_identity(&route),
        estimated_input: 1000,
    });
    let estimate = compaction::request_input(
        &agent,
        &agent
            .context_entries()
            .into_iter()
            .map(|(_, m)| m)
            .collect::<Vec<_>>(),
    );
    assert_eq!(compaction::input_tokens(&agent), estimate * 20);
    agent.set_model("fake", "other").unwrap();
    assert_eq!(
        compaction::input_tokens(&agent),
        compaction::request_input(
            &agent,
            &agent
                .context_entries()
                .into_iter()
                .map(|(_, m)| m)
                .collect::<Vec<_>>()
        )
    );
}
