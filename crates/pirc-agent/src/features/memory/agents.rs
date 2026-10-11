//! The observer, reflector and dropper (`features/memory/agents.ts`):
//! their prompts, tools and the drop selection.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::ledger::{
    Observation, RELEVANCES, Reflection, Relevance, hash_id, local_stamp_now, observation_line,
    observation_tokens, reflection_line, sort_unique, truncate_content,
};
use super::serialize::Chunk;
use super::time::parse_local_minute;
use super::worker::WorkerTool;
use crate::redact::redact_secrets;
use crate::tools::js::{self, locale_string_en_us};

/// `lines(items)`.
pub fn lines(items: &[String]) -> String {
    if items.is_empty() {
        "(none yet)".to_owned()
    } else {
        items.join("\n")
    }
}

/// `n.toLocaleString()`.
pub fn locale(n: f64) -> String {
    locale_string_en_us(n)
}

/// `text.replace(/\s*[\r\n]+\s*/g, ' ')`: every whitespace run holding a
/// line break becomes one space.
pub fn join_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |out: &mut String, run: &mut String| {
        if run.contains(['\r', '\n']) {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if js::is_space(c) {
            run.push(c);
        } else {
            flush(&mut out, &mut run);
            out.push(c);
        }
    }
    flush(&mut out, &mut run);
    out
}

/// A string array argument's items (`Array.isArray(v) ? v : []`).
fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `[...new Set(ids)].sort((a, b) => order.get(a) - order.get(b))`.
fn ordered(ids: &[String], order: &HashMap<String, usize>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out.sort_by_key(|id| order[id]);
    out
}

/// Ids that all name known records, or `None`.
fn known_ids(value: Option<&Value>, order: &HashMap<String, usize>) -> Option<Vec<String>> {
    let ids = items(value);
    if ids.is_empty() {
        return None;
    }
    ids.iter()
        .map(|id| {
            id.as_str()
                .filter(|id| order.contains_key(*id))
                .map(str::to_owned)
        })
        .collect()
}

// ---------- observer ----------

/// `observerPrompt`.
pub fn observer_prompt(
    chunk: &Chunk,
    reflections: &[Reflection],
    observations: &[Observation],
) -> String {
    format!(
        "Current local time: {}

CURRENT REFLECTIONS:
{}

CURRENT OBSERVATIONS:
{}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
{}",
        local_stamp_now(),
        lines(&reflections.iter().map(reflection_line).collect::<Vec<_>>()),
        lines(&observations.iter().map(observation_line).collect::<Vec<_>>()),
        js::trim(&chunk.text)
    )
}

/// `observerTool`: `record_observations`.
pub struct ObserverTool {
    order: HashMap<String, usize>,
    origins: IndexMap<String, String>,
    pub out: Vec<Observation>,
}

impl ObserverTool {
    pub fn new(chunk: &Chunk) -> Self {
        Self {
            order: chunk
                .source_entry_ids
                .iter()
                .enumerate()
                .map(|(index, id)| (id.clone(), index))
                .collect(),
            origins: chunk.origins.clone(),
            out: Vec::new(),
        }
    }
}

fn is_stamp(value: Option<&Value>) -> bool {
    let Some(text) = value.and_then(Value::as_str) else {
        return false;
    };
    let bytes = text.as_bytes();
    bytes.len() == 16
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b' ',
            13 => *b == b':',
            _ => b.is_ascii_digit(),
        })
}

impl WorkerTool for ObserverTool {
    fn name(&self) -> &'static str {
        "record_observations"
    }

    fn description(&self) -> &'static str {
        "Record a batch of new observations distilled from the conversation chunk. Call this multiple times as you work through the chunk. Stop calling when coverage is complete, then emit a short plain-text confirmation to end the run."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "observations": {
                    "type": "array",
                    "description": "Batch of new observations. May be empty only if the tool is not called at all.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "timestamp": {
                                "type": "string",
                                "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$",
                                "description": "Observation time in local 'YYYY-MM-DD HH:MM' format.",
                            },
                            "content": {
                                "type": "string",
                                "minLength": 1,
                                "description": "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
                            },
                            "relevance": { "type": "string", "enum": RELEVANCES },
                            "sourceEntryIds": {
                                "type": "array",
                                "minItems": 1,
                                "items": { "type": "string" },
                                "description": "Exact source entry ids from the chunk that directly support this observation. Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
                            },
                        },
                        "required": ["timestamp", "content", "relevance", "sourceEntryIds"],
                    },
                },
            },
            "required": ["observations"],
        })
    }

    fn execute(&mut self, args: &Map<String, Value>) -> String {
        let (mut added, mut duplicates, mut rejected) = (0, 0, 0);
        for item in items(args.get("observations")) {
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .map_or("", js::trim);
            let ids = known_ids(item.get("sourceEntryIds"), &self.order);
            let relevance = Relevance::parse(item.get("relevance"));
            let (Some(ids), Some(relevance)) = (ids, relevance) else {
                rejected += 1;
                continue;
            };
            if content.is_empty() || !is_stamp(item.get("timestamp")) {
                rejected += 1;
                continue;
            }
            let text = truncate_content(&join_lines(&redact_secrets(content)));
            if self.out.iter().any(|o| o.id == hash_id(&text)) {
                duplicates += 1;
                continue;
            }
            let source_entry_ids = ordered(&ids, &self.order);
            let origins = sort_unique(
                source_entry_ids
                    .iter()
                    .map(|id| {
                        self.origins
                            .get(id)
                            .cloned()
                            .unwrap_or_else(|| "unknown".to_owned())
                    })
                    .collect(),
            );
            let timestamp = item["timestamp"].as_str().unwrap_or_default().to_owned();
            self.out.push(Observation::new(
                text,
                timestamp,
                relevance,
                source_entry_ids,
                origins,
            ));
            added += 1;
        }
        format!(
            "Recorded {added} new observation(s){}{} Total so far this run: {}. Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.",
            if duplicates > 0 {
                format!(" ({duplicates} duplicate(s) skipped).")
            } else {
                ".".to_owned()
            },
            if rejected > 0 {
                format!(
                    " {rejected} observation(s) rejected for missing or invalid sourceEntryIds."
                )
            } else {
                String::new()
            },
            self.out.len()
        )
    }
}

// ---------- coverage tiers ----------

/// `coverageTiers`: how many reflections cite each observation.
pub fn coverage_tiers(
    observations: &[Observation],
    reflections: &[Reflection],
) -> HashMap<String, &'static str> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for r in reflections {
        for id in &r.supporting_observation_ids {
            *counts.entry(id.as_str()).or_default() += 1;
        }
    }
    observations
        .iter()
        .map(|o| {
            let tier = match counts.get(o.id.as_str()).copied().unwrap_or(0) {
                0 => "none",
                1 => "partial",
                _ => "strong",
            };
            (o.id.clone(), tier)
        })
        .collect()
}

fn tiered_lines(observations: &[Observation], reflections: &[Reflection]) -> Vec<String> {
    let tiers = coverage_tiers(observations, reflections);
    observations
        .iter()
        .map(|o| {
            format!(
                "[{}] {} [{}] [coverage: {}] {}",
                o.id,
                o.timestamp,
                o.relevance.as_str(),
                tiers[&o.id],
                o.content
            )
        })
        .collect()
}

// ---------- reflector ----------

/// `reflectorPrompt`.
pub fn reflector_prompt(reflections: &[Reflection], active: &[Observation]) -> String {
    format!(
        "CURRENT REFLECTIONS:\n{}\n\nCURRENT OBSERVATIONS:\n{}\n\nCrystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.",
        lines(&reflections.iter().map(reflection_line).collect::<Vec<_>>()),
        lines(&tiered_lines(active, reflections))
    )
}

/// `reflectorTool`: `record_reflections`.
pub struct ReflectorTool {
    order: HashMap<String, usize>,
    known: HashSet<String>,
    pub out: Vec<Reflection>,
}

impl ReflectorTool {
    pub fn new(existing: &[Reflection], active: &[Observation]) -> Self {
        Self {
            order: active
                .iter()
                .enumerate()
                .map(|(index, o)| (o.id.clone(), index))
                .collect(),
            known: existing.iter().map(|r| r.id.clone()).collect(),
            out: Vec::new(),
        }
    }
}

impl WorkerTool for ReflectorTool {
    fn name(&self) -> &'static str {
        "record_reflections"
    }

    fn description(&self) -> &'static str {
        "Record new durable reflections with supporting observation ids."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "reflections": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string", "minLength": 1 },
                            "supportingObservationIds": {
                                "type": "array", "minItems": 1, "items": { "type": "string" },
                            },
                        },
                        "required": ["content", "supportingObservationIds"],
                    },
                },
            },
            "required": ["reflections"],
        })
    }

    fn execute(&mut self, args: &Map<String, Value>) -> String {
        let (mut added, mut duplicates, mut rejected) = (0, 0, 0);
        for item in items(args.get("reflections")) {
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .map(|content| truncate_content(&redact_secrets(js::trim(content))))
                .unwrap_or_default();
            let ids = known_ids(item.get("supportingObservationIds"), &self.order);
            let Some(ids) = ids.filter(|_| !content.is_empty() && !content.contains(['\r', '\n']))
            else {
                rejected += 1;
                continue;
            };
            let id = hash_id(&content);
            if self.known.contains(&id) {
                duplicates += 1;
                continue;
            }
            self.known.insert(id);
            self.out
                .push(Reflection::new(content, ordered(&ids, &self.order)));
            added += 1;
        }
        format!(
            "Recorded {added} reflection(s); {duplicates} duplicate(s); {rejected} rejected. Total this run: {}.",
            self.out.len()
        )
    }
}

// ---------- dropper ----------

/// `poolMetrics`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoolMetrics {
    pub tokens: u64,
    pub over: u64,
    pub max_drops: usize,
    pub ready: bool,
}

/// `poolMetrics(active, target)`.
pub fn pool_metrics(active: &[Observation], target: u64) -> PoolMetrics {
    let tokens: u64 = active.iter().map(observation_tokens).sum();
    let over = tokens.saturating_sub(target);
    let n = active.len();
    let max_drops = if over > 0 && n > 0 {
        let average = tokens as f64 / n as f64;
        n.min(((over as f64 / average).ceil() as usize).max(1))
    } else {
        0
    };
    PoolMetrics {
        tokens,
        over,
        max_drops,
        ready: tokens > target && max_drops > 0,
    }
}

/// `Math.round`.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `dropperPrompt`.
pub fn dropper_prompt(
    reflections: &[Reflection],
    active: &[Observation],
    target: u64,
    metrics: PoolMetrics,
) -> String {
    let pct = js_round(metrics.tokens as f64 / target as f64 * 100.0);
    format!(
        "CURRENT REFLECTIONS:\n{}\n\nCURRENT OBSERVATIONS:\n{}\n\nActive observation pool: ~{} tokens; target: ~{} tokens; fullness against target: ~{}%; over target by ~{} tokens.\nMaximum drops allowed this run: {} observation(s). This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.",
        lines(&reflections.iter().map(reflection_line).collect::<Vec<_>>()),
        lines(&tiered_lines(active, reflections)),
        locale(metrics.tokens as f64),
        locale(target as f64),
        js::float_text(pct),
        locale(metrics.over as f64),
        metrics.max_drops
    )
}

/// `dropperTool`: `drop_observations`.
pub struct DropperTool {
    known: HashSet<String>,
    max_drops: usize,
    pub out: Vec<String>,
}

impl DropperTool {
    pub fn new(active: &[Observation], max_drops: usize) -> Self {
        Self {
            known: active.iter().map(|o| o.id.clone()).collect(),
            max_drops,
            out: Vec::new(),
        }
    }
}

impl WorkerTool for DropperTool {
    fn name(&self) -> &'static str {
        "drop_observations"
    }

    fn description(&self) -> &'static str {
        "Propose active observation ids that are safe to remove from compacted memory."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ids": { "type": "array", "minItems": 1, "items": { "type": "string" } },
                "reason": { "type": "string" },
            },
            "required": ["ids"],
        })
    }

    fn execute(&mut self, args: &Map<String, Value>) -> String {
        let mut queued = 0;
        for id in items(args.get("ids")) {
            let Some(id) = id.as_str() else {
                continue;
            };
            if !self.known.contains(id) || self.out.iter().any(|seen| seen == id) {
                continue;
            }
            self.out.push(id.to_owned());
            queued += 1;
        }
        format!(
            "Queued {queued} drop candidate(s). Candidates this run: {}. Maximum drops allowed: {}.",
            self.out.len(),
            self.max_drops
        )
    }
}

/// `selectDrops`: prefer well-covered, low-relevance, older observations;
/// at most `max_drops`.
pub fn select_drops(
    proposed: &[String],
    active: &[Observation],
    reflections: &[Reflection],
    max_drops: usize,
) -> Vec<String> {
    let by_id: HashMap<&str, &Observation> = active.iter().map(|o| (o.id.as_str(), o)).collect();
    let tiers = coverage_tiers(active, reflections);
    let rank = |o: &Observation| match tiers[&o.id] {
        "strong" => 0,
        "partial" => 1,
        _ => 2,
    };
    let time = |o: &Observation| {
        parse_local_minute(&o.timestamp.replacen(' ', "T", 1)).map_or(f64::INFINITY, |ms| ms as f64)
    };
    let mut picked: Vec<(&Observation, usize)> = proposed
        .iter()
        .enumerate()
        .filter_map(|(index, id)| by_id.get(id.as_str()).map(|o| (*o, index)))
        .collect();
    picked.sort_by(|(a, ai), (b, bi)| {
        rank(a)
            .cmp(&rank(b))
            .then(a.relevance.index().cmp(&b.relevance.index()))
            // `Infinity - Infinity` is NaN: equal.
            .then(
                time(a)
                    .partial_cmp(&time(b))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(ai.cmp(bi))
    });
    picked
        .into_iter()
        .take(max_drops)
        .map(|(o, _)| o.id.clone())
        .collect()
}
