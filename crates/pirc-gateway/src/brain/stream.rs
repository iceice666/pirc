//! The brain's inference: `pirc-agent`'s `StreamFn` over the gateway's own
//! [`pirc_providers::Inference`], never a node socket.
//!
//! The agent runs on the brain's thread (a current-thread runtime and a
//! `LocalSet`); the HTTP request runs on the gateway's main runtime, where
//! the backends and the HTTP client live, and its deltas come back over a
//! channel.

use std::time::Duration;

use pirc_agent::LocalBoxFuture;
use pirc_agent::messages::empty_usage;
use pirc_agent::remote::{INFERENCE_TIMEOUT_MS, inference_error_message, inference_request};
use pirc_agent::stream::{StreamFn, StreamRequest};
use pirc_protocol::{AssistantDelta, AssistantMessage, InferenceErrorCode, StopReason};
use tokio::runtime::Handle;
use tokio::sync::mpsc;

use crate::app::AppState;

/// What the brain's model calls are logged as (`node_id` of a node's).
const BRAIN_CALLER: &str = "brain";

enum Event {
    Delta(AssistantDelta),
    End(AssistantMessage),
}

pub struct GatewayStream {
    pub app: AppState,
    /// The gateway's main runtime.
    pub runtime: Handle,
}

impl StreamFn for GatewayStream {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        on_delta: &'a mut dyn FnMut(&AssistantDelta),
    ) -> LocalBoxFuture<'a, AssistantMessage> {
        Box::pin(async move {
            let api = request.model.api.unwrap_or(request.provider.api);
            let partial = AssistantMessage {
                content: Vec::new(),
                api: serde_json::to_value(api)
                    .ok()
                    .and_then(|api| api.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                provider: request.provider_name.clone(),
                model: request.model.id.clone(),
                usage: empty_usage(),
                stop_reason: StopReason::Error,
                error_message: None,
                timestamp: pirc_agent::now_ms(),
                completed_at: None,
                canonical_provider: None,
                response_id: None,
                response_model: None,
            };
            let failure = |code: InferenceErrorCode, aborted: bool| AssistantMessage {
                stop_reason: if aborted {
                    StopReason::Aborted
                } else {
                    StopReason::Error
                },
                error_message: Some(inference_error_message(code).to_owned()),
                completed_at: Some(pirc_agent::now_ms()),
                ..partial.clone()
            };
            let signal = request.signal.clone();
            let wire = inference_request(&request);
            let (sender, mut events) = mpsc::unbounded_channel();
            let app = self.app.clone();
            let task = self.runtime.spawn(async move {
                let deltas = sender.clone();
                let mut on_delta = move |delta: &AssistantDelta, _: &AssistantMessage| {
                    let _ = deltas.send(Event::Delta(delta.clone()));
                };
                let message = app
                    .inference
                    .run(app.backends.as_ref(), &wire, BRAIN_CALLER, &mut on_delta)
                    .await;
                let _ = sender.send(Event::End(message));
            });
            // Dropping the task's future aborts the HTTP request.
            let _abort = AbortOnDrop(task.abort_handle());
            let deadline = tokio::time::sleep(Duration::from_millis(INFERENCE_TIMEOUT_MS));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    biased;
                    () = signal.cancelled() => {
                        return failure(InferenceErrorCode::Cancelled, true);
                    }
                    () = &mut deadline => return failure(InferenceErrorCode::Timeout, false),
                    event = events.recv() => match event {
                        Some(Event::Delta(delta)) => on_delta(&delta),
                        Some(Event::End(message)) => return message,
                        None => return failure(InferenceErrorCode::Unavailable, false),
                    },
                }
            }
        })
    }
}

pub(super) struct AbortOnDrop(pub(super) tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
