//! Read-only compatibility archive. Session handoffs and repository extraction are independent.
pub mod config;
pub mod ledger;
pub mod panel;
pub mod serialize;
mod time;
pub mod workspace;
use self::config::{MemoryConfig, memory_config_from};
use self::ledger::{
    OBS_DROPPED, OBS_RECORDED, Observation, REF_RECORDED, Reflection, custom_data, is_memory_id,
    observation_line, reflection_line,
};
use self::serialize::{Style, render_message};
use self::workspace::Recalled;
use crate::tools::js;
use crate::{
    LocalBoxFuture,
    agent::Agent,
    channels::{ChannelError, process_gateway},
    feature::{Feature, FeatureCommand},
    session_store::{EntryData, SessionEntry},
    tools::{Tool, ToolContext, ToolResult},
    ui::NotifyLevel,
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    rc::{Rc, Weak},
};
pub fn memory_config(agent: &Agent) -> MemoryConfig {
    let mut c = memory_config_from(&agent.config().features);
    c.enabled &= !agent
        .config()
        .feature_disabled_by_mode("observationalMemory");
    c
}
pub fn pool_target(c: &MemoryConfig) -> u64 {
    c.observations_pool_target_tokens
        .filter(|v| *v < c.observations_pool_max_tokens)
        .unwrap_or(c.observations_pool_max_tokens / 2)
}
pub fn compact_threshold(c: &MemoryConfig, window: Option<u64>) -> u64 {
    if c.compact_after_ratio_mode {
        window
            .filter(|n| *n > 0)
            .map(|n| ((n as f64 * c.compact_after_tokens_ratio).floor() as u64).max(1))
            .unwrap_or(c.compact_after_tokens)
    } else {
        c.compact_after_tokens
    }
}
pub fn recall(branch: &[SessionEntry], id: &str) -> Recalled {
    if !is_memory_id(id) {
        return (
            format!("Memory id must be 12 lowercase hex characters. Received: {id}"),
            "invalid_id".to_owned(),
        );
    }
    let mut observations: Vec<Observation> = Vec::new();
    let mut reflections: Vec<Reflection> = Vec::new();
    let mut dropped: HashSet<String> = HashSet::new();
    let array = |entry: &SessionEntry, kind: &str, key: &str| -> Vec<Value> {
        custom_data(entry, kind)
            .and_then(|data| data.get(key))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    for entry in branch {
        observations.extend(
            array(entry, OBS_RECORDED, "observations")
                .iter()
                .filter_map(Observation::parse),
        );
        reflections.extend(
            array(entry, REF_RECORDED, "reflections")
                .iter()
                .filter_map(Reflection::parse),
        );
        dropped.extend(
            array(entry, OBS_DROPPED, "observationIds")
                .iter()
                .map(js::string_of),
        );
    }
    let matched_obs: Vec<&Observation> = observations.iter().filter(|o| o.id == id).collect();
    let matched_ref: Vec<&Reflection> = reflections.iter().filter(|r| r.id == id).collect();
    if matched_obs.is_empty() && matched_ref.is_empty() {
        return (
            format!("No observation or reflection with id {id} was found on the current branch."),
            "not_found".to_owned(),
        );
    }
    let mut missing_obs: Vec<&str> = Vec::new();
    let mut obs_set: Vec<&Observation> = matched_obs.clone();
    for r in &matched_ref {
        for oid in &r.supporting_observation_ids {
            match observations.iter().find(|o| o.id == *oid) {
                None => missing_obs.push(oid),
                Some(found) => {
                    if !obs_set.iter().any(|o| o.id == found.id) {
                        obs_set.push(found);
                    }
                }
            }
        }
    }
    let by_id: std::collections::HashMap<&str, &SessionEntry> = branch
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let (mut missing, mut non_source, mut sources) = (Vec::new(), Vec::new(), Vec::new());
    let mut seen: HashSet<&str> = HashSet::new();
    for o in &obs_set {
        for sid in &o.source_entry_ids {
            if !seen.insert(sid) {
                continue;
            }
            match by_id.get(sid.as_str()).map(|entry| &entry.data) {
                None => missing.push(sid.as_str()),
                Some(EntryData::Message(message)) => {
                    sources.push(render_message(message, Style::Recall));
                }
                Some(_) => non_source.push(sid.as_str()),
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    let matched = matched_obs.len() + matched_ref.len();
    if matched > 1 {
        parts.push(format!("Note: id {id} matched {matched} records."));
    }
    if !matched_ref.is_empty() {
        let lines: Vec<String> = matched_ref.iter().map(|r| reflection_line(r)).collect();
        parts.push(format!("Reflections:\n{}", lines.join("\n")));
    }
    if !obs_set.is_empty() {
        let lines: Vec<String> = obs_set
            .iter()
            .map(|o| {
                if dropped.contains(&o.id) {
                    format!(
                        "[{}] [dropped] {} [{}] {}",
                        o.id,
                        o.timestamp,
                        o.relevance.as_str(),
                        o.content
                    )
                } else {
                    observation_line(o)
                }
            })
            .collect();
        parts.push(format!("Observations:\n{}", lines.join("\n")));
    }
    if matched_ref.is_empty() {
        for o in &matched_obs {
            if dropped.contains(&o.id) {
                parts.push(format!(
                    "Observation {} is dropped from active memory but remains recallable.",
                    o.id
                ));
            }
        }
    }
    if !missing_obs.is_empty() {
        parts.push(format!(
            "Unavailable supporting observations: {}",
            missing_obs.join(", ")
        ));
    }
    if !missing.is_empty() || !non_source.is_empty() {
        let list = |items: &[&str]| {
            if items.is_empty() {
                "none".to_owned()
            } else {
                items.join(", ")
            }
        };
        parts.push(format!(
            "Unavailable source entries: missing: {}; non-source: {}",
            list(&missing),
            list(&non_source)
        ));
    }
    let incomplete = !missing.is_empty() || !non_source.is_empty();
    let status = if sources.is_empty() {
        parts.push("No source entries are available for this memory.".to_owned());
        if incomplete {
            "source_unavailable"
        } else {
            "no_source"
        }
    } else {
        parts.push(format!("Sources:\n{}", sources.join("\n\n")));
        if incomplete || !missing_obs.is_empty() {
            "partial"
        } else {
            "ok"
        }
    };
    (parts.join("\n\n"), status.to_owned())
}

struct RecallTool {
    agent: Weak<Agent>,
    parameters: Map<String, Value>,
    schema: Value,
}
impl Tool for RecallTool {
    fn name(&self) -> &str {
        "recall"
    }
    fn description(&self) -> &str {
        "Read a legacy memory ID and its authorized original evidence. Use history_search/history_read for current-session source text. Replayed evidence is never a fresh observation."
    }
    fn parameters(&self) -> &Map<String, Value> {
        &self.parameters
    }
    fn ptc(&self) -> bool {
        true
    }
    fn result_schema(&self) -> Option<&Value> {
        Some(&self.schema)
    }
    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(async move {
            if ctx.signal.aborted() {
                return Err("Aborted".into());
            }
            let agent = self.agent.upgrade().ok_or("Agent stopped")?;
            let id = args.get("id").and_then(Value::as_str).unwrap_or("");
            let mut found = recall(&agent.branch(), id);
            if found.1 == "not_found"
                && agent.config().mode().workspace_memory
                && crate::channels::team_child_name(&|n| std::env::var(n).ok()).is_none()
                && let Some(g) = process_gateway()
            {
                match g
                    .gateway
                    .request(
                        "workspace.recall",
                        json!({"id":id}).as_object().unwrap().clone(),
                        Some(&ctx.signal),
                    )
                    .await
                {
                    Ok(v) => {
                        found = (
                            v["text"].as_str().unwrap_or("").into(),
                            v["status"].as_str().unwrap_or("source_unavailable").into(),
                        )
                    }
                    Err(e) => return Ok(ToolResult::error(e.message())),
                }
            }
            if found.1 == "not_found"
                && agent.config().mode().full_assistant()
                && agent.capabilities().allows("remote_recall")
                && let Some(g) = process_gateway()
            {
                match g
                    .gateway
                    .request(
                        "recall.remote",
                        json!({"id":id}).as_object().unwrap().clone(),
                        Some(&ctx.signal),
                    )
                    .await
                {
                    Ok(v) => {
                        found = (
                            v["text"].as_str().unwrap_or("").into(),
                            v["status"].as_str().unwrap_or("source_unavailable").into(),
                        )
                    }
                    Err(ChannelError::Coded { code, .. }) if code == "not_found" => {}
                    Err(e) => return Ok(ToolResult::error(e.message())),
                }
            }
            let mut result = ToolResult::text(crate::redact::redact_secrets(&found.0));
            result.data = Some(
                json!({"id":id,"status":found.1})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            result.details = Some(json!({"memoryReplay":true}));
            Ok(result)
        })
    }
}
struct Archive;
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(Archive)
}
impl Feature for Archive {
    fn name(&self) -> &'static str {
        "observational-memory"
    }
    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        let mut tools = super::workspace_memory::history_tools(agent);
        tools.extend(vec![Rc::new(RecallTool{agent:Rc::downgrade(agent),parameters:json!({"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{12}$"}},"required":["id"],"additionalProperties":false}).as_object().unwrap().clone(),schema:json!({"type":"object","properties":{"id":{"type":"string"},"status":{"type":"string"}}})}) as Rc<dyn Tool>]);
        tools
    }
    fn commands(&self) -> Vec<FeatureCommand> {
        vec![
            FeatureCommand::new("om:status", "Session handoff and legacy memory status"),
            FeatureCommand::new("om:view", "Read the legacy memory archive"),
        ]
    }
    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        name: &'a str,
        _args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let branch = agent.branch();
            let text = if name == "om:view" {
                let fold = ledger::fold_ledger(&branch);
                fold.observations
                    .iter()
                    .map(observation_line)
                    .chain(fold.reflections.iter().map(reflection_line))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                format!(
                    "Session handoffs: {}\nLegacy memory is read-only; use /compact for session state and /om:workspace for repository knowledge.",
                    crate::handoff::valid_snapshots(&branch).len()
                )
            };
            agent.ui().notify(&text, NotifyLevel::Info);
            Ok(())
        })
    }
    fn panel(&self, agent: &Rc<Agent>) -> Option<Map<String, Value>> {
        Some(json!({"memory":panel::memory_panel(&agent.branch(),&memory_config(agent),agent.resolve_model(None).ok().map(|r|r.model.context_window))}).as_object().unwrap().clone())
    }
}

#[cfg(test)]
mod tests;
