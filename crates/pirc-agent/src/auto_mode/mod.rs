//! Auto mode (`agent/auto-mode/index.ts`, `rules.ts`): a pre-execution
//! filter for shell actions (`bash`, `background_task` start/write) and for
//! `ptc` scripts, which only the user's deny-list can stop.
//!
//! 1. Static rules ([`rules::classify_shell`]) sort the action into read /
//!    write / danger, or `unknown`. The user's deny-list
//!    (`features.autoMode.deny`) is matched first and always means danger.
//! 2. `unknown` actions would go to a model classifier; that is M5's, so
//!    they are treated as writes (as with `useModel: false`).
//! 3. `danger` needs a human: with a UI the user confirms; headless agents
//!    are refused.
//! 4. Anything that may write takes the node's write lease first: only the
//!    known targets when the rules know every path a command writes, else
//!    the working directory.
//!
//! Keystrokes for a tty task are judged together with the rest of the line
//! they belong to, so a command cannot be smuggled in one harmless-looking
//! fragment at a time.

pub mod rules;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexMap;
use pirc_policy::resolve_path;
use serde_json::{Map, Value};

use crate::host::AgentHost;
use crate::signal::AbortSignal;
use crate::tools::js::{self, JsRegex};
use crate::ui::{DialogOptions, NotifyLevel};
use rules::{Classification, RuleContext, Verdict, classify_shell, compile_deny, deny_match};

/// Whether auto mode is enabled (`autoModeSettings(features).enabled`): the
/// settings are all-or-nothing, so a broken one elsewhere restores the
/// defaults.
pub fn auto_mode_enabled(features: &Map<String, Value>) -> bool {
    let settings = match features.get("autoMode") {
        None | Some(Value::Null) => return true,
        Some(Value::Object(settings)) => settings,
        Some(_) => return true,
    };
    let thinking = ["off", "minimal", "low", "medium", "high", "xhigh"];
    let model_choice = |value: &Value| {
        let Value::Object(choice) = value else {
            return false;
        };
        let text = |key: &str| matches!(choice.get(key), Some(Value::String(s)) if !s.is_empty());
        text("provider")
            && text("id")
            && match choice.get("thinking") {
                None => true,
                Some(Value::String(level)) => thinking.contains(&level.as_str()),
                Some(_) => false,
            }
    };
    let valid = settings.iter().all(|(key, value)| match key.as_str() {
        "enabled" | "useModel" | "useMemory" => value.is_boolean(),
        "model" => model_choice(value),
        "fallbackModels" => value
            .as_array()
            .is_some_and(|items| items.iter().all(model_choice)),
        "timeoutMs" => value
            .as_f64()
            .is_some_and(|ms| ms.fract() == 0.0 && ms > 0.0 && ms <= 120_000.0),
        _ => true,
    });
    if !valid {
        return true;
    }
    settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// `autoModeDeny(features)`: the user's deny-list, read on its own so a
/// mistake elsewhere in the settings cannot drop it; a bare string counts
/// as one pattern.
pub fn auto_mode_deny(features: &Map<String, Value>) -> Vec<String> {
    match features.get("autoMode").and_then(|mode| mode.get("deny")) {
        Some(Value::String(pattern)) => vec![pattern.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// What kind of shell action a call performs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Command,
    Script,
    Input,
}

/// `ShellAction`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellAction {
    pub tool: String,
    pub kind: ActionKind,
    pub text: String,
    pub cwd: String,
}

/// Where a decision came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Rules,
    Model,
    Fallback,
}

/// `AutoModeDecision`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub classification: Classification,
    pub source: Source,
}

/// Unsubmitted tty input kept per task (the current line).
const INPUT_LINE_LIMIT: usize = 4_096;
const INPUT_TASK_LIMIT: usize = 64;
const TRUNCATED: &str = "⟨earlier keystrokes truncated⟩";
const CTRL_C: &str = "⟨Ctrl-C⟩";

/// `visibleKeys`: control keys become `⟨Ctrl-X⟩` (`⟨Esc⟩`, `⟨Tab⟩` …) so
/// neither the rules nor the model mistake them for text.
pub fn visible_keys(input: &str) -> String {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    for c in normalized.chars() {
        let code = c as u32;
        if code <= 0x08 || (0x0b..=0x1f).contains(&code) || code == 0x7f || c == '\t' {
            let name = match c {
                '\u{1b}' => "Esc".to_owned(),
                '\u{7f}' | '\u{08}' => "Backspace".to_owned(),
                '\t' => "Tab".to_owned(),
                _ => format!(
                    "Ctrl-{}",
                    char::from_u32(code + 64).expect("an ASCII letter")
                ),
            };
            out.push_str(&format!("⟨{name}⟩"));
        } else {
            out.push(c);
        }
    }
    out
}

struct PendingLine {
    text: String,
    truncated: bool,
}

/// `String(args.id ?? '')`.
fn id_of(args: &Map<String, Value>) -> String {
    match args.get("id") {
        None | Some(Value::Null) => String::new(),
        Some(value) => js::string_of(value),
    }
}

/// `AutoMode`.
#[derive(Default)]
pub struct AutoMode {
    /// Per tty task: what was typed since the last Enter (or Ctrl-C).
    lines: RefCell<IndexMap<String, PendingLine>>,
    /// Per tty task: writes are judged one at a time, in order.
    input_gates: RefCell<HashMap<String, Rc<tokio::sync::Mutex<()>>>>,
    warned_deny: RefCell<String>,
}

impl AutoMode {
    pub fn new() -> Self {
        Self::default()
    }

    fn deny(&self, host: &dyn AgentHost) -> Vec<JsRegex> {
        let (deny, invalid) = compile_deny(&auto_mode_deny(&host.config().features));
        let key = invalid.join("\n");
        if !key.is_empty() && *self.warned_deny.borrow() != key {
            *self.warned_deny.borrow_mut() = key;
            host.ui().notify(
                &format!(
                    "Auto mode: deny-list pattern(s) are not valid regular expressions and are matched as plain text: {}",
                    invalid.join(", ")
                ),
                NotifyLevel::Warning,
            );
        }
        deny
    }

    /// Static verdict for an action.
    fn rules_verdict(&self, host: &dyn AgentHost, action: &ShellAction) -> Classification {
        let deny = self.deny(host);
        if action.kind == ActionKind::Script {
            return deny_match(&action.text, &deny).unwrap_or_else(|| Classification {
                verdict: Verdict::Read,
                reason: "a ptc script has no authority of its own; its operations are checked one by one".to_owned(),
                denied: false,
                writes: None,
            });
        }
        let config = host.config();
        let guard = host.guard();
        let rules = classify_shell(
            &action.text,
            &RuleContext {
                cwd: &action.cwd,
                roots: guard.allowed_roots(),
                protected_paths: &config.protected_paths,
                home: None,
                deny: &deny,
            },
        );
        if action.kind == ActionKind::Input
            && action.text.contains('⟨')
            && matches!(rules.verdict, Verdict::Read | Verdict::Write)
        {
            return Classification {
                verdict: Verdict::Unknown,
                reason: "the keystrokes include terminal control keys (editing, completion or history) or are partly shown".to_owned(),
                denied: false,
                writes: None,
            };
        }
        rules
    }

    /// `actionFor`: the action a tool call would perform, or `None` when
    /// auto mode does not gate it.
    pub fn action_for(
        &self,
        host: &dyn AgentHost,
        tool: &str,
        args: &Map<String, Value>,
    ) -> Option<ShellAction> {
        let cwd = host.config().workspace.clone();
        let action = |kind, text: &str, cwd: String| {
            Some(ShellAction {
                tool: tool.to_owned(),
                kind,
                text: text.to_owned(),
                cwd,
            })
        };
        match (tool, args.get("action")) {
            ("bash", _) => match args.get("command") {
                Some(Value::String(command)) => action(ActionKind::Command, command, cwd),
                _ => None,
            },
            // Scripts run isolated; their operations are gated one by one.
            ("ptc", _) => match args.get("code") {
                Some(Value::String(code)) => action(ActionKind::Script, code, cwd),
                _ => None,
            },
            ("background_task", Some(Value::String(kind))) if kind == "start" => {
                let Some(Value::String(command)) = args.get("command") else {
                    return None;
                };
                let dir = match args.get("cwd") {
                    None | Some(Value::Null) => ".".to_owned(),
                    Some(value) => js::string_of(value),
                };
                let dir = dir.strip_prefix('@').unwrap_or(&dir);
                action(ActionKind::Command, command, resolve_path(&cwd, dir))
            }
            ("background_task", Some(Value::String(kind))) if kind == "write" => {
                let Some(Value::String(input)) = args.get("input") else {
                    return None;
                };
                let lines = self.lines.borrow();
                let line = lines.get(&id_of(args));
                let text = format!(
                    "{}{}",
                    line.map_or("", |line| line.text.as_str()),
                    visible_keys(input)
                );
                let text = if line.is_some_and(|line| line.truncated) {
                    format!("{TRUNCATED}{text}")
                } else {
                    text
                };
                action(ActionKind::Input, &text, cwd)
            }
            _ => None,
        }
    }

    /// Remember the unsubmitted part of a tty task's input after it was let
    /// through.
    fn typed(&self, args: &Map<String, Value>, action: &ShellAction) {
        let id = id_of(args);
        let mut truncated = action.text.starts_with(TRUNCATED);
        let mut text = action
            .text
            .strip_prefix(TRUNCATED)
            .unwrap_or(&action.text)
            .to_owned();
        // Enter submits the line; Ctrl-C discards it.
        let submitted = text
            .rfind('\n')
            .map_or(0, |index| index + 1)
            .max(text.rfind(CTRL_C).map_or(0, |index| index + CTRL_C.len()));
        if submitted > 0 {
            text = text[submitted..].to_owned();
            truncated = false;
        }
        let mut lines = self.lines.borrow_mut();
        lines.shift_remove(&id);
        if text.is_empty() {
            return;
        }
        if js::len16(&text) > INPUT_LINE_LIMIT {
            text = js::tail16(&text, INPUT_LINE_LIMIT).to_owned();
            truncated = true;
        }
        if lines.len() >= INPUT_TASK_LIMIT {
            lines.shift_remove_index(0);
        }
        lines.insert(id, PendingLine { text, truncated });
    }

    /// `classify`: the decision for an action. The model classifier is
    /// M5's: an unclear action is treated as a write.
    pub fn classify(&self, host: &dyn AgentHost, action: &ShellAction) -> Decision {
        let rules = self.rules_verdict(host, action);
        let decided = |classification| Decision {
            classification,
            source: Source::Rules,
        };
        // The deny-list is the user's own rule: it holds even with auto mode off.
        if rules.denied {
            return decided(rules);
        }
        if !auto_mode_enabled(&host.config().features) {
            // Lease decision only: anything that is not clearly read-only writes.
            return if matches!(rules.verdict, Verdict::Read | Verdict::Write) {
                decided(rules)
            } else {
                decided(Classification {
                    verdict: Verdict::Write,
                    reason: rules.reason,
                    denied: false,
                    writes: None,
                })
            };
        }
        if rules.verdict != Verdict::Unknown {
            return decided(rules);
        }
        Decision {
            classification: Classification {
                verdict: Verdict::Write,
                reason: format!("{} (model check disabled)", rules.reason),
                denied: false,
                writes: None,
            },
            source: Source::Fallback,
        }
    }

    /// `gate`: `Ok(Some(refusal))` for the model, `Ok(None)` when the call
    /// may run (after taking the write lease when needed), `Err` when the
    /// lease was refused.
    pub async fn gate(
        &self,
        host: &dyn AgentHost,
        tool: &str,
        args: &Map<String, Value>,
        signal: &AbortSignal,
    ) -> Result<Option<String>, String> {
        // Keystrokes for one task are judged one write at a time: concurrent
        // writes must not split a line into pieces judged apart.
        let input = tool == "background_task"
            && matches!(args.get("action"), Some(Value::String(action)) if action == "write");
        if !input {
            return self.gate_now(host, tool, args, signal).await;
        }
        let id = id_of(args);
        let gate = self
            .input_gates
            .borrow_mut()
            .entry(id.clone())
            .or_default()
            .clone();
        let result = {
            let _turn = gate.lock().await;
            self.gate_now(host, tool, args, signal).await
        };
        // Only the map and this call hold it: nobody else is waiting.
        if Rc::strong_count(&gate) == 2 {
            self.input_gates.borrow_mut().remove(&id);
        }
        result
    }

    async fn gate_now(
        &self,
        host: &dyn AgentHost,
        tool: &str,
        args: &Map<String, Value>,
        signal: &AbortSignal,
    ) -> Result<Option<String>, String> {
        let Some(action) = self.action_for(host, tool, args) else {
            return Ok(None);
        };
        let decision = self.classify(host, &action);
        if decision.classification.verdict == Verdict::Danger
            && let Some(refusal) = self
                .approve(host, &action, &decision.classification.reason, signal)
                .await
        {
            return Ok(Some(refusal));
        }
        if decision.classification.verdict != Verdict::Read {
            for target in lease_targets(&action, &decision) {
                host.acquire_write(&target, signal).await?;
            }
        }
        if action.kind == ActionKind::Input {
            self.typed(args, &action);
        }
        Ok(None)
    }

    async fn approve(
        &self,
        host: &dyn AgentHost,
        action: &ShellAction,
        reason: &str,
        signal: &AbortSignal,
    ) -> Option<String> {
        let advice = "Do not try to reach the same effect another way; explain what you intended and ask the user to run or approve it.";
        if !host.has_ui() {
            return Some(format!(
                "{reason}. Dangerous actions need a human and this agent has no UI. {advice}"
            ));
        }
        let label = match action.kind {
            ActionKind::Input => "Input",
            ActionKind::Script => "Script",
            ActionKind::Command => "Command",
        };
        let message = format!(
            "{label} ({}, in {}):\n\n{}\n\nReason: {reason}",
            action.tool,
            action.cwd,
            js::head16(&action.text, 4_000)
        );
        let answer = host
            .ui()
            .confirm(
                "Auto mode: allow a potentially dangerous action?",
                &message,
                DialogOptions {
                    signal: Some(signal.clone()),
                    ..DialogOptions::default()
                },
            )
            .await;
        if answer == Some(true) {
            return None;
        }
        Some(format!(
            "{reason}. The user {} it. {advice}",
            if answer == Some(false) {
                "declined"
            } else {
                "did not approve"
            }
        ))
    }
}

/// What a writing action's lease must cover: the exact targets when the
/// static rules know every path a command writes, else its whole working
/// directory. Keystrokes are excluded: their shell may have moved.
fn lease_targets(action: &ShellAction, decision: &Decision) -> Vec<String> {
    let classification = &decision.classification;
    if action.kind == ActionKind::Command
        && decision.source == Source::Rules
        && classification.verdict == Verdict::Write
        && let Some(writes) = classification.writes.as_ref().filter(|w| !w.is_empty())
    {
        let mut unique: Vec<String> = Vec::new();
        for target in writes {
            if !unique.contains(target) {
                unique.push(target.clone());
            }
        }
        return unique;
    }
    vec![action.cwd.clone()]
}

#[cfg(test)]
mod tests;
