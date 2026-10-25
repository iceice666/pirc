//! Context compaction (`agent/compaction.ts`): the context size, the cut
//! point, the summary request and the compaction entry. A feature may
//! replace the summary or cancel the compaction (`beforeCompact`).

use std::rc::Rc;

use pirc_protocol::{AssistantMessage, Message, StopReason, ToolChoice};
use serde_json::{Map, Value, json};

use crate::agent::{Agent, StreamOptions};

use crate::messages::estimate_tokens;
use crate::signal::{AbortController, AbortSignal};
use crate::ui::NotifyLevel;

/// `CompactionSettings`: the defaults, overridden by the node's
/// `features.compaction` config where a value has the right type (anything
/// else is ignored).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactionSettings {
    pub enabled: bool,
    /// Compact when context exceeds `contextWindow - reserveTokens`.
    pub reserve_tokens: u64,
    /// Recent context kept verbatim after the summary.
    pub keep_recent_tokens: u64,
    /// Warm the provider prompt cache after compaction.
    pub warm_cache: bool,
    pub timeout_ms: u64,
    pub max_chunks: usize,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reserve_tokens: 16_384,
            keep_recent_tokens: 20_000,
            warm_cache: true,
            timeout_ms: 60_000,
            max_chunks: 16,
        }
    }
}

/// A non-negative integral JSON number.
fn count(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number >= 0.0 && number <= u64::MAX as f64).then_some(number as u64)
}

impl CompactionSettings {
    /// `{ ...defaultCompaction, ...features.compaction }`.
    pub fn from_features(features: &Map<String, Value>) -> Self {
        let mut settings = Self::default();
        let Some(raw) = features.get("compaction").and_then(Value::as_object) else {
            return settings;
        };
        if let Some(value) = raw.get("enabled").and_then(Value::as_bool) {
            settings.enabled = value;
        }
        if let Some(value) = raw.get("warmCache").and_then(Value::as_bool) {
            settings.warm_cache = value;
        }
        if let Some(value) = count(raw.get("reserveTokens")) {
            settings.reserve_tokens = value;
        }
        if let Some(value) = count(raw.get("keepRecentTokens")) {
            settings.keep_recent_tokens = value;
        }
        if let Some(value) = count(raw.get("timeoutMs")).filter(|v| *v > 0) {
            settings.timeout_ms = value;
        }
        if let Some(value) = count(raw.get("maxChunks")).filter(|v| *v > 0) {
            settings.max_chunks = value as usize;
        }
        settings
    }
}

/// Why a compaction runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactionReason {
    Threshold,
    Overflow,
    Manual,
}

impl CompactionReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Threshold => "threshold",
            Self::Overflow => "overflow",
            Self::Manual => "manual",
        }
    }
}

/// `SUMMARY_PROMPT`.
pub const SUMMARY_PROMPT: &str = "Stop working and write a handoff summary of this conversation so far. It will replace the earlier history, so the next assistant must be able to continue seamlessly from it alone.

Use this structure:
## Goal
## Constraints and preferences
## Progress
### Done
### In progress
### Blocked
## Key decisions
## Important context (files, commands, errors, identifiers — exact values)
## Next steps

Be concrete and complete; omit pleasantries. Do not call tools.";

/// `isContextOverflow`.
pub fn is_context_overflow(message: &AssistantMessage) -> bool {
    use std::sync::LazyLock;
    static PATTERN: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(
            r"(?i)context.?length|context.?window|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|max_tokens.*exceed|request too large|HTTP 413",
        )
        .unwrap()
    });
    message.stop_reason == StopReason::Error
        && PATTERN.is_match(message.error_message.as_deref().unwrap_or_default())
}

/// `contextTokens`: provider-reported usage of the latest assistant message
/// plus an estimate for anything appended after it.
pub fn context_tokens(entries: &[(String, Message)]) -> u64 {
    let latest = entries.iter().rposition(|(_, message)| {
        matches!(message, Message::Assistant(m)
            if m.usage.total_tokens > 0 && m.stop_reason != StopReason::Error)
    });
    let (mut tokens, start) = match latest {
        Some(index) => match &entries[index].1 {
            Message::Assistant(m) => (
                m.usage.input + m.usage.cache_read + m.usage.cache_write + m.usage.output,
                index + 1,
            ),
            _ => unreachable!(),
        },
        None => (0, 0),
    };
    for (_, message) in &entries[start..] {
        tokens += estimate_tokens(message);
    }
    tokens
}

/// Keep complete tool groups and the latest human or admitted task turn.
pub fn find_cut_point(entries: &[(String, Message)], keep_recent_tokens: u64) -> Option<String> {
    let safe = crate::tool_history::message_boundaries(entries).ok()?;
    select_cut_point(entries, keep_recent_tokens, &safe)
}
/// The raw branch includes PTC operations omitted from provider messages.
pub(crate) fn find_cut_point_in_branch(
    entries: &[(String, Message)],
    branch: &[crate::session_store::SessionEntry],
    keep_recent_tokens: u64,
) -> Result<Option<String>, String> {
    let safe = crate::handoff::candidate_boundaries(branch)?;
    let ids: std::collections::HashSet<_> = safe
        .into_iter()
        .filter_map(|i| branch.get(i).map(|e| e.id.as_str()))
        .collect();
    let safe = entries
        .iter()
        .enumerate()
        .filter_map(|(i, (id, _))| ids.contains(id.as_str()).then_some(i))
        .collect();
    Ok(select_cut_point(entries, keep_recent_tokens, &safe))
}
fn select_cut_point(
    entries: &[(String, Message)],
    keep_recent_tokens: u64,
    safe: &std::collections::HashSet<usize>,
) -> Option<String> {
    let latest = entries
        .iter()
        .rposition(|(_, m)| crate::tool_history::task_start(m));
    let candidates: Vec<_> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, (_, m))| {
            (safe.contains(&i)
                && latest.is_none_or(|last| i <= last)
                && matches!(m, Message::User { .. } | Message::Custom { .. }))
            .then_some(i)
        })
        .collect();
    let mut kept = 0;
    let mut cut = None;
    for (i, (_, m)) in entries.iter().enumerate().rev() {
        kept += estimate_tokens(m);
        if kept >= keep_recent_tokens && candidates.binary_search(&i).is_ok() {
            cut = Some(i);
            break;
        }
    }
    if cut.is_none() || cut == Some(0) {
        cut = candidates.last().copied();
    }
    let cut = cut?;
    entries[..cut]
        .iter()
        .any(|(_, m)| !matches!(m, Message::CompactionSummary { .. }))
        .then(|| entries[cut].0.clone())
}

/// The outcome of [`run_compaction`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompactionResult {
    pub ok: bool,
    pub error: Option<String>,
    pub tokens_before: Option<u64>,
    pub summary: Option<String>,
}

impl CompactionResult {
    /// `{ ok, tokensBefore, summary }` (the `compact` response).
    pub fn to_json(&self) -> Value {
        let mut out = json!({ "ok": self.ok });
        if let Some(error) = &self.error {
            out["error"] = json!(error);
        }
        if let Some(tokens) = self.tokens_before {
            out["tokensBefore"] = json!(tokens);
        }
        if let Some(summary) = &self.summary {
            out["summary"] = json!(summary);
        }
        out
    }
}

/// `runCompaction`. `Err` only when the session file cannot be written
/// (the TS agent let that escape too).
pub async fn run_compaction(
    agent: &Rc<Agent>,
    reason: CompactionReason,
    signal: &AbortSignal,
    instructions: Option<String>,
    settings: &CompactionSettings,
) -> Result<CompactionResult, String> {
    crate::handoff_compactor::run(agent, reason, signal, instructions, settings).await
}

/// `warmCache`: prime the provider cache with the compacted prefix, only
/// for `openai-chat` providers that opted into long cache retention.
pub fn warm_cache(agent: &Rc<Agent>) {
    let Ok(resolved) = agent.resolve_model(None) else {
        return;
    };
    let mut compat = resolved.provider.compat.clone();
    compat.extend(resolved.model.compat.clone());
    if resolved.provider.api != pirc_protocol::ModelApi::OpenaiChat
        || compat.get("supportsLongCacheRetention") != Some(&Value::Bool(true))
    {
        return;
    }
    let agent = agent.clone();
    // `void warmCache(agent)` ran at once up to its first await: the status
    // and the request's context snapshot come before the caller goes on.
    crate::spawn_eager(async move {
        let controller = AbortController::new();
        let timer = {
            let controller = controller.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                controller.abort();
            })
        };
        let ui = agent.ui();
        ui.set_status("cache-safe-compaction", Some("warming compacted cache…"));
        let prompt = agent.system_prompt();
        let response = agent
            .stream(
                &prompt,
                &controller.signal(),
                StreamOptions {
                    quiet: true,
                    tool_choice: Some(ToolChoice::None),
                    max_tokens: Some(16),
                    thinking: Some(pirc_protocol::ThinkingLevel::Minimal),
                    no_retries: true,
                    ..StreamOptions::default()
                },
            )
            .await;
        let complete = matches!(
            &response,
            Ok(message) if matches!(message.stop_reason, StopReason::Stop | StopReason::Length)
        );
        if !complete && !controller.signal().aborted() {
            ui.notify(
                "Compaction succeeded, but cache warm-up failed; the next turn will continue normally.",
                NotifyLevel::Warning,
            );
        }
        timer.abort();
        ui.set_status("cache-safe-compaction", None);
    });
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Budget {
    pub window: u64,
    pub output: u64,
    pub reserve: u64,
    pub input: u64,
    pub handoff_output: u64,
    pub handoff_input: u64,
    pub prefix: u64,
}
pub fn main_budget(
    agent: &Agent,
    resolved: &crate::agent::ResolvedModel,
    settings: &CompactionSettings,
) -> Budget {
    let window = resolved.model.context_window;
    let output = resolved.model.max_tokens;
    let reserve = settings.reserve_tokens.max(output);
    let handoff_output = 8192.min(output).min(window / 4);
    Budget {
        window,
        output,
        reserve,
        input: window.saturating_sub(reserve),
        handoff_output,
        handoff_input: window.saturating_sub(handoff_output + 512),
        prefix: request_input(agent, &[]),
    }
}
/// Credentials never enter a persisted attempt identity.
pub fn route_identity(resolved: &crate::agent::ResolvedModel) -> String {
    let url = resolved
        .model
        .base_url
        .as_deref()
        .unwrap_or(&resolved.provider.base_url);
    let safe = url
        .split('?')
        .next()
        .unwrap_or(url)
        .split('#')
        .next()
        .unwrap_or(url);
    let safe = if let Some((scheme, rest)) = safe.split_once("://") {
        format!(
            "{scheme}://{}",
            rest.rsplit_once('@').map_or(rest, |(_, host)| host)
        )
    } else {
        safe.to_owned()
    };
    serde_json::json!([
        resolved.provider_name,
        resolved.model.id,
        resolved.model.api.unwrap_or(resolved.provider.api),
        safe,
        resolved.model.canonical_provider,
        resolved.provider.pi_provider,
        resolved.provider.opencode_go,
        resolved.provider.compat,
        resolved.model.compat
    ])
    .to_string()
}
pub fn request_identity(resolved: &crate::agent::ResolvedModel, budget: &Budget) -> String {
    serde_json::json!([route_identity(resolved), budget]).to_string()
}
pub fn request_input(agent: &Agent, messages: &[Message]) -> u64 {
    let prefix = Message::User {
        content: pirc_protocol::UserContent::Text(format!(
            "{}{}",
            agent.system_prompt(),
            serde_json::to_string(&agent.tool_specs()).unwrap_or_default()
        )),
        timestamp: 0,
    };
    estimate_tokens(&prefix)
        + crate::agent::sanitize_history(messages)
            .iter()
            .map(estimate_tokens)
            .sum::<u64>()
}
#[derive(Clone)]
pub struct UsageContext {
    pub message: AssistantMessage,
    pub prefix: String,
    pub identity: String,
    pub estimated_input: u64,
}
pub fn input_tokens(agent: &Agent) -> u64 {
    let entries = agent.context_entries();
    let messages: Vec<_> = entries.iter().map(|(_, m)| m.clone()).collect();
    let estimate = request_input(agent, &messages);
    let Some((id,Message::Assistant(latest)))=entries.iter().rev().find(|(_,m)|matches!(m,Message::Assistant(a)if a.usage.total_tokens>0&&a.stop_reason!=StopReason::Error))else{return estimate};
    let Ok(resolved) = agent.resolve_model(None) else {
        return estimate;
    };
    if (!latest.provider.is_empty() && latest.provider != resolved.provider_name)
        || (!latest.model.is_empty() && latest.model != resolved.model.id)
    {
        return estimate;
    }
    let branch = agent.branch();
    let snapshots = crate::handoff::valid_snapshots(&branch);
    let changed = snapshots
        .last()
        .and_then(|s| branch.iter().position(|e| e.id == s.id))
        .zip(branch.iter().position(|e| e.id == *id))
        .is_some_and(|(a, b)| a > b);
    if let Some(anchor) = agent
        .usage_context
        .borrow()
        .as_ref()
        .filter(|a| a.message == *latest)
    {
        if anchor.identity != route_identity(&resolved) {
            return estimate;
        }
        let prefix = serde_json::json!([agent.system_prompt(), agent.tool_specs()]).to_string();
        if changed || prefix != anchor.prefix {
            let observed = latest.usage.input + latest.usage.cache_read + latest.usage.cache_write;
            let scale = if anchor.estimated_input > 0 {
                (observed as f64 / anchor.estimated_input as f64).max(1.0)
            } else {
                1.0
            };
            return (estimate as f64 * scale).ceil() as u64;
        }
    }
    if changed {
        estimate
    } else {
        estimate.max(context_tokens(&entries))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::CompactionSettings;

    #[test]
    fn settings_take_typed_values_and_ignore_the_rest() {
        let features = json!({ "compaction": {
            "enabled": "yes", "warmCache": false, "reserveTokens": 4096,
            "keepRecentTokens": "12", "timeoutMs": 0, "maxChunks": 2.5
        } });
        let settings = CompactionSettings::from_features(features.as_object().unwrap());
        let defaults = CompactionSettings::default();
        assert_eq!(
            settings,
            CompactionSettings {
                warm_cache: false,
                reserve_tokens: 4096,
                ..defaults
            }
        );
        let none = json!({ "compaction": 5 });
        assert_eq!(
            CompactionSettings::from_features(none.as_object().unwrap()),
            defaults
        );
    }
}
