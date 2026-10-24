//! Gateway OAuth compatibility adapter: presentation types and mechanics live
//! in pirc-llm; catalog/model policy selection remains host-owned.
use super::super::Credentials;
use crate::catalog::catalog_models;
pub use pirc_llm::oauth::{BoxFuture, Endpoints, LoginHooks, Prompt, refresh};
fn policy_model_ids() -> Vec<String> {
    catalog_models("github-copilot")
        .iter()
        .map(|model| model.id.clone())
        .collect()
}

pub async fn login(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    provider: &str,
    hooks: &dyn LoginHooks,
) -> Result<Credentials, String> {
    let ids = policy_model_ids();
    pirc_llm::oauth::login(client, endpoints, provider, hooks, &ids).await
}
