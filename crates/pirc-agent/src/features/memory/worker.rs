//! Memory sub-agents (`features/memory/worker.ts`): model choice with
//! rate-limit cooldowns, and a minimal tool loop through the agent's
//! stream function.

use indexmap::IndexMap;
use pirc_protocol::{
    AssistantContent, Message, StopReason, ThinkingLevel, ToolSpec, UserBlock, UserContent,
};
use serde_json::{Map, Value};

use super::config::ModelChoice;
use crate::agent::{Agent, ResolvedModel};
use crate::now_ms;
use crate::signal::AbortSignal;
use crate::stream::StreamRequest;
use crate::tools::js::js_regex;
use crate::ui::NotifyLevel;

/// `RateLimitTracker`: per-process cooldowns for rate-limited memory
/// models.
pub struct RateLimitTracker {
    until: IndexMap<String, u64>,
}

impl RateLimitTracker {
    pub fn new() -> Self {
        Self {
            until: IndexMap::new(),
        }
    }

    pub fn cooling(&mut self, key: &str) -> bool {
        let Some(&until) = self.until.get(key) else {
            return false;
        };
        if until > now_ms() {
            return true;
        }
        self.until.shift_remove(key);
        false
    }

    /// Start a cooldown of `cooldown_ms` when `message` reads as a rate
    /// limit.
    pub fn note_error(&mut self, key: &str, message: Option<&str>, cooldown_ms: u64) -> bool {
        let rate_limit = js_regex!(
            r"(?:^|[^\d])429(?:[^\d]|$)|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|quota|resource[\s_-]?exhausted|overloaded",
            "i"
        );
        match message {
            Some(message) if !message.is_empty() && rate_limit.test(message) => {
                self.until.insert(key.to_owned(), now_ms() + cooldown_ms);
                true
            }
            _ => false,
        }
    }

    /// Models still cooling, with the time they are ready again.
    pub fn entries(&self) -> Vec<(String, u64)> {
        let now = now_ms();
        self.until
            .iter()
            .filter(|(_, until)| **until > now)
            .map(|(key, until)| (key.clone(), *until))
            .collect()
    }
}

impl Default for RateLimitTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// `WorkerModel`.
#[derive(Clone)]
pub struct WorkerModel {
    pub key: String,
    pub resolved: ResolvedModel,
    pub thinking: ThinkingLevel,
}

/// Why no memory model was picked.
#[derive(Debug, PartialEq, Eq)]
pub enum PickError {
    /// Nothing resolves (not even the session model).
    NoModel,
    /// `missingModelPolicy: 'error'` and a configured model does not
    /// resolve: a configuration error, not rate limiting.
    Missing(String),
}

impl std::fmt::Display for PickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoModel => f.write_str("no model available"),
            Self::Missing(key) => write!(
                f,
                "model {key} is not configured on the gateway (missingModelPolicy is \"error\", so the session model is not used); fix features.observationalMemory or the gateway's models"
            ),
        }
    }
}

/// `pickModel`: the preferred model, then the fallbacks; cooling ones are
/// skipped unless all are. `Err` when none resolves, or, with `strict`
/// (`missingModelPolicy: 'error'`), as soon as any configured model does
/// not: checked before the session model is considered, so no inference
/// runs on a model the user did not choose.
pub fn pick_model(
    agent: &Agent,
    preferred: Option<&ModelChoice>,
    fallbacks: &[ModelChoice],
    strict: bool,
    tracker: &mut RateLimitTracker,
) -> Result<WorkerModel, PickError> {
    if strict {
        for choice in preferred.into_iter().chain(fallbacks) {
            if agent
                .resolve_model(Some((choice.provider.clone(), choice.id.clone())))
                .is_err()
            {
                return Err(PickError::Missing(format!(
                    "{}/{}",
                    choice.provider, choice.id
                )));
            }
        }
    }
    let mut candidates: Vec<WorkerModel> = Vec::new();
    let add = |candidates: &mut Vec<WorkerModel>,
               choice: Option<&ModelChoice>,
               thinking: ThinkingLevel| {
        let reference = choice.map(|c| (c.provider.clone(), c.id.clone()));
        let Ok(resolved) = agent.resolve_model(reference) else {
            return;
        };
        let key = format!("{}/{}", resolved.provider_name, resolved.model.id);
        if candidates.iter().any(|candidate| candidate.key == key) {
            return;
        }
        candidates.push(WorkerModel {
            key,
            resolved,
            thinking,
        });
    };
    match preferred {
        Some(preferred) => {
            add(
                &mut candidates,
                Some(preferred),
                preferred.thinking.unwrap_or(ThinkingLevel::Low),
            );
            if candidates.is_empty() {
                agent.ui().notify(
                    &format!(
                        "Observational memory: model {}/{} not found; using the session model",
                        preferred.provider, preferred.id
                    ),
                    NotifyLevel::Warning,
                );
                add(&mut candidates, None, ThinkingLevel::Low);
            }
        }
        None => add(&mut candidates, None, ThinkingLevel::Low),
    }
    for fallback in fallbacks {
        let thinking = fallback
            .thinking
            .or(preferred.and_then(|p| p.thinking))
            .unwrap_or(ThinkingLevel::Low);
        add(&mut candidates, Some(fallback), thinking);
    }
    if candidates.is_empty() {
        return Err(PickError::NoModel);
    }
    // Keys were resolved by the gateway; a provider without one is still tried (keyless endpoints).
    let ready = candidates
        .iter()
        .position(|candidate| !tracker.cooling(&candidate.key))
        .unwrap_or(0);
    Ok(candidates.swap_remove(ready))
}

/// `WorkerTool`: the one tool of a memory sub-agent.
pub trait WorkerTool {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn parameters(&self) -> Value;
    /// The receipt shown to the model.
    fn execute(&mut self, args: &Map<String, Value>) -> String;
}

/// `runWorker`'s options.
pub struct WorkerRun<'a> {
    pub model: &'a WorkerModel,
    pub system_prompt: &'a str,
    pub prompt: String,
    pub max_turns: u64,
    pub max_tokens: u64,
    pub signal: AbortSignal,
    pub cooldown_ms: u64,
}

/// `runWorker`: sequential tool execution; stops when the model replies
/// without tool calls or after `max_turns`. `Err` is `{error}`.
pub async fn run_worker(
    agent: &Agent,
    tracker: &std::cell::RefCell<RateLimitTracker>,
    options: WorkerRun<'_>,
    tool: &mut dyn WorkerTool,
) -> Result<(), String> {
    let resolved = &options.model.resolved;
    let stream = agent.stream_function();
    let mut messages = vec![Message::User {
        content: UserContent::Text(options.prompt.clone()),
        timestamp: now_ms(),
    }];
    let Value::Object(parameters) = tool.parameters() else {
        unreachable!("tool parameters are an object")
    };
    let session_id = agent.state()["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for _ in 0..options.max_turns {
        if options.signal.aborted() {
            return Err("aborted".to_owned());
        }
        let request = StreamRequest {
            provider_name: resolved.provider_name.clone(),
            provider: resolved.provider.clone(),
            model: resolved.model.clone(),
            system_prompt: options.system_prompt.to_owned(),
            messages: messages.clone(),
            tools: vec![ToolSpec {
                name: tool.name().to_owned(),
                description: tool.description().to_owned(),
                parameters: parameters.clone(),
            }],
            thinking: if resolved.model.reasoning {
                options.model.thinking
            } else {
                ThinkingLevel::Off
            },
            session_id: format!("{session_id}-memory"),
            signal: options.signal.clone(),
            max_tokens: Some(resolved.model.max_tokens.min(options.max_tokens)),
            tool_choice: None,
        };
        let mut ignore = |_: &pirc_protocol::AssistantDelta| {};
        let reply = stream.stream(request, &mut ignore).await;
        if matches!(reply.stop_reason, StopReason::Error | StopReason::Aborted) {
            tracker.borrow_mut().note_error(
                &options.model.key,
                reply.error_message.as_deref(),
                options.cooldown_ms,
            );
            return Err(reply.error_message.clone().unwrap_or_else(|| {
                if reply.stop_reason == StopReason::Error {
                    "error"
                } else {
                    "aborted"
                }
                .to_owned()
            }));
        }
        let calls: Vec<(String, String, Map<String, Value>)> = reply
            .content
            .iter()
            .filter_map(|part| match part {
                AssistantContent::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } => Some((id.clone(), name.clone(), arguments.clone())),
                _ => None,
            })
            .collect();
        messages.push(Message::Assistant(reply));
        if calls.is_empty() {
            return Ok(());
        }
        for (id, name, arguments) in calls {
            let (text, is_error) = if name == tool.name() {
                (tool.execute(&arguments), false)
            } else {
                (format!("Unknown tool {name}"), true)
            };
            messages.push(Message::ToolResult {
                tool_call_id: id,
                tool_name: name,
                content: vec![UserBlock::Text {
                    text,
                    text_signature: None,
                }],
                details: None,
                is_error,
                timestamp: now_ms(),
            });
        }
    }
    Ok(())
}
