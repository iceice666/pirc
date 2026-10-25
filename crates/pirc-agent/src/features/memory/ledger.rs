//! The observational-memory ledger (`features/memory/ledger.ts`, a port of
//! the Pi extension's V3 ledger): append-only custom entries; folding and
//! projections are pure functions of the session branch.
//!
//! Records are kept as they were read ([`Observation::raw`]), so a
//! compaction's `details` carries them unchanged, as the TS objects were.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use pirc_protocol::{Message, StopReason};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::messages::estimate_tokens;
use crate::session_store::{EntryData, SessionEntry};
use crate::tools::js;

pub use super::time::{local_stamp, local_stamp_now};

/// `Relevance`, in `RELEVANCES` order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Relevance {
    Low,
    Medium,
    High,
    Critical,
}

/// `RELEVANCES`.
pub const RELEVANCES: [&str; 4] = ["low", "medium", "high", "critical"];

impl Relevance {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        Some(match value?.as_str()? {
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "critical" => Self::Critical,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        RELEVANCES[self.index()]
    }

    /// `RELEVANCES.indexOf(relevance)`.
    pub fn index(self) -> usize {
        self as usize
    }
}

/// `Observation`.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub id: String,
    pub content: String,
    pub timestamp: String,
    pub relevance: Relevance,
    pub source_entry_ids: Vec<String>,
    /// Origins of the source entries (`messageOrigin`), set by code; absent
    /// on older records.
    pub origins: Option<Vec<String>>,
    pub token_count: f64,
    /// The record as stored.
    pub raw: Value,
}

/// `Reflection`.
#[derive(Clone, Debug, PartialEq)]
pub struct Reflection {
    pub id: String,
    pub content: String,
    pub supporting_observation_ids: Vec<String>,
    pub token_count: f64,
    /// The record as stored.
    pub raw: Value,
}

pub const OBS_RECORDED: &str = "om.observations.recorded";
pub const REF_RECORDED: &str = "om.reflections.recorded";
pub const OBS_DROPPED: &str = "om.observations.dropped";

/// `LedgerType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerType {
    Observations,
    Reflections,
    Drops,
}

impl LedgerType {
    pub fn custom_type(self) -> &'static str {
        match self {
            Self::Observations => OBS_RECORDED,
            Self::Reflections => REF_RECORDED,
            Self::Drops => OBS_DROPPED,
        }
    }
}

/// `FoldedDetails` without its constant `type` and `version`.
#[derive(Clone, Debug, PartialEq)]
pub struct FoldedDetails {
    pub full_fold: bool,
    pub observations: Vec<Observation>,
    pub reflections: Vec<Reflection>,
}

impl FoldedDetails {
    /// `{type: 'om.folded', version: 1, fullFold, observations, reflections}`.
    pub fn to_value(&self) -> Value {
        json!({
            "type": "om.folded",
            "version": 1,
            "fullFold": self.full_fold,
            "observations": self.observations.iter().map(|o| o.raw.clone()).collect::<Vec<_>>(),
            "reflections": self.reflections.iter().map(|r| r.raw.clone()).collect::<Vec<_>>(),
        })
    }
}

const MAX_CONTENT: usize = 10_000;

/// `ID_PATTERN.test(id)`: `/^[a-f0-9]{12}$/`.
pub fn is_memory_id(id: &str) -> bool {
    id.len() == 12
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `truncateContent`.
pub fn truncate_content(content: &str) -> String {
    let length = js::len16(content);
    if length <= MAX_CONTENT {
        return content.to_owned();
    }
    let marker = format!(" … [truncated {} chars]", length - MAX_CONTENT);
    format!(
        "{}{marker}",
        js::head16(content, MAX_CONTENT - js::len16(&marker))
    )
}

/// `hashId`: the first 12 hex digits of the content's SHA-256.
pub fn hash_id(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `estimateStringTokens`.
pub fn estimate_string_tokens(text: &str) -> u64 {
    js::len16(text).div_ceil(4) as u64
}

/// `mergeOrigins`: the union of origin sets; a record without origins
/// (written before they existed) counts as `unknown`.
pub fn merge_origins<'a>(sets: impl IntoIterator<Item = Option<&'a [String]>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for set in sets {
        match set.filter(|set| !set.is_empty()) {
            Some(set) => out.extend(set.iter().cloned()),
            None => out.push("unknown".to_owned()),
        }
    }
    sort_unique(out)
}

/// `[...new Set(items)].sort()`.
pub fn sort_unique(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items.dedup();
    items
}

/// `observationLine`.
pub fn observation_line(o: &Observation) -> String {
    format!(
        "[{}] {} [{}] {}",
        o.id,
        o.timestamp,
        o.relevance.as_str(),
        o.content
    )
}

/// `reflectionLine`.
pub fn reflection_line(r: &Reflection) -> String {
    format!("[{}] {}", r.id, r.content)
}

/// `observationTokens`.
pub fn observation_tokens(o: &Observation) -> u64 {
    estimate_string_tokens(&observation_line(o))
}

// ---------- validation ----------

/// `strings(value)`: a non-empty array of strings.
fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    if items.is_empty() {
        return None;
    }
    items
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

impl Observation {
    /// `isObservation(value)`.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let id = o.get("id")?.as_str().filter(|id| is_memory_id(id))?;
        let origins = match o.get("origins") {
            None => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
            ),
            Some(_) => return None,
        };
        Some(Self {
            id: id.to_owned(),
            content: o.get("content")?.as_str()?.to_owned(),
            timestamp: o.get("timestamp")?.as_str()?.to_owned(),
            relevance: Relevance::parse(o.get("relevance"))?,
            source_entry_ids: strings(o.get("sourceEntryIds"))?,
            origins,
            token_count: o.get("tokenCount")?.as_f64()?,
            raw: value.clone(),
        })
    }

    /// A new record, its fields in the order the TS observer wrote them;
    /// `tokenCount` is computed.
    pub fn new(
        content: String,
        timestamp: String,
        relevance: Relevance,
        source_entry_ids: Vec<String>,
        origins: Vec<String>,
    ) -> Self {
        let mut observation = Self {
            id: hash_id(&content),
            content,
            timestamp,
            relevance,
            source_entry_ids,
            origins: Some(origins),
            token_count: 0.0,
            raw: Value::Null,
        };
        observation.token_count = observation_tokens(&observation) as f64;
        observation.raw = json!({
            "id": observation.id,
            "content": observation.content,
            "timestamp": observation.timestamp,
            "relevance": observation.relevance.as_str(),
            "sourceEntryIds": observation.source_entry_ids,
            "origins": observation.origins,
            "tokenCount": observation.token_count as u64,
        });
        observation
    }
}

impl Reflection {
    /// `isReflection(value)`.
    pub fn parse(value: &Value) -> Option<Self> {
        let o = value.as_object()?;
        let id = o.get("id")?.as_str().filter(|id| is_memory_id(id))?;
        let content = o.get("content")?.as_str()?;
        if content.contains(['\r', '\n']) {
            return None;
        }
        Some(Self {
            id: id.to_owned(),
            content: content.to_owned(),
            supporting_observation_ids: strings(o.get("supportingObservationIds"))?,
            token_count: o.get("tokenCount")?.as_f64()?,
            raw: value.clone(),
        })
    }

    /// A new record as the TS reflector wrote it.
    pub fn new(content: String, supporting_observation_ids: Vec<String>) -> Self {
        let token_count = js::len16(&content).div_ceil(4) as u64;
        let id = hash_id(&content);
        let raw = json!({
            "id": id,
            "content": content,
            "supportingObservationIds": supporting_observation_ids,
            "tokenCount": token_count,
        });
        Self {
            id,
            content,
            supporting_observation_ids,
            token_count: token_count as f64,
            raw,
        }
    }
}

/// `isObservation`.
pub fn is_observation(value: &Value) -> bool {
    Observation::parse(value).is_some()
}

/// `isReflection`.
pub fn is_reflection(value: &Value) -> bool {
    Reflection::parse(value).is_some()
}

/// `isFoldedDetails(value)`: the memory a folded compaction shows.
pub fn folded_details(value: Option<&Value>) -> Option<FoldedDetails> {
    let o = value?.as_object()?;
    if o.get("type").and_then(Value::as_str) != Some("om.folded")
        || o.get("version").and_then(Value::as_f64) != Some(1.0)
    {
        return None;
    }
    let full_fold = o.get("fullFold")?.as_bool()?;
    let observations = o
        .get("observations")?
        .as_array()?
        .iter()
        .map(Observation::parse)
        .collect::<Option<Vec<_>>>()?;
    let reflections = o
        .get("reflections")?
        .as_array()?
        .iter()
        .map(Reflection::parse)
        .collect::<Option<Vec<_>>>()?;
    Some(FoldedDetails {
        full_fold,
        observations,
        reflections,
    })
}

/// `isFoldedDetails`.
pub fn is_folded_details(value: Option<&Value>) -> bool {
    folded_details(value).is_some()
}

/// A valid ledger entry (`ledgerData`).
#[derive(Clone, Debug)]
pub struct LedgerItem {
    pub kind: LedgerType,
    pub covers_up_to_id: String,
    pub observations: Vec<Observation>,
    pub reflections: Vec<Reflection>,
    pub observation_ids: Vec<String>,
}

/// `ledgerData(entry)`.
pub fn ledger_data(entry: &SessionEntry) -> Option<LedgerItem> {
    let EntryData::Custom { custom_type, data } = &entry.data else {
        return None;
    };
    let data = data.as_object()?;
    let covers_up_to_id = data.get("coversUpToId")?.as_str()?.to_owned();
    let mut item = LedgerItem {
        kind: LedgerType::Observations,
        covers_up_to_id,
        observations: Vec::new(),
        reflections: Vec::new(),
        observation_ids: Vec::new(),
    };
    let nonempty = |key: &str| {
        data.get(key)
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
    };
    match custom_type.as_str() {
        OBS_RECORDED => {
            item.observations = nonempty("observations")?
                .iter()
                .map(Observation::parse)
                .collect::<Option<_>>()?;
        }
        REF_RECORDED => {
            item.kind = LedgerType::Reflections;
            item.reflections = nonempty("reflections")?
                .iter()
                .map(Reflection::parse)
                .collect::<Option<_>>()?;
        }
        OBS_DROPPED => {
            item.kind = LedgerType::Drops;
            item.observation_ids = strings(data.get("observationIds"))?;
        }
        _ => return None,
    }
    Some(item)
}

// ---------- source entries & coverage ----------

/// `isSource(entry)`: the message of a message entry.
pub fn source_message(entry: &SessionEntry) -> Option<&Message> {
    match &entry.data {
        EntryData::Message(message) => Some(message),
        _ => None,
    }
}

/// `entryTokens`.
pub fn entry_tokens(entry: &SessionEntry) -> u64 {
    source_message(entry).map_or(0, estimate_tokens)
}

/// `new Map(branch.map((entry, i) => [entry.id, i]))`: the last index of
/// each id.
fn index_of(branch: &[SessionEntry]) -> HashMap<&str, usize> {
    branch
        .iter()
        .enumerate()
        .map(|(i, entry)| (entry.id.as_str(), i))
        .collect()
}

/// `latestCoverageIndex`: -1 when nothing covers the branch.
pub fn latest_coverage_index(branch: &[SessionEntry], kind: LedgerType) -> isize {
    let index = index_of(branch);
    let mut best: isize = -1;
    for entry in branch {
        let Some(item) = ledger_data(entry).filter(|item| item.kind == kind) else {
            continue;
        };
        if let Some(&at) = index.get(item.covers_up_to_id.as_str())
            && at as isize > best
        {
            best = at as isize;
        }
    }
    best
}

/// `latestCoverageId`.
pub fn latest_coverage_id(branch: &[SessionEntry], kind: LedgerType) -> Option<String> {
    let index = latest_coverage_index(branch, kind);
    (index >= 0).then(|| branch[index as usize].id.clone())
}

// ---------- fold ----------

/// `Folded`.
#[derive(Clone, Debug, Default)]
pub struct Folded {
    pub observations: Vec<Observation>,
    pub active_observations: Vec<Observation>,
    pub dropped: HashSet<String>,
    pub reflections: Vec<Reflection>,
    pub observations_by_id: HashMap<String, Observation>,
}

fn collect<'a>(items: impl IntoIterator<Item = &'a LedgerItem>) -> Folded {
    let mut observations: IndexMap<String, Observation> = IndexMap::new();
    let mut reflections: IndexMap<String, Reflection> = IndexMap::new();
    let mut dropped = HashSet::new();
    for item in items {
        for o in &item.observations {
            observations
                .entry(o.id.clone())
                .or_insert_with(|| o.clone());
        }
        for r in &item.reflections {
            reflections.entry(r.id.clone()).or_insert_with(|| r.clone());
        }
        dropped.extend(item.observation_ids.iter().cloned());
    }
    let active = observations
        .values()
        .filter(|o| !dropped.contains(&o.id))
        .cloned()
        .collect();
    Folded {
        observations: observations.values().cloned().collect(),
        active_observations: active,
        dropped,
        reflections: reflections.into_values().collect(),
        observations_by_id: observations.into_iter().collect(),
    }
}

/// `foldLedger`.
pub fn fold_ledger(branch: &[SessionEntry]) -> Folded {
    let items: Vec<LedgerItem> = branch.iter().filter_map(ledger_data).collect();
    collect(&items)
}

// ---------- projections ----------

/// What a projection shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Projection {
    pub observations: Vec<Observation>,
    pub reflections: Vec<Reflection>,
}

/// `entryBoundary`: the entry's index, or -1.
pub fn entry_boundary(branch: &[SessionEntry], id: Option<&str>) -> isize {
    match id.filter(|id| !id.is_empty()) {
        Some(id) => branch
            .iter()
            .position(|entry| entry.id == id)
            .map_or(-1, |at| at as isize),
        None => -1,
    }
}

/// Coverage limits of a projection, by ledger type.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub observations: isize,
    pub reflections: isize,
    pub drops: isize,
}

/// `foldProjection`.
pub fn fold_projection(branch: &[SessionEntry], bounds: Bounds) -> Projection {
    let index = index_of(branch);
    let selected: Vec<LedgerItem> = branch
        .iter()
        .filter_map(ledger_data)
        .filter(|item| {
            let Some(&at) = index.get(item.covers_up_to_id.as_str()) else {
                return false;
            };
            let limit = match item.kind {
                LedgerType::Observations => bounds.observations,
                LedgerType::Reflections => bounds.reflections,
                LedgerType::Drops => bounds.drops,
            };
            at as isize <= limit
        })
        .collect();
    let folded = collect(&selected);
    Projection {
        observations: folded.active_observations,
        reflections: folded.reflections,
    }
}

/// `fullProjection(branch, upTo)`.
pub fn full_projection(branch: &[SessionEntry], up_to: Option<&str>) -> Projection {
    let bound = match up_to.filter(|id| !id.is_empty()) {
        Some(id) => entry_boundary(branch, Some(id)),
        None => branch.len() as isize - 1,
    };
    fold_projection(
        branch,
        Bounds {
            observations: bound,
            reflections: bound,
            drops: bound,
        },
    )
}

fn latest_full_fold_boundary_id(branch: &[SessionEntry]) -> Option<String> {
    for entry in branch.iter().rev() {
        let EntryData::Compaction {
            first_kept_entry_id,
            details,
            ..
        } = &entry.data
        else {
            continue;
        };
        if !folded_details(details.as_ref()).is_some_and(|folded| folded.full_fold) {
            continue;
        }
        if branch.iter().any(|item| item.id == *first_kept_entry_id) {
            return Some(first_kept_entry_id.clone());
        }
    }
    None
}

/// `sum of tokenCount`.
pub fn pool_tokens(observations: &[Observation]) -> f64 {
    observations
        .iter()
        .map(|o| o.token_count)
        .fold(0.0, |sum, n| sum + n)
}

/// `buildCompactionProjection`: observations are current up to the cut;
/// reflections and drops stay frozen at the last full fold so the summary
/// prefix is stable (prompt cache) until the visible pool crosses
/// `pool_max`.
pub fn build_compaction_projection(
    branch: &[SessionEntry],
    first_kept_entry_id: &str,
    pool_max: f64,
) -> FoldedDetails {
    let cut = entry_boundary(branch, Some(first_kept_entry_id));
    let maint = entry_boundary(branch, latest_full_fold_boundary_id(branch).as_deref());
    let normal = fold_projection(
        branch,
        Bounds {
            observations: cut,
            reflections: maint,
            drops: maint,
        },
    );
    let full_fold = pool_tokens(&normal.observations) >= pool_max;
    let projection = if full_fold {
        full_projection(branch, Some(first_kept_entry_id))
    } else {
        normal
    };
    FoldedDetails {
        full_fold,
        observations: projection.observations,
        reflections: projection.reflections,
    }
}

/// `visibleProjection`: the memory the latest folded compaction shows.
pub fn visible_projection(branch: &[SessionEntry]) -> Projection {
    for entry in branch.iter().rev() {
        if let EntryData::Compaction { details, .. } = &entry.data
            && let Some(folded) = folded_details(details.as_ref())
        {
            return Projection {
                observations: folded.observations,
                reflections: folded.reflections,
            };
        }
    }
    Projection::default()
}

/// `CONTEXT_USAGE_INSTRUCTIONS`.
pub const CONTEXT_USAGE_INSTRUCTIONS: &str = "These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.";

/// `renderSummary`: empty without memory.
pub fn render_summary(reflections: &[Reflection], observations: &[Observation]) -> String {
    if reflections.is_empty() && observations.is_empty() {
        return String::new();
    }
    let mut out = CONTEXT_USAGE_INSTRUCTIONS.to_owned();
    if !reflections.is_empty() {
        let lines: Vec<String> = reflections.iter().map(reflection_line).collect();
        out.push_str(&format!("\n\n## Reflections\n{}", lines.join("\n")));
    }
    if !observations.is_empty() {
        let lines: Vec<String> = observations.iter().map(observation_line).collect();
        out.push_str(&format!("\n\n## Observations\n{}", lines.join("\n")));
    }
    out
}

// ---------- token clocks ----------

fn assistant_usage(entry: &SessionEntry) -> Option<u64> {
    let Some(Message::Assistant(message)) = source_message(entry) else {
        return None;
    };
    if matches!(message.stop_reason, StopReason::Aborted | StopReason::Error) {
        return None;
    }
    let u = &message.usage;
    if u.total_tokens > 0 {
        return Some(u.total_tokens);
    }
    let sum = u.input + u.output + u.cache_read + u.cache_write;
    (sum > 0).then_some(sum)
}

/// `rawTokensSinceCoverage`.
pub fn raw_tokens_since_coverage(branch: &[SessionEntry], kind: LedgerType) -> u64 {
    let from = (latest_coverage_index(branch, kind) + 1) as usize;
    branch[from..].iter().map(entry_tokens).sum()
}

/// `tokensSinceCoverage`: the provider's usage since the coverage point
/// when it is known, else the estimate.
pub fn tokens_since_coverage(branch: &[SessionEntry], kind: LedgerType, current: u64) -> u64 {
    let raw = raw_tokens_since_coverage(branch, kind);
    let cov = latest_coverage_index(branch, kind);
    let cmp = branch
        .iter()
        .rposition(|entry| matches!(entry.data, EntryData::Compaction { .. }))
        .map_or(-1, |at| at as isize);
    let baseline = if cmp > cov {
        branch[(cmp + 1) as usize..]
            .iter()
            .find_map(assistant_usage)
    } else if cov >= 0 {
        branch[..=cov as usize]
            .iter()
            .rev()
            .find_map(assistant_usage)
    } else {
        return current;
    };
    match baseline {
        Some(baseline) if current >= baseline => current - baseline,
        _ => raw,
    }
}

/// `rawTokensSinceLastCompaction`.
pub fn raw_tokens_since_last_compaction(branch: &[SessionEntry]) -> u64 {
    let mut start = 0;
    for (i, entry) in branch.iter().enumerate().rev() {
        let EntryData::Compaction {
            first_kept_entry_id,
            ..
        } = &entry.data
        else {
            continue;
        };
        start = branch
            .iter()
            .position(|item| item.id == *first_kept_entry_id)
            .unwrap_or(i + 1);
        break;
    }
    branch[start..].iter().map(entry_tokens).sum()
}

/// A custom entry's data as a map (`entry.data`), when it is one.
pub fn custom_data<'a>(entry: &'a SessionEntry, custom_type: &str) -> Option<&'a Value> {
    match &entry.data {
        EntryData::Custom {
            custom_type: kind,
            data,
        } if kind == custom_type => Some(data),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests;
