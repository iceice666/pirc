//! Neutral model identifiers and compatibility configuration DTOs.
//! Provider/model configuration is not guaranteed to be secret-free.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelApi {
    /// Legacy name of `openai-completions`.
    OpenaiChat,
    AnthropicMessages,
    OpenaiCompletions,
    OpenaiResponses,
    OpenaiCodexResponses,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

/// Provider configuration as data only. May contain credentials in headers or `api_key`.
/// Runtime clients, credential lookup and persistence belong to the host/transport layer.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub api: ModelApi,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_go: Option<bool>,
    pub base_url: String,
    #[serde(default)]
    pub headers: IndexMap<String, String>,
    #[serde(default)]
    pub compat: Map<String, Value>,
    pub models: Vec<Model>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// Model metadata and optional endpoint overrides; headers may contain credentials.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<ModelApi>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<IndexMap<String, Option<String>>>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default = "default_context_window")]
    pub context_window: u64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default = "default_input")]
    pub input: Vec<String>,
    #[serde(default)]
    pub compat: Map<String, Value>,
}

fn default_context_window() -> u64 {
    200_000
}
fn default_max_tokens() -> u64 {
    32_000
}
fn default_input() -> Vec<String> {
    vec!["text".to_owned()]
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingLevel>,
}

/// Debug output never shows credentials.
impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provider")
            .field("api", &self.api)
            .field("pi_provider", &self.pi_provider)
            .field("opencode_go", &self.opencode_go)
            .field("base_url", &self.base_url)
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("compat", &self.compat)
            .field("models", &self.models)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let headers = self.headers.as_ref().map(|h| h.keys().collect::<Vec<_>>());
        f.debug_struct("Model")
            .field("api", &self.api)
            .field("base_url", &self.base_url)
            .field("canonical_provider", &self.canonical_provider)
            .field("headers", &headers)
            .field("thinking_level_map", &self.thinking_level_map)
            .field("id", &self.id)
            .field("name", &self.name)
            .field("context_window", &self.context_window)
            .field("max_tokens", &self.max_tokens)
            .field("reasoning", &self.reasoning)
            .field("input", &self.input)
            .field("compat", &self.compat)
            .finish()
    }
}
