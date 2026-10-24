//! The gateway model catalog and private node socket envelope.
//! Shared DTOs retain their old public imports through re-exports.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub use pirc_llm_types::{Model, ModelApi, ModelRef, Provider, ThinkingLevel};

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

/// A node's private inference endpoint for its agents.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceConfig {
    pub socket_path: String,
    pub token: String,
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
