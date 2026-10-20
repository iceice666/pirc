//! The brain's host profile (plans/rewrite/02-brain-host.md).

use std::cell::RefCell;
use std::rc::Rc;

use pirc_protocol::{AssistantDelta, AssistantMessage, Models, StopReason};
use serde_json::{Value, json};

use super::*;
use crate::host::{HostProfile, ModelCatalog};
use crate::stream::StreamRequest;
use crate::tools::testing::{self, TestUi};

/// What one model call was given.
struct Asked {
    system_prompt: String,
    tools: Vec<String>,
    messages: Value,
}

/// Answers "ok" and records each request.
#[derive(Default)]
struct Recording {
    asked: RefCell<Vec<Asked>>,
}

impl StreamFn for Recording {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        _on_delta: &'a mut dyn FnMut(&AssistantDelta),
    ) -> LocalBoxFuture<'a, AssistantMessage> {
        self.asked.borrow_mut().push(Asked {
            system_prompt: request.system_prompt.clone(),
            tools: request.tools.iter().map(|tool| tool.name.clone()).collect(),
            messages: serde_json::to_value(&request.messages).unwrap(),
        });
        Box::pin(async move {
            AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: "ok".to_owned(),
                    text_signature: None,
                }],
                api: "openai-completions".to_owned(),
                provider: request.provider_name,
                model: request.model.id,
                usage: empty_usage(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: now_ms(),
                completed_at: None,
                canonical_provider: None,
                response_id: None,
                response_model: None,
            }
        })
    }
}

fn catalog() -> Models {
    serde_json::from_value(json!({
        "providers": { "fake": { "api": "openai-completions", "baseUrl": "https://gateway.invalid",
            "models": [{ "id": "fake-model", "contextWindow": 100000, "maxTokens": 1000 }] } },
        "defaultModel": { "provider": "fake", "id": "fake-model" },
    }))
    .unwrap()
}

struct Fixed(RefCell<Option<Models>>);

impl ModelCatalog for Fixed {
    fn models(&self) -> Option<Models> {
        self.0.borrow().clone()
    }
}

/// A tool the brain might have.
struct Search;

impl Tool for Search {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "Search the web."
    }
    fn parameters(&self) -> &Map<String, Value> {
        static PARAMETERS: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        PARAMETERS.get_or_init(|| testing::args(json!({ "type": "object", "properties": {} })))
    }
    fn execute<'a>(
        &'a self,
        _args: Map<String, Value>,
        _ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(async { Ok(ToolResult::text("nothing")) })
    }
}

fn brain(
    dir: &std::path::Path,
    host: HostProfile,
    features: Vec<Rc<dyn Feature>>,
) -> (Rc<Agent>, Rc<Recording>, Rc<Fixed>) {
    let home = dir.join("brain");
    std::fs::create_dir_all(&home).unwrap();
    let mut config = testing::config(&home.display().to_string(), json!({}));
    config.system_prompt = vec![PromptSection::new("base", "Base", "test", "Base prompt.")];
    let store = SessionStore::open(dir.join("room"), &config.workspace).unwrap();
    let model = Rc::new(Recording::default());
    let models = Rc::new(Fixed(RefCell::new(Some(catalog()))));
    let agent = Agent::new(AgentOptions {
        config,
        role: None,
        store,
        emit: Rc::new(|_| {}),
        ui: Rc::new(TestUi::default()),
        has_ui: false,
        tools: vec![Rc::new(Search)],
        features,
        acquire_write: None,
        allowed_tools: None,
        stream: Some(model.clone()),
        models: Some(models.clone()),
        host,
    });
    (agent, model, models)
}

#[tokio::test]
async fn the_brain_calls_its_tools_directly_without_a_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (agent, model, _) = brain(dir.path(), HostProfile::Brain, Vec::new());
            agent.refresh_models().await;
            agent.say("hello".to_owned(), Vec::new());
            agent.idle().await;
            {
                let asked = model.asked.borrow();
                assert_eq!(asked[0].tools, ["web_search"]);
                assert_eq!(asked[0].system_prompt, "Base prompt.");
            }

            // A worker has the scripts too, and a working directory.
            let worker = tempfile::tempdir().unwrap();
            let (agent, model, _) = brain(worker.path(), HostProfile::worker(), Vec::new());
            agent.refresh_models().await;
            agent.say("hello".to_owned(), Vec::new());
            agent.idle().await;
            let asked = model.asked.borrow();
            assert_eq!(asked[0].tools, ["ptc", "ptc_docs", "web_search"]);
            assert!(
                asked[0]
                    .system_prompt
                    .contains("Current working directory:")
            );
        })
        .await;
}

#[tokio::test]
async fn the_base_prompt_is_replaced_for_the_next_call() {
    let dir = tempfile::tempdir().unwrap();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (agent, model, _) = brain(dir.path(), HostProfile::Brain, Vec::new());
            agent.refresh_models().await;
            agent.say("one".to_owned(), Vec::new());
            agent.idle().await;
            agent.set_base_prompt(vec![PromptSection::new(
                "soul",
                "Soul",
                "brain",
                "A new soul.",
            )]);
            agent.say("two".to_owned(), Vec::new());
            agent.idle().await;
            let asked = model.asked.borrow();
            assert_eq!(asked[0].system_prompt, "Base prompt.");
            assert_eq!(asked[1].system_prompt, "A new soul.");
        })
        .await;
}

#[tokio::test]
async fn words_in_a_room_are_never_commands() {
    let dir = tempfile::tempdir().unwrap();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let features = vec![crate::features::compact::feature()];
            let (agent, model, _) = brain(dir.path(), HostProfile::Brain, features);
            agent.refresh_models().await;
            agent.say("/compact please".to_owned(), Vec::new());
            agent.idle().await;
            let asked = model.asked.borrow();
            assert_eq!(asked.len(), 1);
            assert!(asked[0].messages.to_string().contains("/compact please"));
        })
        .await;
}

#[tokio::test]
async fn models_come_from_the_injected_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (agent, _, models) = brain(dir.path(), HostProfile::Brain, Vec::new());
            assert!(
                agent.resolve_model(None).is_err(),
                "nothing before a refresh"
            );
            agent.refresh_models().await;
            assert_eq!(agent.resolve_model(None).unwrap().provider_name, "fake");
            // A host without an answer keeps what the agent has.
            *models.0.borrow_mut() = None;
            agent.refresh_models().await;
            assert_eq!(agent.resolve_model(None).unwrap().model.id, "fake-model");
        })
        .await;
}
