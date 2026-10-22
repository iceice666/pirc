//! Observational memory settings (`features/memory/config.ts`
//! `memoryConfigFrom`): `features.observationalMemory` with its defaults.
//! Settings that do not fit the schema count as the defaults, all of them
//! (the startup warning, `config::memory_config_warning`, says so).

use pirc_protocol::ThinkingLevel;
use serde_json::{Map, Value};

use crate::config::thinking_level;

/// `ModelChoice`.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelChoice {
    pub provider: String,
    pub id: String,
    pub thinking: Option<ThinkingLevel>,
}

/// `memorySchema.workspace`.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceSettings {
    pub enabled: bool,
    /// Budget for the notes frozen into a new session's system prompt (and
    /// the promoter's target).
    pub max_tokens: u64,
    pub shutdown_timeout_ms: u64,
}

/// `MemoryConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryConfig {
    pub enabled: bool,
    pub passive: bool,
    pub observe_after_tokens: u64,
    pub reflect_after_tokens: u64,
    pub observer_chunk_max_tokens: Option<u64>,
    pub compact_after_tokens: u64,
    /// `compactAfterTokensMode === 'ratio'`.
    pub compact_after_ratio_mode: bool,
    pub compact_after_tokens_ratio: f64,
    pub observations_pool_max_tokens: u64,
    pub observations_pool_target_tokens: Option<u64>,
    pub agent_max_turns: u64,
    pub agent_max_tokens: u64,
    pub model: Option<ModelChoice>,
    pub fallback_models: Vec<ModelChoice>,
    /// `missingModelPolicy: 'error'`: a configured model (preferred or
    /// fallback) that does not resolve stops memory work with a visible
    /// error, instead of falling back to the session model.
    pub strict_models: bool,
    pub rate_limit_cooldown_ms: u64,
    pub show_worker_notifications: bool,
    /// Cross-session memory shared by every main session (and worktree) of
    /// a repository.
    pub workspace: WorkspaceSettings,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            passive: false,
            observe_after_tokens: 10_000,
            reflect_after_tokens: 20_000,
            observer_chunk_max_tokens: None,
            compact_after_tokens: 81_000,
            compact_after_ratio_mode: false,
            compact_after_tokens_ratio: 0.68,
            observations_pool_max_tokens: 20_000,
            observations_pool_target_tokens: None,
            agent_max_turns: 16,
            agent_max_tokens: 32_000,
            model: None,
            fallback_models: Vec::new(),
            strict_models: false,
            rate_limit_cooldown_ms: 900_000,
            show_worker_notifications: true,
            workspace: WorkspaceSettings {
                enabled: true,
                max_tokens: 3_000,
                shutdown_timeout_ms: 20_000,
            },
        }
    }
}

/// A model choice of valid settings; `max` (accepted for configs carried
/// over from Pi) is the highest level.
fn model_choice(value: &Value) -> ModelChoice {
    let text = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
    ModelChoice {
        provider: text("provider"),
        id: text("id"),
        thinking: value["thinking"].as_str().and_then(|level| {
            if level == "max" {
                Some(ThinkingLevel::Xhigh)
            } else {
                thinking_level(level)
            }
        }),
    }
}

/// `validateMemoryConfig(features).config`.
pub fn parse_memory_config(features: &Map<String, Value>) -> MemoryConfig {
    let empty = Value::Object(Map::new());
    let raw = features
        .get("observationalMemory")
        .filter(|value| !value.is_null())
        .unwrap_or(&empty);
    let mut config = MemoryConfig::default();
    let boolean = |value: &Value, key: &str, out: &mut bool| {
        if let Some(value) = value.get(key).and_then(Value::as_bool) {
            *out = value;
        }
    };
    let number = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0 && v.fract() == 0.0 && *v <= u64::MAX as f64)
    };
    let positive = |value: &Value, key: &str, out: &mut u64| {
        if let Some(value) = number(value, key) {
            *out = value as u64;
        }
    };
    boolean(raw, "enabled", &mut config.enabled);
    boolean(raw, "passive", &mut config.passive);
    boolean(
        raw,
        "showWorkerNotifications",
        &mut config.show_worker_notifications,
    );
    positive(raw, "observeAfterTokens", &mut config.observe_after_tokens);
    positive(raw, "reflectAfterTokens", &mut config.reflect_after_tokens);
    config.observer_chunk_max_tokens = number(raw, "observerChunkMaxTokens").map(|n| n as u64);
    positive(raw, "compactAfterTokens", &mut config.compact_after_tokens);
    config.compact_after_ratio_mode = raw["compactAfterTokensMode"] == "ratio";
    if let Some(ratio) = raw["compactAfterTokensRatio"]
        .as_f64()
        .filter(|n| *n > 0.0 && *n < 1.0)
    {
        config.compact_after_tokens_ratio = ratio;
    }
    positive(
        raw,
        "observationsPoolMaxTokens",
        &mut config.observations_pool_max_tokens,
    );
    config.observations_pool_target_tokens =
        number(raw, "observationsPoolTargetTokens").map(|n| n as u64);
    positive(raw, "agentMaxTurns", &mut config.agent_max_turns);
    positive(raw, "agentMaxTokens", &mut config.agent_max_tokens);
    let valid_model = |v: &&Value| {
        v["provider"].as_str().is_some_and(|s| !s.is_empty())
            && v["id"].as_str().is_some_and(|s| !s.is_empty())
    };
    config.model = raw.get("model").filter(valid_model).map(model_choice);
    if let Some(models) = raw.get("fallbackModels").and_then(Value::as_array) {
        config.fallback_models = models
            .iter()
            .filter(valid_model)
            .map(model_choice)
            .collect();
    }
    config.strict_models = raw["missingModelPolicy"] == "error";
    positive(
        raw,
        "rateLimitCooldownMs",
        &mut config.rate_limit_cooldown_ms,
    );
    if let Some(workspace) = raw.get("workspace") {
        boolean(workspace, "enabled", &mut config.workspace.enabled);
        positive(workspace, "maxTokens", &mut config.workspace.max_tokens);
        positive(
            workspace,
            "shutdownTimeoutMs",
            &mut config.workspace.shutdown_timeout_ms,
        );
    }
    // Explicit canonical fields override legacy workspace fields individually.
    if let Some(workspace) = features.get("workspaceMemory").filter(|v| v.is_object()) {
        boolean(workspace, "enabled", &mut config.workspace.enabled);
        positive(workspace, "maxTokens", &mut config.workspace.max_tokens);
        positive(
            workspace,
            "shutdownTimeoutMs",
            &mut config.workspace.shutdown_timeout_ms,
        );
    }
    config
}

/// `memoryConfigFrom(features)`: the settings, `PIRC_MEMORY_PASSIVE`
/// overriding `passive`.
pub fn memory_config_from(features: &Map<String, Value>) -> MemoryConfig {
    let mut config = parse_memory_config(features);
    if let Some(passive) = std::env::var("PIRC_MEMORY_PASSIVE")
        .ok()
        .filter(|value| !value.is_empty())
    {
        let value = crate::tools::js::trim(&passive).to_ascii_lowercase();
        config.passive = matches!(value.as_str(), "1" | "true" | "yes" | "on");
    }
    config
}

/// Work settings remain independently selectable, with fieldwise legacy aliases.
pub fn workspace_config_from(features: &Map<String, Value>) -> MemoryConfig {
    let mut config = memory_config_from(features);
    let canonical = features.get("workspaceMemory").filter(|v| v.is_object());
    config.workspace.enabled &= canonical.is_some_and(|c| c["enabled"] == true) || config.enabled;
    let legacy = features
        .get("observationalMemory")
        .and_then(|v| v.get("workspace"));
    let field = |key: &str| {
        canonical
            .and_then(|v| v.get(key))
            .or_else(|| legacy.and_then(|v| v.get(key)))
    };
    if let Some(passive) = field("passive").and_then(Value::as_bool) {
        config.passive = passive;
    }
    if std::env::var("PIRC_MEMORY_PASSIVE").ok().is_some_and(|s| {
        ["1", "true", "yes", "on"].contains(&s.trim().to_ascii_lowercase().as_str())
    }) {
        config.passive = true;
    }
    if let Some(model) = field("model").filter(|v| {
        v["provider"].as_str().is_some_and(|s| !s.is_empty())
            && v["id"].as_str().is_some_and(|s| !s.is_empty())
    }) {
        config.model = Some(model_choice(model));
    }
    if let Some(models) = field("fallbackModels").and_then(Value::as_array) {
        config.fallback_models = models
            .iter()
            .filter(|v| {
                v["provider"].as_str().is_some_and(|s| !s.is_empty())
                    && v["id"].as_str().is_some_and(|s| !s.is_empty())
            })
            .map(model_choice)
            .collect();
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(memory: Value) -> MemoryConfig {
        let features = json!({ "observationalMemory": memory });
        parse_memory_config(features.as_object().unwrap())
    }

    #[test]
    fn reads_valid_settings_and_resets_invalid_ones() {
        // From memory-config.test.ts.
        assert_eq!(parse_memory_config(&Map::new()), MemoryConfig::default());
        let disabled = parse(json!({ "enabled": false, "workspace": { "enabled": false } }));
        assert!(!disabled.enabled && !disabled.workspace.enabled);
        assert!(disabled.fallback_models.is_empty());
        let reset = parse(json!({
            "enabled": false, "workspace": { "enabled": false }, "observeAfterTokens": 42,
            "fallbackModels": [{ "provider": "fake", "id": "model" },
                { "provider": "", "id": "private-model-value" }],
        }));
        assert!(!reset.enabled && !reset.workspace.enabled);
        assert_eq!(reset.observe_after_tokens, 42);
        assert_eq!(reset.fallback_models.len(), 1);
        let unknown = parse(json!({
            "enabled": false, "observeAfterTokens": 123, "legacy": "secret-value",
            "model": { "provider": "p", "id": "m", "thinking": "max", "extra": "secret-value" },
            "fallbackModels": [{ "provider": "p", "id": "fallback", "typo": "secret-value" }],
            "workspace": { "enabled": false, "other": "secret-value" },
        }));
        assert!(!unknown.enabled && !unknown.workspace.enabled);
        assert_eq!(unknown.observe_after_tokens, 123);
        assert_eq!(unknown.model.unwrap().thinking, Some(ThinkingLevel::Xhigh));
        assert_eq!(
            unknown.fallback_models,
            [ModelChoice {
                provider: "p".to_owned(),
                id: "fallback".to_owned(),
                thinking: None
            }]
        );
        for value in [json!(false), json!([]), json!("private-whole-object")] {
            assert_eq!(parse(value), MemoryConfig::default());
        }
        let ratio = parse(json!({ "compactAfterTokensMode": "ratio",
            "compactAfterTokensRatio": 0.5, "observationsPoolTargetTokens": 7,
            "observerChunkMaxTokens": 300 }));
        assert!(ratio.compact_after_ratio_mode);
        assert_eq!(ratio.compact_after_tokens_ratio, 0.5);
        assert_eq!(ratio.observations_pool_target_tokens, Some(7));
        assert_eq!(ratio.observer_chunk_max_tokens, Some(300));
    }

    #[test]
    fn reads_the_missing_model_policy() {
        assert!(!MemoryConfig::default().strict_models);
        assert!(!parse(json!({ "missingModelPolicy": "fallback" })).strict_models);
        assert!(parse(json!({ "missingModelPolicy": "error", "enabled": false })).strict_models);
        // Anything else is invalid: the whole object is the defaults.
        let invalid = parse(json!({ "missingModelPolicy": "strict", "enabled": false }));
        assert!(!invalid.enabled);
    }
}
