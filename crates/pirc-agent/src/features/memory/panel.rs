//! The structured observational-memory view of the web side panel
//! (`features/memory/panel.ts`): a pure function of the session branch, so
//! the node can build it from the session file whether or not the agent
//! runs. The agent counts its visible memory in the context snapshot.

use serde_json::{Map, Value, json};

use super::config::MemoryConfig;
use super::ledger::{
    LedgerType, fold_ledger, pool_tokens, raw_tokens_since_last_compaction, tokens_since_coverage,
    visible_projection,
};
use super::{compact_threshold, pool_target};
use crate::compaction::context_tokens;
use crate::session_store::{EntryData, SessionEntry, context_entries_of};

/// `memoryPanel(branch, config, contextWindow)`.
pub fn memory_panel(
    branch: &[SessionEntry],
    config: &MemoryConfig,
    context_window: Option<u64>,
) -> Value {
    let folded = fold_ledger(branch);
    let visible = visible_projection(branch);
    let observation_ids: std::collections::HashSet<&str> =
        visible.observations.iter().map(|o| o.id.as_str()).collect();
    let reflection_ids: std::collections::HashSet<&str> =
        visible.reflections.iter().map(|r| r.id.as_str()).collect();
    let visible_observation = |id: &str| observation_ids.contains(id);
    let visible_reflection = |id: &str| reflection_ids.contains(id);
    let current = context_tokens(&context_entries_of(branch));
    let compactions: Vec<&SessionEntry> = branch
        .iter()
        .filter(|entry| matches!(entry.data, EntryData::Compaction { .. }))
        .collect();
    let target = pool_target(config);
    let threshold = |value: f64, max: f64| json!({ "value": value as u64, "max": max as u64 });
    let mut out = json!({
        "architecture":"handoff",
        "handoff":{"snapshots":crate::handoff::valid_snapshots(branch).len(),"latest":crate::handoff::valid_snapshots(branch).last().map(|e|e.id.clone()),"legacyAncestry":crate::handoff::valid_snapshots(branch).last().and_then(|e|crate::handoff::details(e).and_then(|h|h.legacy_base_id)),"textOnly":true},
        "enabled": true,
        "passive": config.passive,
        "thresholds": {
            "observation": threshold(
                tokens_since_coverage(branch, LedgerType::Observations, current) as f64,
                config.observe_after_tokens as f64,
            ),
            "reflection": threshold(
                tokens_since_coverage(branch, LedgerType::Reflections, current) as f64,
                config.reflect_after_tokens as f64,
            ),
            "compaction": threshold(
                raw_tokens_since_last_compaction(branch) as f64,
                compact_threshold(config, context_window) as f64,
            ),
            "visiblePool": {
                "value": crate::messages::js::number_value(pool_tokens(&visible.observations)),
                "max": config.observations_pool_max_tokens,
            },
            "activePool": threshold(
                pool_tokens(&folded.active_observations),
                target as f64,
            ),
        },
        "counts": {
            "observations": folded.observations.len(),
            "active": folded.active_observations.len(),
            "dropped": folded.dropped.len(),
            "visibleObservations": visible.observations.len(),
            "reflections": folded.reflections.len(),
            "visibleReflections": visible.reflections.len(),
            "compactions": compactions.len(),
        },
        "observations": folded.observations.iter().map(|o| {
            let mut item = Map::new();
            item.insert("id".to_owned(), json!(o.id));
            item.insert("content".to_owned(), json!(o.content));
            item.insert("timestamp".to_owned(), json!(o.timestamp));
            item.insert("relevance".to_owned(), json!(o.relevance.as_str()));
            item.insert("tokenCount".to_owned(), o.raw["tokenCount"].clone());
            item.insert("dropped".to_owned(), json!(folded.dropped.contains(&o.id)));
            item.insert("visible".to_owned(), json!(visible_observation(&o.id)));
            Value::Object(item)
        }).collect::<Vec<_>>(),
        "reflections": folded.reflections.iter().map(|r| json!({
            "id": r.id,
            "content": r.content,
            "supportingObservationIds": r.supporting_observation_ids,
            "tokenCount": r.raw["tokenCount"].clone(),
            "visible": visible_reflection(&r.id),
        })).collect::<Vec<_>>(),
    });
    if let Some(last) = compactions.last() {
        out["lastCompactionAt"] = json!(last.timestamp);
    }
    out
}

/// The tokens of the memory the latest folded compaction shows, as the
/// panel counts them: the ledger's visible observations and reflections
/// (`memoryTokens` of the context snapshot, `agent.ts` `stream`).
pub fn visible_memory_tokens(branch: &[SessionEntry]) -> f64 {
    let folded = fold_ledger(branch);
    let visible = visible_projection(branch);
    let observation_ids: std::collections::HashSet<&str> =
        visible.observations.iter().map(|o| o.id.as_str()).collect();
    let reflection_ids: std::collections::HashSet<&str> =
        visible.reflections.iter().map(|r| r.id.as_str()).collect();
    let observations: f64 = folded
        .observations
        .iter()
        .filter(|o| observation_ids.contains(o.id.as_str()))
        .map(|o| o.token_count)
        .fold(0.0, |sum, n| sum + n);
    let reflections: f64 = folded
        .reflections
        .iter()
        .filter(|r| reflection_ids.contains(r.id.as_str()))
        .map(|r| r.token_count)
        .fold(0.0, |sum, n| sum + n);
    observations + reflections
}
