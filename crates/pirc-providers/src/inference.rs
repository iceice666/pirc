//! Gateway-only model execution (`GatewayInference` in
//! `backends/inference.ts`). No provider configuration comes from a node.

use std::future::Future;
use std::sync::LazyLock;

use pirc_protocol::{
    AssistantDelta, AssistantMessage, InferenceRequest, Model, ModelApi, Models, Provider,
    StopReason, ThinkingLevel,
};
use tokio::sync::watch;

use crate::errors::safe_inference_error;
use pirc_llm::{
    Auth, Context, RequestOptions, ResolvedEndpoint, ResolvedModel, Route, RunRequest, Transport,
    api_name, assistant,
};

const CANCELLED: &str = "Model request cancelled";

// Host fingerprinting belongs to the pirc adapter, not the reusable transport.
/// `os.platform()` and `os.arch()` names.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        "loongarch64" => "loong64",
        other => other,
    }
}

/// `os.release()`: the kernel release, read once (`/proc` on Linux; the
/// system's own `uname -r` by absolute path elsewhere, never one found
/// through `PATH`).
fn os_release() -> &'static str {
    static RELEASE: LazyLock<String> = LazyLock::new(|| {
        let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok();
        let release = release.or_else(|| {
            let output = std::process::Command::new("/usr/bin/uname")
                .arg("-r")
                .env_clear()
                .output()
                .ok()?;
            String::from_utf8(output.stdout).ok()
        });
        release.unwrap_or_default().trim().to_owned()
    });
    &RELEASE
}

/// `pi (${os.platform()} ${os.release()}; ${os.arch()})`.
fn user_agent() -> String {
    format!("pi ({} {}; {})", node_platform(), os_release(), node_arch())
}

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
    transport: Transport,
    generation: watch::Sender<u64>,
}

impl Default for Inference {
    fn default() -> Self {
        Self::new()
    }
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
            transport: Transport::new(client, long),
            generation: watch::Sender::new(0),
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
            resolved = resolver.resolve(&request.provider_name, &request.model_id) => Some(resolved),
            // `changed()` marks the value seen, so `fail` would no longer see it.
            _ = cancel.changed() => None,
        };
        let resolved = match resolved {
            Some(Ok(resolved)) => resolved,
            Some(Err(error)) => return fail(message, &cancel, &error),
            None => {
                message.stop_reason = StopReason::Aborted;
                message.error_message = Some(CANCELLED.to_owned());
                return message;
            }
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
        let route = match (use_pi, api) {
            (false, _) if provider.api == ModelApi::OpenaiChat => Route::Chat,
            (false, _) => Route::NativeAnthropic,
            (true, ModelApi::OpenaiChat | ModelApi::OpenaiCompletions) => Route::Completions,
            (true, ModelApi::AnthropicMessages) => Route::Anthropic,
            (true, ModelApi::OpenaiResponses) => Route::Responses,
            (true, ModelApi::OpenaiCodexResponses) => Route::Codex,
        };
        let session_id = serde_json::to_string(&[
            node_id,
            request.session_id.as_str(),
            request.provider_name.as_str(),
        ])
        .unwrap_or_default();
        let codex_user_agent = if matches!(route, Route::Codex) {
            user_agent()
        } else {
            String::new()
        };
        let endpoint =
            ResolvedEndpoint::from_legacy(route, &request.provider_name, provider, model);
        let runtime_model = ResolvedModel::from(model);
        let stream_request = RunRequest {
            provider_name: &request.provider_name,
            endpoint: &endpoint,
            model: &runtime_model,
            auth: resolved.api_key.as_deref().map_or(Auth::None, Auth::Key),
            context: Context {
                system_prompt: &request.system_prompt,
                messages: &request.messages,
                tools: &request.tools,
            },
            options: RequestOptions {
                thinking: if model.reasoning {
                    request.thinking
                } else {
                    ThinkingLevel::Off
                },
                session_id: &session_id,
                codex_user_agent: &codex_user_agent,
                max_tokens: request.max_tokens,
                tool_choice: request.tool_choice,
                resolve_variable: &|name| std::env::var(name).ok(),
            },
        };
        let native = matches!(route, Route::Chat | Route::NativeAnthropic);
        let mut message = self
            .transport
            .run_request(route, &stream_request, cancel, on_delta)
            .await
            .into_legacy_message();
        // Native errors may contain upstream bodies; only fixed classifications
        // leave the gateway. Pi paths retain their compatibility classifications.
        if native
            && message.stop_reason != StopReason::Aborted
            && let Some(error) = message.error_message.as_ref().filter(|e| !e.is_empty())
        {
            message.error_message = Some(safe_inference_error(error));
        }
        message
    }
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    #[test]
    fn codex_fingerprint_preserves_the_pi_format() {
        let agent = user_agent();
        assert_eq!(
            agent,
            format!("pi ({} {}; {})", node_platform(), os_release(), node_arch())
        );
        assert!(agent.starts_with("pi ("), "{agent}");
        assert!(agent.ends_with(')'), "{agent}");
        #[cfg(target_os = "linux")]
        if let Ok(release) = std::fs::read_to_string("/proc/sys/kernel/osrelease") {
            assert!(agent.contains(release.trim()), "{agent}");
        }
        #[cfg(target_arch = "x86_64")]
        assert!(agent.ends_with("; x64)"), "{agent}");
        #[cfg(target_arch = "aarch64")]
        assert!(agent.ends_with("; arm64)"), "{agent}");
    }
}
