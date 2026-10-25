//! What a transport receives (`StreamRequest` in
//! `agent/providers/types.ts`) and how it reports deltas.

use pirc_llm_types::{
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
    /// Host-supplied opaque cache/session identity; never derived by the library.
    pub session_id: String,
    /// Exact Codex User-Agent supplied by the host (for example `pi (linux 6.1; x64)`).
    /// Other routes ignore this. The library never probes the host OS/kernel.
    pub codex_user_agent: &'a str,
    pub max_tokens: Option<u64>,
    pub tool_choice: Option<ToolChoice>,
    /// Explicit host substitution for provider URL placeholders. Never reads environment.
    pub resolve_variable: &'a (dyn Fn(&str) -> Option<String> + Sync),
}

impl StreamRequest<'_> {
    /// Project legacy catalog DTOs into the selected route's runtime configuration.
    pub fn resolve(
        &self,
        route: crate::Route,
    ) -> (
        crate::runtime::ResolvedEndpoint,
        crate::runtime::ResolvedModel,
    ) {
        (
            crate::runtime::ResolvedEndpoint::from_legacy(
                route,
                self.provider_name,
                self.provider,
                self.model,
            ),
            crate::runtime::ResolvedModel::from(self.model),
        )
    }

    /// Borrow conversation, authentication and options without cloning history or identity.
    pub fn runtime<'a>(
        &'a self,
        endpoint: &'a crate::runtime::ResolvedEndpoint,
        model: &'a crate::runtime::ResolvedModel,
    ) -> crate::runtime::RunRequest<'a> {
        use crate::runtime::{Auth, Context, RequestOptions, RunRequest};
        RunRequest {
            provider_name: self.provider_name,
            endpoint,
            model,
            auth: self.api_key.map_or(Auth::None, Auth::Key),
            context: Context {
                system_prompt: self.system_prompt,
                messages: self.messages,
                tools: self.tools,
            },
            options: RequestOptions {
                thinking: self.thinking,
                session_id: &self.session_id,
                codex_user_agent: self.codex_user_agent,
                max_tokens: self.max_tokens,
                tool_choice: self.tool_choice,
                resolve_variable: self.resolve_variable,
            },
        }
    }
}

/// The run was cancelled; the transport stops where it is.
#[derive(Debug)]
pub struct Cancelled;

/// Forwards deltas until the run is cancelled.
pub struct Emitter<'a> {
    pub cancel: watch::Receiver<u64>,
    pub(crate) error: Option<crate::outcome::LlmError>,
    pub on_delta: &'a mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
}

impl Emitter<'_> {
    /// Preserve the first structured failure rather than overwriting its cause during cleanup.
    pub fn record_error(&mut self, error: crate::outcome::LlmError) {
        if self.error.is_none() {
            self.error = Some(error);
        }
    }

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

/// Provider-specific total accounting, saturating rather than overflowing on malformed usage.
pub fn usage_total(usage: &Usage, include_cache_write: bool) -> u64 {
    let total = usage
        .input
        .saturating_add(usage.output)
        .saturating_add(usage.cache_read);
    if include_cache_write {
        total.saturating_add(usage.cache_write)
    } else {
        total
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_totals_are_dialect_specific_and_saturating() {
        let usage = Usage {
            input: 2,
            output: 3,
            cache_read: 5,
            cache_write: 7,
            total_tokens: 999,
        };
        assert_eq!(usage_total(&usage, false), 10);
        assert_eq!(usage_total(&usage, true), 17);
        let large = Usage {
            input: u64::MAX,
            ..usage
        };
        assert_eq!(usage_total(&large, false), u64::MAX);
        assert_eq!(usage_total(&large, true), u64::MAX);
    }

    #[test]
    fn emitter_preserves_first_failure() {
        use crate::outcome::{ErrorKind, LlmError};
        let (_tx, rx) = watch::channel(0);
        let mut callback = |_: &AssistantDelta, _: &AssistantMessage| {};
        let mut emitter = Emitter {
            cancel: rx,
            error: None,
            on_delta: &mut callback,
        };
        emitter.record_error(LlmError::http(401, "first"));
        emitter.record_error(LlmError::new(ErrorKind::Protocol));
        let error = emitter.error.unwrap();
        assert_eq!(error.status(), Some(401));
        assert_eq!(error.diagnostics(), Some("first"));
    }
}
