//! What a transport receives (`StreamRequest` in
//! `agent/providers/types.ts`) and how it reports deltas.

use pirc_protocol::{
    AssistantDelta, AssistantMessage, Message, Model, Provider, StopReason, ThinkingLevel,
    ToolChoice, ToolSpec, Usage,
};
use tokio::sync::watch;

pub struct StreamRequest<'a> {
    pub provider_name: &'a str,
    pub provider: &'a Provider,
    pub model: &'a Model,
    pub api_key: Option<&'a str>,
    pub system_prompt: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub thinking: ThinkingLevel,
    /// `JSON.stringify([nodeId, sessionId, providerName])`.
    pub session_id: String,
    pub max_tokens: Option<u64>,
    pub tool_choice: Option<ToolChoice>,
}

/// The run was cancelled; the transport stops where it is.
#[derive(Debug)]
pub struct Cancelled;

/// Forwards deltas until the run is cancelled.
pub struct Emitter<'a> {
    pub cancel: watch::Receiver<u64>,
    pub on_delta: &'a mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
}

impl Emitter<'_> {
    pub fn cancelled(&self) -> bool {
        self.cancel.has_changed().unwrap_or(true)
    }

    /// Deliver a delta unless cancelled; `Err` once the run is cancelled,
    /// including by the callback itself.
    pub fn emit(
        &mut self,
        delta: AssistantDelta,
        partial: &AssistantMessage,
    ) -> Result<(), Cancelled> {
        if self.cancelled() {
            return Err(Cancelled);
        }
        (self.on_delta)(&delta, partial);
        if self.cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }
}

pub fn empty_usage() -> Usage {
    Usage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 0,
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A fresh assistant message.
pub fn assistant(
    api: &str,
    provider: &str,
    model: &str,
    stop_reason: StopReason,
) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: api.to_owned(),
        provider: provider.to_owned(),
        model: model.to_owned(),
        usage: empty_usage(),
        stop_reason,
        error_message: None,
        timestamp: now_ms(),
        completed_at: None,
        canonical_provider: None,
        response_id: None,
        response_model: None,
    }
}

pub fn content_index(index: usize) -> u32 {
    u32::try_from(index).unwrap_or(u32::MAX)
}
