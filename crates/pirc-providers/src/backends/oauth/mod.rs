//! Subscription (OAuth) accounts: pi-ai's provider registry
//! (`getOAuthProviders`) and how a signed-in account becomes a provider
//! (`oauthProvider` in `service.ts`, with each provider's `modifyModels`).

pub mod flows;

use indexmap::IndexMap;
use pirc_protocol::{Model, Provider};
use serde_json::{Map, Value};

use super::Credentials;
use crate::catalog::{CatalogModel, catalog_models};

/// A subscription provider as the settings page lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OAuthProviderInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// The login listens on a fixed localhost redirect.
    pub uses_callback_server: bool,
}

/// pi-ai's built-in registry, in its order.
pub const OAUTH_PROVIDERS: [OAuthProviderInfo; 3] = [
    OAuthProviderInfo {
        id: "anthropic",
        name: "Anthropic (Claude Pro/Max)",
        uses_callback_server: true,
    },
    OAuthProviderInfo {
        id: "github-copilot",
        name: "GitHub Copilot",
        uses_callback_server: false,
    },
    OAuthProviderInfo {
        id: "openai-codex",
        name: "ChatGPT Plus/Pro (Codex Subscription)",
        uses_callback_server: true,
    },
];

pub fn info(id: &str) -> Option<&'static OAuthProviderInfo> {
    OAUTH_PROVIDERS.iter().find(|info| info.id == id)
}

pub use pirc_llm::oauth::{copilot_base_url, normalize_domain};

/// The catalog of `id` as this account sees it (`modifyModels`).
fn account_catalog(id: &str, credentials: &Credentials) -> Vec<CatalogModel> {
    let mut models = catalog_models(id).to_vec();
    if id == "github-copilot" {
        let domain = credentials
            .get("enterpriseUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .and_then(normalize_domain);
        let access = credentials.get("access").and_then(Value::as_str);
        let base_url = copilot_base_url(access, domain.as_deref());
        for model in &mut models {
            if model.provider == "github-copilot" {
                model.base_url = base_url.clone();
            }
        }
    }
    models
}

/// `oauthProvider(id, credentials)`: a signed-in account as a provider, or
/// `None` for an unknown provider or an empty catalog.
pub fn provider_config(id: &str, credentials: &Credentials) -> Option<Provider> {
    info(id)?;
    let entries = account_catalog(id, credentials);
    let first = entries.first()?;
    Some(Provider {
        api: first.api,
        pi_provider: Some(id.to_owned()),
        opencode_go: None,
        base_url: first.base_url.clone(),
        headers: IndexMap::new(),
        compat: Map::new(),
        models: entries
            .iter()
            .map(|model| Model {
                api: Some(model.api),
                base_url: Some(model.base_url.clone()),
                canonical_provider: Some(model.provider.clone()),
                headers: model.headers.clone(),
                thinking_level_map: model.thinking_level_map.clone(),
                id: model.id.clone(),
                name: Some(model.name.clone()),
                context_window: model.context_window,
                max_tokens: model.max_tokens,
                reasoning: model.reasoning,
                input: model.input.clone(),
                compat: model.compat.clone().unwrap_or_default(),
            })
            .collect(),
        api_key: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn credentials(value: Value) -> Credentials {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn copilot_base_urls() {
        assert_eq!(
            copilot_base_url(
                Some("tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;x=y"),
                None
            ),
            "https://api.business.githubcopilot.com"
        );
        assert_eq!(
            copilot_base_url(Some("tid=1"), Some("ghe.example")),
            "https://copilot-api.ghe.example"
        );
        assert_eq!(
            copilot_base_url(None, None),
            "https://api.individual.githubcopilot.com"
        );
        assert_eq!(
            normalize_domain(" https://ghe.example/path ").as_deref(),
            Some("ghe.example")
        );
        assert_eq!(
            normalize_domain("ghe.example").as_deref(),
            Some("ghe.example")
        );
        assert_eq!(normalize_domain("  "), None);
    }

    #[test]
    fn accounts_become_providers() {
        let copilot = provider_config(
            "github-copilot",
            &credentials(
                json!({ "access": "tid=1;proxy-ep=proxy.enterprise.example;",
                "refresh": "r", "expires": 1 }),
            ),
        )
        .unwrap();
        assert_eq!(copilot.pi_provider.as_deref(), Some("github-copilot"));
        assert!(
            copilot
                .models
                .iter()
                .all(|m| m.base_url.as_deref() == Some("https://api.enterprise.example"))
        );
        let anthropic = provider_config(
            "anthropic",
            &credentials(json!({ "access": "a", "refresh": "r", "expires": 1 })),
        )
        .unwrap();
        assert_eq!(anthropic.base_url, "https://api.anthropic.com");
        assert_eq!(
            anthropic.models[0].canonical_provider.as_deref(),
            Some("anthropic")
        );
        assert!(provider_config("openai", &Credentials::new()).is_none());
    }
}
