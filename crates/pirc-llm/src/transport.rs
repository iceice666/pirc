use crate::outcome::{ErrorKind, LlmError, RunOutcome};
use crate::runtime::RunRequest;
use crate::stream::{Emitter, StreamRequest, assistant};
use pirc_llm_types::{AssistantDelta, AssistantMessage, StopReason};
use tokio::sync::watch;

/// Explicit transport selection. No backend policy or fallback is applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Completions,
    Anthropic,
    Responses,
    Codex,
    Chat,
    NativeAnthropic,
}

/// Client and cache policy supplied by the host; construction has no global effects.
pub struct Transport {
    client: reqwest::Client,
    #[cfg(any(
        feature = "anthropic-messages",
        feature = "openai-completions",
        feature = "openai-responses",
        feature = "openai-codex-responses"
    ))]
    long_cache_retention: bool,
}

impl Transport {
    pub fn new(client: reqwest::Client, long_cache_retention: bool) -> Self {
        let _ = long_cache_retention; // native Chat has no cache-retention switch
        Self {
            client,
            #[cfg(any(
                feature = "anthropic-messages",
                feature = "openai-completions",
                feature = "openai-responses",
                feature = "openai-codex-responses"
            ))]
            long_cache_retention,
        }
    }

    /// Execute one explicitly routed request. Dropping the future cancels HTTP.
    /// A changed/closed cancellation generation preserves partial content/usage,
    /// marks the result aborted and suppresses subsequent deltas. Callbacks run
    /// synchronously in stream order (no spawning or buffering).
    pub async fn run(
        &self,
        route: Route,
        request: &StreamRequest<'_>,
        cancel: watch::Receiver<u64>,
        on_delta: &mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
    ) -> AssistantMessage {
        self.run_outcome(route, request, cancel, on_delta)
            .await
            .into_legacy_message()
    }

    /// Execute a legacy request with structured termination and a safe final error summary.
    pub async fn run_outcome(
        &self,
        route: Route,
        request: &StreamRequest<'_>,
        cancel: watch::Receiver<u64>,
        on_delta: &mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
    ) -> RunOutcome {
        let (endpoint, model) = request.resolve(route);
        let request = request.runtime(&endpoint, &model);
        self.run_request(route, &request, cancel, on_delta).await
    }

    /// Execute a resolved runtime request without catalog/configuration DTOs.
    /// No tasks or event queues are spawned. Dropping this future cancels HTTP.
    pub async fn run_request(
        &self,
        route: Route,
        request: &RunRequest<'_>,
        mut cancel: watch::Receiver<u64>,
        on_delta: &mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
    ) -> RunOutcome {
        // A stale generation must not begin an HTTP request, even when the
        // response could complete immediately in the biased select below.
        if cancel.has_changed().unwrap_or(true) {
            let mut message = assistant(
                crate::pi::api_name(request.endpoint.api),
                request.provider_name,
                &request.model.id,
                StopReason::Aborted,
            );
            message.error_message = Some("Model request cancelled".to_owned());
            return RunOutcome::new(message, None);
        }
        let mut emitter = Emitter {
            cancel: cancel.clone(),
            on_delta,
            error: None,
        };
        macro_rules! run {
            ($ty:ty $(, $long:expr)?) => {{
                let mut run = <$ty>::new(request);
                let result = tokio::select! {
                    biased;
                    result = run.run(&self.client, request, $($long,)? &mut emitter) => result.ok(),
                    _ = cancel.changed() => None,
                };
                result.unwrap_or_else(|| run.aborted())
            }};
        }
        let mut message = match route {
            #[cfg(feature = "openai-completions")]
            Route::Completions => run!(crate::completions::PiRun, self.long_cache_retention),
            #[cfg(feature = "anthropic-messages")]
            Route::Anthropic => run!(crate::anthropic::AnthropicRun, self.long_cache_retention),
            #[cfg(feature = "openai-responses")]
            Route::Responses => run!(crate::responses::ResponsesRun, self.long_cache_retention),
            #[cfg(feature = "openai-codex-responses")]
            Route::Codex => run!(crate::codex::CodexRun, self.long_cache_retention),
            #[cfg(feature = "openai-chat")]
            Route::Chat => run!(crate::chat::ChatRun),
            #[cfg(feature = "anthropic-messages")]
            Route::NativeAnthropic => run!(crate::anthropic_native::NativeAnthropicRun),
            #[allow(unreachable_patterns)]
            _ => {
                let mut message = assistant(
                    "",
                    request.provider_name,
                    &request.model.id,
                    StopReason::Error,
                );
                emitter.record_error(LlmError::new(ErrorKind::FeatureDisabled));
                message.error_message = Some("Requested wire API feature is disabled".to_owned());
                message
            }
        };
        if emitter.cancelled() || message.stop_reason == StopReason::Aborted {
            message.stop_reason = StopReason::Aborted;
            message.error_message = Some("Model request cancelled".to_owned());
        }
        RunOutcome::new(message, emitter.error)
    }
}
