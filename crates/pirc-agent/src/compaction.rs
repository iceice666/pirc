//! Context compaction (`agent/compaction.ts`): the context size, the cut
//! point, the summary request and the compaction entry. Custom compactions
//! of features (`beforeCompact`, observational memory) are M5's.

use std::rc::Rc;

use pirc_protocol::{
    AssistantContent, AssistantMessage, Message, StopReason, ToolChoice, UserContent,
};
use serde_json::{Map, Value, json};

use crate::agent::{Agent, StreamOptions};
use crate::messages::estimate_tokens;
use crate::now_ms;
use crate::signal::{AbortController, AbortSignal};
use crate::ui::NotifyLevel;

/// `CompactionSettings`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactionSettings {
    pub enabled: bool,
    /// Compact when context exceeds `contextWindow - reserveTokens`.
    pub reserve_tokens: u64,
    /// Recent context kept verbatim after the summary.
    pub keep_recent_tokens: u64,
    /// Warm the provider prompt cache after compaction.
    pub warm_cache: bool,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reserve_tokens: 16_384,
            keep_recent_tokens: 20_000,
            warm_cache: true,
        }
    }
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
        let number = |key: &str| {
            raw.get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| n.max(0.0) as u64)
        };
        if let Some(value) = number("reserveTokens") {
            settings.reserve_tokens = value;
        }
        if let Some(value) = number("keepRecentTokens") {
            settings.keep_recent_tokens = value;
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
    fn as_str(self) -> &'static str {
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

/// `findCutPoint`: the first entry kept verbatim, at the start of a user
/// turn; the latest user turn is always kept.
pub fn find_cut_point(entries: &[(String, Message)], keep_recent_tokens: u64) -> Option<String> {
    let is_turn_start =
        |message: &Message| matches!(message, Message::User { .. } | Message::Custom { .. });
    let mut kept = 0;
    let mut cut = entries.len();
    for index in (0..entries.len()).rev() {
        kept += estimate_tokens(&entries[index].1);
        cut = index;
        if kept >= keep_recent_tokens && is_turn_start(&entries[index].1) {
            break;
        }
    }
    while cut > 0 && !is_turn_start(&entries[cut].1) {
        cut -= 1;
    }
    if cut == 0 {
        // The whole context is smaller than the keep budget: keep the last turn.
        cut = entries.len().saturating_sub(1);
        while cut > 0 && !is_turn_start(&entries[cut].1) {
            cut -= 1;
        }
    }
    let summarizable = entries[..cut.min(entries.len())]
        .iter()
        .any(|(_, message)| !matches!(message, Message::CompactionSummary { .. }));
    if !summarizable || cut >= entries.len() {
        return None;
    }
    Some(entries[cut].0.clone())
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
    fn failed(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            ..Self::default()
        }
    }

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

/// `runCompaction`.
pub async fn run_compaction(
    agent: &Rc<Agent>,
    reason: CompactionReason,
    signal: &AbortSignal,
    instructions: Option<String>,
    settings: &CompactionSettings,
) -> CompactionResult {
    let entries = agent.context_entries();
    let tokens_before = context_tokens(&entries);
    let keep = if reason == CompactionReason::Overflow {
        0
    } else {
        settings.keep_recent_tokens
    };
    let Some(first_kept_entry_id) = find_cut_point(&entries, keep) else {
        return CompactionResult::failed("Nothing to compact");
    };
    agent.emit(json!({ "type": "compaction_start", "reason": reason.as_str() }));
    // `beforeCompact` of features (M5) may replace or cancel the summary.
    let text = match instructions.filter(|text| !text.is_empty()) {
        Some(extra) => format!("{SUMMARY_PROMPT}\n\nAdditional focus from the user: {extra}"),
        None => SUMMARY_PROMPT.to_owned(),
    };
    let prompt = agent.system_prompt();
    let response = agent
        .stream(
            &prompt,
            signal,
            StreamOptions {
                quiet: true,
                tool_choice: Some(ToolChoice::None),
                extra_messages: vec![Message::User {
                    content: UserContent::Text(text),
                    timestamp: now_ms(),
                }],
                up_to: Some(first_kept_entry_id.clone()),
                ..StreamOptions::default()
            },
        )
        .await;
    let outcome = response.and_then(|response| {
        let summary: String = response
            .content
            .iter()
            .filter_map(|part| match part {
                AssistantContent::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let summary = summary
            .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
            .to_owned();
        if matches!(
            response.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) || summary.is_empty()
        {
            return Err(response.error_message.unwrap_or_else(|| {
                format!(
                    "Summarizer stopped: {}",
                    serde_json::to_value(response.stop_reason)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default()
                )
            }));
        }
        Ok(summary)
    });
    let summary = match outcome {
        Ok(summary) => summary,
        Err(error) => {
            agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
                "aborted": signal.aborted(), "errorMessage": error }));
            return CompactionResult::failed(error);
        }
    };
    let entry_id = agent.append_compaction(&summary, &first_kept_entry_id, tokens_before, None);
    agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
        "result": { "summary": summary, "tokensBefore": tokens_before, "entryId": entry_id } }));
    // `afterCompact` of features (M5).
    if settings.warm_cache && reason != CompactionReason::Overflow {
        warm_cache(agent);
    }
    CompactionResult {
        ok: true,
        error: None,
        tokens_before: Some(tokens_before),
        summary: Some(summary),
    }
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
    tokio::task::spawn_local(async move {
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
