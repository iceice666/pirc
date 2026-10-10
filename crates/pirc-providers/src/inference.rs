//! Gateway-only model execution (`GatewayInference` in
//! `backends/inference.ts`). No provider configuration comes from a node.

use std::future::Future;

use pirc_protocol::{
    AssistantDelta, AssistantMessage, InferenceRequest, Model, ModelApi, Models, Provider,
    StopReason, ThinkingLevel,
};
use tokio::sync::watch;

use crate::chat::ChatRun;
use crate::completions::{PiRun, api_name, pi_api};
use crate::errors::safe_inference_error;
use crate::stream::{Emitter, StreamRequest, assistant};

const CANCELLED: &str = "Model request cancelled";

/// A provider and model a request runs against, with the key to send.
#[derive(Clone)]
pub struct Resolved {
    pub provider: Provider,
    pub model: Model,
    pub api_key: Option<String>,
}

/// `BackendResolver`: finds the provider and model of a request. Errors
/// are reported to the node through [`safe_inference_error`].
pub trait Resolve: Sync {
    fn resolve(
        &self,
        provider: &str,
        model: &str,
    ) -> impl Future<Output = Result<Resolved, String>> + Send;
}

/// The providers of a `models.json` alone.
impl Resolve for Models {
    async fn resolve(&self, provider_name: &str, model_id: &str) -> Result<Resolved, String> {
        let provider = self.providers.get(provider_name);
        let model = provider.and_then(|p| p.models.iter().find(|m| m.id == model_id));
        match (provider, model) {
            (Some(provider), Some(model)) => Ok(Resolved {
                provider: provider.clone(),
                model: model.clone(),
                api_key: provider.api_key.clone(),
            }),
            _ => Err("Backend or authorization session not found".to_owned()),
        }
    }
}

/// A fixed answer (the settings page's connection test).
impl Resolve for Resolved {
    async fn resolve(&self, _: &str, _: &str) -> Result<Resolved, String> {
        Ok(self.clone())
    }
}

/// Runs inference requests; [`Inference::cancel_all`] ends every run in
/// flight.
pub struct Inference {
    client: reqwest::Client,
    generation: watch::Sender<u64>,
    long_cache_retention: bool,
}

impl Default for Inference {
    fn default() -> Self {
        Self::new()
    }
}

/// The transport a request uses.
enum Route {
    /// pi-ai's `openai-completions`.
    Completions,
    /// The native `openai-chat` transport.
    Chat,
    /// Not ported yet (M3): pi-ai's other APIs, native Anthropic.
    Unsupported,
}

impl Inference {
    /// Reads `PI_CACHE_RETENTION` (pi-ai's prompt-cache switch) once.
    pub fn new() -> Self {
        let long = std::env::var("PI_CACHE_RETENTION").is_ok_and(|value| value == "long");
        Self::with_cache_retention(long)
    }

    /// As [`Inference::new`], with `PI_CACHE_RETENTION=long` given explicitly.
    pub fn with_cache_retention(long: bool) -> Self {
        // ring, not aws-lc: no C toolchain for cmake/NASM, smaller binary.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .build()
            .expect("the HTTP client builds with the ring provider installed");
        Self {
            client,
            generation: watch::Sender::new(0),
            long_cache_retention: long,
        }
    }

    /// `cancelAll`: configuration and account changes invalidate in-flight
    /// requests, which end as aborted ("Model request cancelled").
    pub fn cancel_all(&self) {
        self.generation.send_modify(|generation| *generation += 1);
    }

    /// `GatewayInference.run`. Errors are folded into the message
    /// (`stopReason: "error"`); dropping the future aborts the HTTP request.
    pub async fn run<R: Resolve>(
        &self,
        resolver: &R,
        request: &InferenceRequest,
        node_id: &str,
        on_delta: &mut (dyn FnMut(&AssistantDelta, &AssistantMessage) + Send),
    ) -> AssistantMessage {
        let mut cancel = self.generation.subscribe();
        let mut message = assistant(
            "",
            &request.provider_name,
            &request.model_id,
            StopReason::Error,
        );
        let fail = |mut message: AssistantMessage, cancel: &watch::Receiver<u64>, error: &str| {
            let aborted = cancel.has_changed().unwrap_or(true);
            message.stop_reason = if aborted {
                StopReason::Aborted
            } else {
                StopReason::Error
            };
            message.error_message = Some(if aborted {
                CANCELLED.to_owned()
            } else {
                safe_inference_error(error)
            });
            message
        };
        if cancel.has_changed().unwrap_or(true) {
            return fail(message, &cancel, "Aborted");
        }
        let resolved = tokio::select! {
            biased;
            resolved = resolver.resolve(&request.provider_name, &request.model_id) => resolved,
            _ = cancel.changed() => Err("Aborted".to_owned()),
        };
        let resolved = match resolved {
            Ok(resolved) => resolved,
            Err(error) => return fail(message, &cancel, &error),
        };
        let (provider, model) = (&resolved.provider, &resolved.model);
        if cancel.has_changed().unwrap_or(true) {
            return fail(message, &cancel, "Aborted");
        }
        let api = model.api.unwrap_or(provider.api);
        message.api = api_name(api).to_owned();
        let use_pi = provider
            .pi_provider
            .as_deref()
            .is_some_and(|p| !p.is_empty())
            || model.api.is_some()
            || !matches!(
                provider.api,
                ModelApi::OpenaiChat | ModelApi::AnthropicMessages
            );
        let route = match (use_pi, pi_api(api_name(api))) {
            (true, "openai-completions") => Route::Completions,
            (false, _) if provider.api == ModelApi::OpenaiChat => Route::Chat,
            _ => Route::Unsupported,
        };
        let session_id = serde_json::to_string(&[
            node_id,
            request.session_id.as_str(),
            request.provider_name.as_str(),
        ])
        .unwrap_or_default();
        let stream_request = StreamRequest {
            provider_name: &request.provider_name,
            provider,
            model,
            api_key: resolved.api_key.as_deref(),
            system_prompt: &request.system_prompt,
            messages: &request.messages,
            tools: &request.tools,
            thinking: if model.reasoning {
                request.thinking
            } else {
                ThinkingLevel::Off
            },
            session_id,
            max_tokens: request.max_tokens,
            tool_choice: request.tool_choice,
        };
        let mut emitter = Emitter {
            cancel: cancel.clone(),
            on_delta,
        };
        let outcome = match route {
            Route::Completions => {
                let mut run = PiRun::new(&stream_request);
                let result = tokio::select! {
                    biased;
                    result = run.run(&self.client, &stream_request, self.long_cache_retention, &mut emitter) => result.ok(),
                    _ = cancel.changed() => None,
                };
                result.ok_or_else(|| run.aborted())
            }
            Route::Chat => {
                let mut run = ChatRun::new(&stream_request);
                let result = tokio::select! {
                    biased;
                    result = run.run(&self.client, &stream_request, &mut emitter) => result.ok(),
                    _ = cancel.changed() => None,
                };
                result
                    .map(|mut message| {
                        // Native adapters may embed upstream bodies.
                        if let Some(error) = &message.error_message {
                            message.error_message = Some(safe_inference_error(error));
                        }
                        message
                    })
                    .ok_or_else(|| run.aborted())
            }
            Route::Unsupported => {
                Ok(PiRun::new(&stream_request)
                    .error_without_request("Model provider request failed."))
            }
        };
        let mut message = outcome.unwrap_or_else(|aborted| aborted);
        if emitter.cancelled() || message.stop_reason == StopReason::Aborted {
            message.stop_reason = StopReason::Aborted;
            message.error_message = Some(CANCELLED.to_owned());
        }
        message
    }
}
