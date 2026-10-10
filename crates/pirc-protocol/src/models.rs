//! The gateway's model catalog as nodes receive it (`modelsSchema` in
//! `apps/gateway/src/models.ts`): secret-free once projected for a node.

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    #[serde(default)]
    pub providers: IndexMap<String, Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<ModelRef>,
    /// The node's local inference socket, added for its agents only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<InferenceConfig>,
}

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

/// A node's private inference endpoint for its agents.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceConfig {
    pub socket_path: String,
    pub token: String,
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

impl std::fmt::Debug for InferenceConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InferenceConfig")
            .field("socket_path", &self.socket_path)
            .field("token", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::round_trip;
    use serde_json::json;

    #[test]
    fn keeps_provider_order_and_hides_secrets_from_debug() {
        let models = json!({ "providers": {
            "zeta": { "api": "openai-completions", "baseUrl": "https://z", "headers": {},
                "compat": {}, "models": [{ "id": "m", "contextWindow": 1, "maxTokens": 1,
                    "reasoning": false, "input": ["text"], "compat": {},
                    "headers": { "authorization": "Bearer model-secret" } }], "apiKey": "sk-z" },
            "alpha": { "api": "anthropic-messages", "baseUrl": "https://a", "headers": {},
                "compat": {}, "models": [{ "id": "m", "contextWindow": 1, "maxTokens": 1,
                    "reasoning": false, "input": ["text"], "compat": {} }] },
        }, "inference": { "socketPath": "/s", "token": "secret-token" } });
        let parsed = round_trip::<Models>(&models).unwrap();
        assert_eq!(
            parsed.providers.keys().collect::<Vec<_>>(),
            ["zeta", "alpha"]
        );
        let debug = format!("{parsed:?}");
        for secret in ["sk-z", "secret-token", "model-secret"] {
            assert!(!debug.contains(secret), "{debug}");
        }
    }
}
