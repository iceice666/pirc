//! pi-ai's built-in model catalog (`getProviders`/`getModels`), embedded as
//! the snapshot `scripts/model-catalog.ts` generates from the pinned pi-ai
//! package. It feeds API-key presets and the subscription (OAuth) catalogs.

use std::sync::LazyLock;

use indexmap::IndexMap;
use pirc_protocol::ModelApi;
use serde::Deserialize;
use serde_json::{Map, Value};

const SNAPSHOT: &str = include_str!("../catalog.json");

/// One catalog model (pi-ai's `Model`, without `cost`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub api: ModelApi,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default)]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(default)]
    pub compat: Option<Map<String, Value>>,
    #[serde(default)]
    pub thinking_level_map: Option<IndexMap<String, Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    pi_ai: String,
    providers: IndexMap<String, Vec<CatalogModel>>,
}

static CATALOG: LazyLock<Snapshot> =
    LazyLock::new(|| serde_json::from_str(SNAPSHOT).expect("the embedded catalog parses"));

/// The pi-ai version the snapshot was generated from.
pub fn catalog_version() -> &'static str {
    &CATALOG.pi_ai
}

/// `getProviders()`: catalog provider IDs in pi-ai's order.
pub fn catalog_providers() -> impl Iterator<Item = &'static str> {
    CATALOG.providers.keys().map(String::as_str)
}

/// `getModels(provider)`: empty for an unknown provider.
pub fn catalog_models(provider: &str) -> &'static [CatalogModel] {
    CATALOG.providers.get(provider).map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_parses_with_the_subscription_catalogs() {
        assert_eq!(catalog_version(), "0.73.1");
        for provider in ["anthropic", "openai-codex", "github-copilot", "openai"] {
            assert!(!catalog_models(provider).is_empty(), "{provider}");
        }
        assert!(catalog_models("google").is_empty());
        assert!(catalog_models("unknown").is_empty());
        let first = &catalog_models("anthropic")[0];
        assert_eq!(first.provider, "anthropic");
        assert_eq!(first.api, ModelApi::AnthropicMessages);
        // pi-ai's provider order.
        assert_eq!(catalog_providers().next(), Some("anthropic"));
    }
}
