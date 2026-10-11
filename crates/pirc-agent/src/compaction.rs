//! Context compaction (`agent/compaction.ts`): the context size, the cut
//! point, the summary request and the compaction entry. A feature may
//! replace the summary or cancel the compaction (`beforeCompact`).

use std::rc::Rc;

use pirc_protocol::{
    AssistantContent, AssistantMessage, Message, StopReason, ToolChoice, UserContent,
};
use serde_json::{Map, Value, json};

use crate::agent::{Agent, StreamOptions};
use crate::feature::{CompactContext, CompactDecision, CompactionPlan};
use crate::messages::estimate_tokens;
use crate::now_ms;
use crate::signal::{AbortController, AbortSignal};
use crate::ui::NotifyLevel;

/// `CompactionSettings`, as the TS agent used them: whatever the node's
/// config holds, with JavaScript's truthiness and number coercion.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompactionSettings {
    pub enabled: bool,
    /// Compact when context exceeds `contextWindow - reserveTokens`.
    pub reserve_tokens: f64,
    /// Recent context kept verbatim after the summary.
    pub keep_recent_tokens: f64,
    /// Warm the provider prompt cache after compaction.
    pub warm_cache: bool,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reserve_tokens: 16_384.0,
            keep_recent_tokens: 20_000.0,
            warm_cache: true,
        }
    }
}

/// JavaScript truthiness.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `ToNumber`, as arithmetic and comparisons apply it.
pub(crate) fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => string_to_number(text),
        // Arrays go through `ToString` first; objects are NaN.
        Value::Array(_) => string_to_number(&crate::tools::js::string_of(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// JavaScript `StringToNumber`: JS whitespace trimmed, empty is 0,
/// `Infinity` with an optional sign, `0x`/`0o`/`0b` integers, else a decimal
/// literal; anything else is NaN.
fn string_to_number(text: &str) -> f64 {
    let text = crate::messages::js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let (sign, unsigned) = match text.as_bytes()[0] {
        b'+' => (1.0, &text[1..]),
        b'-' => (-1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = match unsigned.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        // No sign before a radix prefix.
        let digits = &unsigned[2..];
        if unsigned.len() != text.len() || digits.is_empty() {
            return f64::NAN;
        }
        return digits
            .chars()
            .try_fold(0.0f64, |n, c| {
                c.to_digit(radix)
                    .map(|d| n * f64::from(radix) + f64::from(d))
            })
            .unwrap_or(f64::NAN);
    }
    // A decimal literal: digits, at most one dot, an optional exponent.
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => {
            (whole.is_empty() || digits(whole))
                && (fraction.is_empty() || digits(fraction))
                && !(whole.is_empty() && fraction.is_empty())
        }
        None => digits(mantissa),
    };
    let exponent_ok = exponent.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

impl CompactionSettings {
    /// `{ ...defaultCompaction, ...features.compaction }`.
    pub fn from_features(features: &Map<String, Value>) -> Self {
        let mut settings = Self::default();
        let Some(raw) = features.get("compaction").and_then(Value::as_object) else {
            return settings;
        };
        if let Some(value) = raw.get("enabled") {
            settings.enabled = truthy(value);
        }
        if let Some(value) = raw.get("warmCache") {
            settings.warm_cache = truthy(value);
        }
        if let Some(value) = raw.get("reserveTokens") {
            settings.reserve_tokens = to_number(value);
        }
        if let Some(value) = raw.get("keepRecentTokens") {
            settings.keep_recent_tokens = to_number(value);
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
pub fn find_cut_point(entries: &[(String, Message)], keep_recent_tokens: f64) -> Option<String> {
    let is_turn_start =
        |message: &Message| matches!(message, Message::User { .. } | Message::Custom { .. });
    let mut kept = 0;
    let mut cut = entries.len();
    for index in (0..entries.len()).rev() {
        kept += estimate_tokens(&entries[index].1);
        cut = index;
        if kept as f64 >= keep_recent_tokens && is_turn_start(&entries[index].1) {
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

/// `runCompaction`. `Err` only when the session file cannot be written
/// (the TS agent let that escape too).
pub async fn run_compaction(
    agent: &Rc<Agent>,
    reason: CompactionReason,
    signal: &AbortSignal,
    instructions: Option<String>,
    settings: &CompactionSettings,
) -> Result<CompactionResult, String> {
    let entries = agent.context_entries();
    let tokens_before = context_tokens(&entries);
    let keep = if reason == CompactionReason::Overflow {
        0.0
    } else {
        settings.keep_recent_tokens
    };
    let Some(first_kept_entry_id) = find_cut_point(&entries, keep) else {
        return Ok(CompactionResult::failed("Nothing to compact"));
    };
    agent.emit(json!({ "type": "compaction_start", "reason": reason.as_str() }));
    // A feature may replace or cancel the summary.
    let mut plan = None;
    for feature in agent.features().to_vec() {
        let decision = feature
            .before_compact(
                agent,
                CompactContext {
                    first_kept_entry_id: &first_kept_entry_id,
                    tokens_before,
                    signal,
                },
            )
            .await;
        // `await feature.beforeCompact?.(…)` takes a microtask even when the
        // feature has no such hook: whatever was queued meanwhile (the
        // response to the command that started a `/compact`) goes first.
        tokio::task::yield_now().await;
        match decision {
            Ok(None) => continue,
            Ok(Some(CompactDecision::Cancel)) => {
                agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
                    "aborted": true }));
                return Ok(CompactionResult::failed(
                    "Compaction cancelled by extension",
                ));
            }
            Ok(Some(CompactDecision::Plan(found))) => {
                plan = Some(found);
                break;
            }
            Err(error) => {
                agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
                    "aborted": signal.aborted(), "errorMessage": error }));
                return Ok(CompactionResult::failed(error));
            }
        }
    }
    let plan = match plan {
        Some(plan) => plan,
        None => match summarize(agent, signal, instructions, &first_kept_entry_id).await {
            Ok(summary) => CompactionPlan {
                summary,
                first_kept_entry_id: first_kept_entry_id.clone(),
                tokens_before,
                details: None,
            },
            Err(error) => {
                agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
                    "aborted": signal.aborted(), "errorMessage": error }));
                return Ok(CompactionResult::failed(error));
            }
        },
    };
    let entry_id = agent.append_compaction(
        &plan.summary,
        &plan.first_kept_entry_id,
        plan.tokens_before,
        plan.details.clone(),
    )?;
    agent.emit(json!({ "type": "compaction_end", "reason": reason.as_str(),
        "result": { "summary": plan.summary, "tokensBefore": plan.tokens_before,
            "entryId": entry_id } }));
    for feature in agent.features().to_vec() {
        if let Err(error) = feature.after_compact(agent).await {
            agent.ui().notify(
                &format!("{}: {error}", feature.name()),
                NotifyLevel::Warning,
            );
        }
    }
    if settings.warm_cache && reason != CompactionReason::Overflow {
        warm_cache(agent);
    }
    Ok(CompactionResult {
        ok: true,
        error: None,
        tokens_before: Some(plan.tokens_before),
        summary: Some(plan.summary),
    })
}

/// The default summary: the same system prompt, tools and history prefix as
/// normal turns (so the provider's prompt cache is reused), then the
/// summary instruction. `Err` with what failed.
async fn summarize(
    agent: &Rc<Agent>,
    signal: &AbortSignal,
    instructions: Option<String>,
    first_kept_entry_id: &str,
) -> Result<String, String> {
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
                up_to: Some(first_kept_entry_id.to_owned()),
                ..StreamOptions::default()
            },
        )
        .await;
    response.and_then(|response| {
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
    })
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::to_number;

    #[test]
    fn to_number_follows_javascript() {
        let cases = [
            (json!(null), 0.0),
            (json!(true), 1.0),
            (json!(" 12 "), 12.0),
            (json!(""), 0.0),
            (json!("\u{a0}\u{feff}7\n"), 7.0),
            (json!("1e3"), 1000.0),
            (json!("-.5"), -0.5),
            (json!("5."), 5.0),
            (json!("+Infinity"), f64::INFINITY),
            (json!("-Infinity"), f64::NEG_INFINITY),
            (json!("0x1F"), 31.0),
            (json!("0o17"), 15.0),
            (json!("0b101"), 5.0),
            (json!([]), 0.0),
            (json!(["8"]), 8.0),
            (json!([null]), 0.0),
            (json!([[3]]), 3.0),
        ];
        for (value, expected) in cases {
            assert_eq!(to_number(&value), expected, "{value}");
        }
        for value in [
            json!("inf"),
            json!("infinity"),
            json!("NaN"),
            json!("-0x10"),
            json!("0x"),
            json!("."),
            json!("1e"),
            json!("1_000"),
            json!([true]),
            json!([1, 2]),
            json!({}),
        ] {
            assert!(to_number(&value).is_nan(), "{value}");
        }
    }
}
