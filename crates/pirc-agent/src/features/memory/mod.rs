//! `observational-memory` (`agent/features/memory/`): background observer
//! → reflector → dropper agents build an append-only memory ledger;
//! compaction renders it as the summary (no model call); `recall` maps
//! memory ids back to raw source entries. Durable memory is promoted into
//! a per-repository workspace ledger that new sessions receive.
//!
//! Where TS ran microtasks (a `panel_changed` flush) when a sync segment
//! ended, this feature flushes the agent's panel changes itself: before
//! each worker call (its first real await) and at the end of each hook and
//! background step.

pub mod agents;
pub mod config;
pub mod ledger;
pub mod panel;
pub mod prompts;
pub mod serialize;
mod time;
pub mod worker;
pub mod workspace;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::{Rc, Weak};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use self::agents::{
    DropperTool, ObserverTool, ReflectorTool, dropper_prompt, js_round, locale, observer_prompt,
    pool_metrics, reflector_prompt, select_drops,
};
use self::config::{MemoryConfig, memory_config_from};
use self::ledger::{
    LedgerType, OBS_DROPPED, OBS_RECORDED, Observation, REF_RECORDED, Reflection,
    build_compaction_projection, custom_data, fold_ledger, full_projection, is_memory_id,
    latest_coverage_id, latest_coverage_index, observation_line, pool_tokens,
    raw_tokens_since_last_compaction, reflection_line, render_summary, tokens_since_coverage,
    visible_projection,
};
use self::prompts::{DROPPER_SYSTEM, OBSERVER_SYSTEM, REFLECTOR_SYSTEM, WORKSPACE_PROMOTER_SYSTEM};
use self::serialize::{Style, render_message, serialize_chunk};
use self::worker::{RateLimitTracker, WorkerModel, WorkerRun, WorkerTool, pick_model, run_worker};
use self::workspace::{
    PromoterTool, PromotionContext, Recalled, WS_PROMOTED, WS_SNAPSHOT, WorkspaceLedger, git_label,
    git_state, items_tokens, promoter_prompt, promotion_candidates, recall_from_workspace,
    render_workspace_memory, workspace_item_line,
};
use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::channels::{ChannelError, process_gateway, team_child_name};
use crate::compaction::context_tokens;
use crate::config::WorkspaceKind;
use crate::context::PromptSection;
use crate::feature::{
    BeforeStart, CompactContext, CompactDecision, CompactionPlan, Feature, FeatureCommand,
    PromptAddition,
};
use crate::now_ms;
use crate::session_store::{EntryData, SessionEntry};
use crate::signal::{AbortController, AbortSignal};
use crate::tools::js;
use crate::tools::prompts::{PromptVar, tool_prompt};
use crate::tools::result_schema::{fields, str_};
use crate::tools::{Tool, ToolContext, ToolResult};
use crate::ui::NotifyLevel;

/// `memoryConfig(agent)`.
pub fn memory_config(agent: &Agent) -> MemoryConfig {
    memory_config_from(&agent.config().features)
}

/// `poolTarget`.
pub fn pool_target(config: &MemoryConfig) -> u64 {
    match config.observations_pool_target_tokens {
        Some(target) if target < config.observations_pool_max_tokens => target,
        _ => config.observations_pool_max_tokens / 2,
    }
}

/// `compactThreshold`.
pub fn compact_threshold(config: &MemoryConfig, context_window: Option<u64>) -> u64 {
    match context_window {
        Some(window) if config.compact_after_ratio_mode && window > 0 => {
            ((window as f64 * config.compact_after_tokens_ratio).floor() as u64).max(1)
        }
        _ => config.compact_after_tokens,
    }
}

/// `recall(branch, id)`: the sources behind an observation or reflection
/// of this branch; its text and status.
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

/// A background job others may wait for (a stored TS promise).
#[derive(Default)]
struct Job {
    done: Cell<bool>,
    notify: Notify,
}

impl Job {
    fn finish(&self) {
        self.done.set(true);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        while !self.done.get() {
            let notified = self.notify.notified();
            if self.done.get() {
                break;
            }
            notified.await;
        }
    }
}

#[derive(Default)]
struct State {
    tracker: RefCell<RateLimitTracker>,
    consolidating: RefCell<Option<Rc<Job>>>,
    phase: RefCell<String>,
    auto_compacting: Cell<bool>,
    compact_hook_busy: Cell<bool>,
    /// `{coverageId, tokensAtEmpty}` after an observer run found nothing.
    empty_backoff: RefCell<Option<(Option<String>, u64)>>,
    last_error: RefCell<IndexMap<String, String>>,
    lifetime: RefCell<AbortController>,
    fallback_notice_for: RefCell<Option<String>>,
    ledger: RefCell<Option<WorkspaceLedger>>,
    promoting: RefCell<Option<Rc<Job>>>,
    snapshot_text: RefCell<Option<String>>,
    /// The current consolidation reached a real await (its callbacks then
    /// run as TS's promise callbacks did, not inside the caller's segment).
    suspended: Cell<bool>,
    /// A background job is running its first, synchronous part inside its
    /// caller's segment: the caller flushes when that segment ends.
    eager: Cell<bool>,
}

/// Start `job` at once (`spawn_eager`) as part of the caller's segment.
fn start(state: &State, job: impl std::future::Future<Output = ()> + 'static) {
    let outer = state.eager.replace(true);
    crate::spawn_eager(job);
    state.eager.set(outer);
}

type Shared = Rc<State>;

fn notify(agent: &Agent, config: &MemoryConfig, text: &str) {
    agent.panel_changed("memory");
    if config.show_worker_notifications {
        agent
            .ui()
            .notify(&format!("Observational memory: {text}"), NotifyLevel::Info);
    }
}

fn set_phase(state: &State, agent: &Agent, next: &str) {
    *state.phase.borrow_mut() = next.to_owned();
    agent.panel_changed("memory");
}

fn set_error(state: &State, stage: &str, message: String) {
    state
        .last_error
        .borrow_mut()
        .insert(stage.to_owned(), message);
}

fn current_tokens(agent: &Agent) -> u64 {
    context_tokens(&agent.context_entries())
}

fn choose(state: &State, agent: &Agent, config: &MemoryConfig, stage: &str) -> Option<WorkerModel> {
    let picked = pick_model(
        agent,
        config.model.as_ref(),
        &config.fallback_models,
        &mut state.tracker.borrow_mut(),
    );
    match picked {
        Ok(model) => {
            let preferred = config
                .model
                .as_ref()
                .map(|model| format!("{}/{}", model.provider, model.id));
            if preferred.is_some_and(|preferred| preferred != model.key)
                && state.fallback_notice_for.borrow().as_deref() != Some(&model.key)
            {
                *state.fallback_notice_for.borrow_mut() = Some(model.key.clone());
                agent.ui().notify(
                    &format!(
                        "Observational memory: preferred model rate limited, using fallback {}",
                        model.key
                    ),
                    NotifyLevel::Warning,
                );
            }
            Some(model)
        }
        Err(error) => {
            agent.ui().notify(
                &format!("Observational memory: {stage} skipped — {error}"),
                NotifyLevel::Warning,
            );
            None
        }
    }
}

fn chunk_budget(config: &MemoryConfig, model: &WorkerModel) -> u64 {
    match config.observer_chunk_max_tokens {
        Some(tokens) => tokens.max(256),
        None => ((model.resolved.model.context_window as f64 * 0.2).floor() as u64).max(256),
    }
}

/// One worker run (`worker(…)` of `consolidate`, and the promoter's).
struct Work<'a> {
    model: &'a WorkerModel,
    system_prompt: &'a str,
    prompt: String,
    signal: &'a AbortSignal,
}

async fn work(
    state: &State,
    agent: &Agent,
    config: &MemoryConfig,
    run: Work<'_>,
    tool: &mut dyn WorkerTool,
) -> Result<(), String> {
    // Its first real await: where TS's microtasks ran, unless the caller's
    // segment goes on.
    state.suspended.set(true);
    if !state.eager.get() {
        agent.flush_panel();
    }
    run_worker(
        agent,
        &state.tracker,
        WorkerRun {
            model: run.model,
            system_prompt: run.system_prompt,
            prompt: run.prompt,
            max_turns: config.agent_max_turns,
            max_tokens: config.agent_max_tokens,
            signal: run.signal.clone(),
            cooldown_ms: memory_config(agent).rate_limit_cooldown_ms,
        },
        tool,
    )
    .await
}

fn append_custom(agent: &Agent, custom_type: &str, data: Value) -> Result<(), String> {
    agent
        .append_entry(EntryData::Custom {
            custom_type: custom_type.to_owned(),
            data,
        })
        .map(|_| ())
}

/// `consolidate`: observer, then reflector, then dropper (only after a
/// same-run reflection). `Err` is a throw.
async fn consolidate(state: &State, agent: &Agent, signal: &AbortSignal) -> Result<(), String> {
    let config = memory_config(agent);

    // Observer
    set_phase(state, agent, "observer");
    let branch = agent.branch();
    let obs_tokens =
        tokens_since_coverage(&branch, LedgerType::Observations, current_tokens(agent));
    let obs_coverage = latest_coverage_id(&branch, LedgerType::Observations);
    let reset = state
        .empty_backoff
        .borrow()
        .as_ref()
        .is_some_and(|(coverage, at_empty)| {
            *coverage != obs_coverage || obs_tokens >= at_empty + config.observe_after_tokens
        });
    if reset {
        *state.empty_backoff.borrow_mut() = None;
    }
    if obs_tokens >= config.observe_after_tokens && state.empty_backoff.borrow().is_none() {
        let Some(model) = choose(state, agent, &config, "observer") else {
            return Ok(());
        };
        let from = (latest_coverage_index(&branch, LedgerType::Observations) + 1) as usize;
        let chunk = serialize_chunk(&branch[from..], chunk_budget(&config, &model));
        if let Some(last) = chunk.source_entry_ids.last().cloned() {
            let prior = full_projection(&branch, None);
            let mut tool = ObserverTool::new(&chunk);
            let prompt = observer_prompt(&chunk, &prior.reflections, &prior.observations);
            let result = work(
                state,
                agent,
                &config,
                Work {
                    model: &model,
                    system_prompt: &OBSERVER_SYSTEM,
                    prompt,
                    signal,
                },
                &mut tool,
            )
            .await;
            if let (true, Err(error)) = (tool.out.is_empty(), &result) {
                set_error(state, "observer", error.clone());
                agent.panel_changed("memory");
                return Ok(());
            }
            if tool.out.is_empty() {
                *state.empty_backoff.borrow_mut() = Some((obs_coverage, obs_tokens));
                notify(agent, &config, "no new observations in this chunk");
            } else {
                let observations: Vec<Value> = tool.out.iter().map(|o| o.raw.clone()).collect();
                append_custom(
                    agent,
                    OBS_RECORDED,
                    json!({ "observations": observations, "coversUpToId": last }),
                )?;
                notify(
                    agent,
                    &config,
                    &format!("recorded {} observation(s)", tool.out.len()),
                );
            }
        }
    }
    if signal.aborted() {
        return Ok(());
    }

    // Reflector
    set_phase(state, agent, "reflector");
    let branch = agent.branch();
    let ref_tokens = tokens_since_coverage(&branch, LedgerType::Reflections, current_tokens(agent));
    let obs_cov = latest_coverage_id(&branch, LedgerType::Observations);
    let Some(obs_cov) = obs_cov.filter(|_| ref_tokens >= config.reflect_after_tokens) else {
        return Ok(());
    };
    let Some(ref_model) = choose(state, agent, &config, "reflector") else {
        return Ok(());
    };
    let folded = fold_ledger(&branch);
    if folded.active_observations.is_empty() {
        return Ok(());
    }
    let mut tool = ReflectorTool::new(&folded.reflections, &folded.active_observations);
    let prompt = reflector_prompt(&folded.reflections, &folded.active_observations);
    let result = work(
        state,
        agent,
        &config,
        Work {
            model: &ref_model,
            system_prompt: &REFLECTOR_SYSTEM,
            prompt,
            signal,
        },
        &mut tool,
    )
    .await;
    let same_run = tool.out;
    if let (true, Err(error)) = (same_run.is_empty(), result) {
        set_error(state, "reflector", error);
    }
    if same_run.is_empty() {
        return Ok(());
    }
    let reflections: Vec<Value> = same_run.iter().map(|r| r.raw.clone()).collect();
    append_custom(
        agent,
        REF_RECORDED,
        json!({ "reflections": reflections, "coversUpToId": obs_cov }),
    )?;
    notify(
        agent,
        &config,
        &format!("recorded {} reflection(s)", same_run.len()),
    );
    if signal.aborted() {
        return Ok(());
    }

    // Dropper (only after a same-run reflection)
    set_phase(state, agent, "dropper");
    let branch = agent.branch();
    let folded = fold_ledger(&branch);
    let target = pool_target(&config);
    let metrics = pool_metrics(&folded.active_observations, target);
    if !metrics.ready {
        return Ok(());
    }
    let Some(drop_model) = choose(state, agent, &config, "dropper") else {
        return Ok(());
    };
    let mut reflections = folded.reflections.clone();
    for r in same_run {
        if !reflections.iter().any(|item| item.id == r.id) {
            reflections.push(r);
        }
    }
    let mut tool = DropperTool::new(&folded.active_observations, metrics.max_drops);
    let prompt = dropper_prompt(&reflections, &folded.active_observations, target, metrics);
    let result = work(
        state,
        agent,
        &config,
        Work {
            model: &drop_model,
            system_prompt: &DROPPER_SYSTEM,
            prompt,
            signal,
        },
        &mut tool,
    )
    .await;
    if let (true, Err(error)) = (tool.out.is_empty(), result) {
        set_error(state, "dropper", error);
    }
    let drops = select_drops(
        &tool.out,
        &folded.active_observations,
        &reflections,
        metrics.max_drops,
    );
    if drops.is_empty() {
        return Ok(());
    }
    let obs_index = latest_coverage_index(&branch, LedgerType::Observations);
    let ref_index = latest_coverage_index(&branch, LedgerType::Reflections);
    let at = obs_index.min(ref_index);
    let covers_up_to_id = if at >= 0 {
        branch[at as usize].id.clone()
    } else {
        obs_cov
    };
    append_custom(
        agent,
        OBS_DROPPED,
        json!({ "observationIds": drops, "coversUpToId": covers_up_to_id }),
    )?;
    notify(
        agent,
        &config,
        &format!("dropped {} observation(s)", drops.len()),
    );
    Ok(())
}

fn maybe_consolidate(state: &Shared, agent: &Rc<Agent>) {
    let config = memory_config(agent);
    if !config.enabled || config.passive || state.consolidating.borrow().is_some() {
        return;
    }
    let branch = agent.branch();
    let current = current_tokens(agent);
    let due = tokens_since_coverage(&branch, LedgerType::Observations, current)
        >= config.observe_after_tokens
        || tokens_since_coverage(&branch, LedgerType::Reflections, current)
            >= config.reflect_after_tokens;
    if !due {
        return;
    }
    let signal = state.lifetime.borrow().signal();
    let job = Rc::new(Job::default());
    *state.consolidating.borrow_mut() = Some(job.clone());
    state.suspended.set(false);
    let (shared, agent) = (state.clone(), agent.clone());
    let state = shared.clone();
    start(&shared, async move {
        let result = consolidate(&state, &agent, &signal).await;
        if !state.suspended.get() {
            // It finished within the caller's segment: its callbacks run
            // after that segment, as TS's promise callbacks did.
            tokio::task::yield_now().await;
        }
        agent.flush_panel();
        if let Err(error) = result {
            let phase = state.phase.borrow().clone();
            let stage = if phase.is_empty() {
                "consolidation"
            } else {
                &phase
            };
            set_error(&state, stage, error.clone());
            agent.panel_changed("memory");
            agent.ui().notify(
                &format!("Observational memory {phase} failed: {error}"),
                NotifyLevel::Warning,
            );
            agent.flush_panel();
        }
        *state.consolidating.borrow_mut() = None;
        job.finish();
        set_phase(&state, &agent, "");
        // New reflections are the signal that something durable is worth carrying over.
        schedule_promotion(&state, &agent, false);
        agent.flush_panel();
    });
}

/// `workspaceOn`: chats have no repository to hand over; the gateway's
/// MEMORY serves them (docs/history/assistant.md).
fn workspace_on(agent: &Agent, config: &MemoryConfig) -> bool {
    config.enabled
        && config.workspace.enabled
        && team_child_name(&|name| std::env::var(name).ok()).is_none()
        && agent.config().workspace_kind != WorkspaceKind::Chat
}

fn workspace_ledger(state: &State, agent: &Agent) -> WorkspaceLedger {
    state
        .ledger
        .borrow_mut()
        .get_or_insert_with(|| WorkspaceLedger::for_cwd(&agent.config().workspace))
        .clone()
}

fn session_id(agent: &Agent) -> String {
    agent.state()["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// `promote`: distill unpromoted session memory into the workspace
/// ledger; what happened. `Err` is a throw.
async fn promote(
    state: &State,
    agent: &Agent,
    signal: &AbortSignal,
    force: bool,
) -> Result<String, String> {
    let config = memory_config(agent);
    let candidates = promotion_candidates(&agent.branch());
    if candidates.is_empty() {
        return Ok("nothing new to promote".to_owned());
    }
    if !force && !candidates.iter().any(|c| c.reflection) {
        return Ok("waiting for a reflection".to_owned());
    }
    let Some(model) = choose(state, agent, &config, "workspace promotion") else {
        return Ok("no model available".to_owned());
    };
    let target = workspace_ledger(state, agent);
    let Some(_lock) = target.try_lock()? else {
        return Ok("another session is updating workspace memory; will retry later".to_owned());
    };
    let fold = target.fold()?;
    let workspace = agent.config().workspace.clone();
    let git = git_state(&workspace);
    let prompt = promoter_prompt(
        &fold,
        &candidates,
        git.as_ref(),
        config.workspace.max_tokens,
    );
    let mut tool = PromoterTool::new(
        fold,
        &candidates,
        PromotionContext {
            session_id: session_id(agent),
            session_dir: agent.session_dir().display().to_string(),
            git,
        },
    );
    let run = work(
        state,
        agent,
        &config,
        Work {
            model: &model,
            system_prompt: &WORKSPACE_PROMOTER_SYSTEM,
            prompt,
            signal,
        },
        &mut tool,
    )
    .await;
    let out = tool.out;
    if let (true, Err(error)) = (out.add.is_empty() && out.retire.is_empty(), &run) {
        set_error(state, "workspace", error.clone());
        agent.panel_changed("memory");
        return Ok(format!("failed: {error}"));
    }
    let at = now_ms();
    if !out.add.is_empty() {
        target.append(&json!({ "type": "recorded", "at": at, "items": out.add }))?;
    }
    if !out.retire.is_empty() {
        target.append(
            &json!({ "type": "retired", "at": at, "ids": out.retire, "reason": "superseded" }),
        )?;
    }
    let ids: Vec<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
    append_custom(agent, WS_PROMOTED, json!({ "memoryIds": ids }))?;
    state.last_error.borrow_mut().shift_remove("workspace");
    let summary = format!(
        "workspace memory +{} / -{}",
        out.add.len(),
        out.retire.len()
    );
    notify(agent, &config, &summary);
    Ok(summary)
}

fn schedule_promotion(state: &Shared, agent: &Rc<Agent>, force: bool) {
    let config = memory_config(agent);
    let signal = state.lifetime.borrow().signal();
    if !workspace_on(agent, &config)
        || config.passive
        || state.promoting.borrow().is_some()
        || signal.aborted()
    {
        return;
    }
    let job = Rc::new(Job::default());
    *state.promoting.borrow_mut() = Some(job.clone());
    let (shared, agent) = (state.clone(), agent.clone());
    let state = shared.clone();
    start(&shared, async move {
        if let Err(error) = promote(&state, &agent, &signal, force).await {
            set_error(&state, "workspace", error);
            agent.panel_changed("memory");
        }
        agent.flush_panel();
        *state.promoting.borrow_mut() = None;
        job.finish();
    });
}

/// `workspaceSnapshot`: frozen per session (prompt cache); only fresh
/// sessions receive workspace notes.
fn workspace_snapshot(state: &State, agent: &Agent) -> Result<String, String> {
    if let Some(text) = state.snapshot_text.borrow().clone() {
        return Ok(text);
    }
    let branch = agent.branch();
    if let Some(existing) = branch
        .iter()
        .rev()
        .find_map(|entry| custom_data(entry, WS_SNAPSHOT))
    {
        let text = match existing.get("text") {
            None | Some(Value::Null) => String::new(),
            Some(text) => js::string_of(text),
        };
        *state.snapshot_text.borrow_mut() = Some(text.clone());
        return Ok(text);
    }
    let mut text = String::new();
    if !branch
        .iter()
        .any(|entry| matches!(entry.data, EntryData::Message(_)))
    {
        let target = workspace_ledger(state, agent);
        match target.fold() {
            Ok(fold) => {
                text = render_workspace_memory(
                    &fold.active,
                    &target.root,
                    git_state(&agent.config().workspace).as_ref(),
                    memory_config(agent).workspace.max_tokens,
                );
            }
            Err(error) => agent.ui().notify(
                &format!("Observational memory: workspace memory unavailable — {error}"),
                NotifyLevel::Warning,
            ),
        }
    }
    append_custom(agent, WS_SNAPSHOT, json!({ "text": text }))?;
    *state.snapshot_text.borrow_mut() = Some(text.clone());
    Ok(text)
}

/// `recall`, the tool.
struct RecallTool {
    agent: Weak<Agent>,
    state: Shared,
    /// The description without and with chat search (a getter in TS: the
    /// chat's capability policy can change between runs).
    descriptions: [String; 2],
    parameters: Map<String, Value>,
    result_schema: Value,
}

impl RecallTool {
    fn new(agent: &Rc<Agent>, state: Shared) -> Self {
        let description = |chat_search: bool| {
            tool_prompt("recall", &[("chatSearch", PromptVar::Flag(chat_search))])
                .expect("the recall description")
        };
        let Value::Object(parameters) = json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{12}$",
                    "description": "12-character lowercase hex observation or reflection id shown in compacted memory, /om:view, or a previous recall result. Must be a specific id; this tool does not search by topic.",
                },
            },
            "required": ["id"],
            "additionalProperties": false,
        }) else {
            unreachable!()
        };
        Self {
            agent: Rc::downgrade(agent),
            state,
            descriptions: [description(false), description(true)],
            parameters,
            result_schema: fields(
                vec![
                    ("id", str_(None)),
                    (
                        "status",
                        str_(Some(
                            "ok, partial (some sources missing), no_source, source_unavailable or forgotten; the evidence itself is in text",
                        )),
                    ),
                ],
                &[],
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        if ctx.signal.aborted() {
            return Err("Aborted".to_owned());
        }
        let agent = self.agent.upgrade().ok_or("The agent is gone")?;
        let id = match args.get("id") {
            None | Some(Value::Null) => String::new(),
            Some(id) => js::string_of(id),
        };
        let mut result = recall(&agent.branch(), &id);
        if result.1 == "not_found" && workspace_on(&agent, &memory_config(&agent)) {
            let fold = workspace_ledger(&self.state, &agent).fold()?;
            if let Some(found) = recall_from_workspace(&fold, &id, recall)? {
                result = found;
            }
        }
        // A chat recalls notes it found with memory_search through the
        // gateway, which asks the node that holds them (docs/history/assistant.md).
        let gateway = if agent.config().workspace_kind == WorkspaceKind::Chat {
            process_gateway()
        } else {
            None
        };
        if let Some(gateway) = gateway
            && result.1 == "not_found"
            && agent.capabilities().allows("remote_recall")
        {
            let mut request = Map::new();
            request.insert("id".to_owned(), json!(id));
            let answer = gateway
                .gateway
                .request("recall.remote", request, Some(&ctx.signal))
                .await;
            match answer {
                Ok(found) => {
                    let text = found.get("text").map(js::string_of).unwrap_or_default();
                    let status = found
                        .get("status")
                        .map_or_else(|| "undefined".to_owned(), js::string_of);
                    result = (text, status);
                }
                Err(ChannelError::Coded { code, message, .. }) => {
                    if code != "not_found" {
                        result = (
                            format!(
                                "Workspace memory could not be read through the gateway: {message}"
                            ),
                            "source_unavailable".to_owned(),
                        );
                    }
                }
                Err(error) => return Err(error.message().to_owned()),
            }
        }
        let (text, status) = result;
        let mut details = Map::new();
        details.insert("status".to_owned(), json!(status));
        if let Some(raw) = args.get("id") {
            details.insert("id".to_owned(), raw.clone());
        }
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(id));
        data.insert("status".to_owned(), json!(status));
        Ok(ToolResult {
            details: Some(Value::Object(details)),
            is_error: status == "invalid_id" || status == "not_found",
            is_error_set: true,
            data: Some(data),
            ..ToolResult::text(text)
        })
    }
}

impl Tool for RecallTool {
    fn name(&self) -> &str {
        "recall"
    }

    fn description(&self) -> &str {
        let chat_search = self.agent.upgrade().is_some_and(|agent| {
            let capabilities = agent.capabilities();
            capabilities.allows("memory_search") && capabilities.allows("remote_recall")
        });
        &self.descriptions[usize::from(chat_search)]
    }

    fn parameters(&self) -> &Map<String, Value> {
        &self.parameters
    }

    fn ptc(&self) -> bool {
        true
    }

    fn result_schema(&self) -> Option<&Value> {
        Some(&self.result_schema)
    }

    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(self.run(args, ctx))
    }
}

/// `memoryFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(MemoryFeature {
        state: Rc::new(State::default()),
    })
}

struct MemoryFeature {
    state: Shared,
}

/// `bar(value, max)` of `/om:status`.
fn bar(value: f64, max: f64) -> String {
    format!(
        "{}/{} ({}%)",
        locale(value),
        locale(max),
        js::float_text(js_round(value / max * 100.0).min(100.0))
    )
}

fn context_window(agent: &Agent) -> Option<u64> {
    agent
        .resolve_model(None)
        .ok()
        .map(|resolved| resolved.model.context_window)
}

impl MemoryFeature {
    fn status(&self, agent: &Rc<Agent>) {
        let state = &self.state;
        let config = memory_config(agent);
        let branch = agent.branch();
        let folded = fold_ledger(&branch);
        let visible = visible_projection(&branch);
        let current = current_tokens(agent);
        let window = context_window(agent);
        let mut lines = Vec::new();
        if config.passive {
            lines.push("Mode: passive (automatic consolidation and compaction off)".to_owned());
        }
        lines.push(format!(
            "Memory: {} observations recorded, {} dropped, {} active, {} visible; {} reflections ({} visible)",
            folded.observations.len(),
            folded.dropped.len(),
            folded.active_observations.len(),
            visible.observations.len(),
            folded.reflections.len(),
            visible.reflections.len()
        ));
        let since = |kind| tokens_since_coverage(&branch, kind, current) as f64;
        lines.push(format!(
            "Next observation: {}",
            bar(
                since(LedgerType::Observations),
                config.observe_after_tokens as f64
            )
        ));
        lines.push(format!(
            "Next reflection: {}",
            bar(
                since(LedgerType::Reflections),
                config.reflect_after_tokens as f64
            )
        ));
        lines.push(format!(
            "Next compaction: {}",
            bar(
                raw_tokens_since_last_compaction(&branch) as f64,
                compact_threshold(&config, window) as f64
            )
        ));
        lines.push(format!(
            "Visible pool: {}",
            bar(
                pool_tokens(&visible.observations),
                config.observations_pool_max_tokens as f64
            )
        ));
        lines.push(format!(
            "Active pool: {}",
            bar(
                pool_tokens(&folded.active_observations),
                pool_target(&config) as f64
            )
        ));
        if state.consolidating.borrow().is_some() {
            lines.push(format!(
                "In flight: consolidation ({})",
                state.phase.borrow()
            ));
        }
        if state.auto_compacting.get() {
            lines.push("In flight: automatic compaction".to_owned());
        }
        let now = now_ms();
        for (key, until) in state.tracker.borrow().entries() {
            lines.push(format!(
                "Rate limited: {key} ({} min left)",
                (until.saturating_sub(now) as f64 / 60_000.0).ceil()
            ));
        }
        for (stage, message) in state.last_error.borrow().iter() {
            lines.push(format!("Last {stage} error: {message}"));
        }
        agent.ui().notify(&lines.join("\n"), NotifyLevel::Info);
    }

    async fn workspace_command(&self, agent: &Rc<Agent>, args: &str) -> Result<(), String> {
        let state = &self.state;
        let mut words = args.split(js::is_space).filter(|word| !word.is_empty());
        let sub = words.next().unwrap_or("view");
        let id = words.next();
        let ui = agent.ui();
        let config = memory_config(agent);
        if !workspace_on(agent, &config) {
            ui.notify(
                "Workspace memory is disabled (or this is not a main session)",
                NotifyLevel::Warning,
            );
            return Ok(());
        }
        let target = workspace_ledger(state, agent);
        match sub {
            "view" => {
                let active = target.fold()?.active;
                let git = git_label(git_state(&agent.config().workspace).as_ref());
                let frozen = state
                    .snapshot_text
                    .borrow()
                    .as_ref()
                    .is_some_and(|text| !text.is_empty());
                let mut lines = vec![
                    format!("Workspace memory for {}", target.root),
                    format!(
                        "{} active item(s), ~{}/{} tokens; current git: {}",
                        active.len(),
                        locale(items_tokens(&active)),
                        locale(config.workspace.max_tokens as f64),
                        if git.is_empty() { "n/a" } else { &git }
                    ),
                    format!(
                        "Frozen into this session: {}",
                        if frozen { "yes" } else { "no" }
                    ),
                ];
                lines.extend(active.iter().map(workspace_item_line));
                ui.notify(&lines.join("\n"), NotifyLevel::Info);
            }
            "sync" => {
                let running = state.promoting.borrow().clone();
                if let Some(job) = running {
                    job.wait().await;
                }
                let signal = state.lifetime.borrow().signal();
                let result = promote(state, agent, &signal, true).await?;
                ui.notify(&format!("Workspace memory: {result}"), NotifyLevel::Info);
            }
            "forget" => {
                // Superseded items are still recallable, so they can be forgotten too.
                let fold = target.fold()?;
                if let Some(id) = id.filter(|id| fold.forgotten.contains_key(*id)) {
                    ui.notify(
                        &format!("Workspace memory item {id} is already forgotten"),
                        NotifyLevel::Info,
                    );
                    return Ok(());
                }
                let Some(id) = id.filter(|id| fold.items.contains_key(*id)) else {
                    ui.notify(
                        &format!("No workspace memory item {}", id.unwrap_or_default()),
                        NotifyLevel::Warning,
                    );
                    return Ok(());
                };
                target.append(
                    &json!({ "type": "retired", "at": now_ms(), "ids": [id], "reason": "forgotten" }),
                )?;
                ui.notify(
                    &format!(
                        "Workspace memory: forgot {id}. New sessions will not see it and recall no longer returns it; sessions already open keep the copy frozen into their prompt."
                    ),
                    NotifyLevel::Info,
                );
            }
            "clear" => {
                target.append(&json!({ "type": "cleared", "at": now_ms() }))?;
                ui.notify("Workspace memory cleared", NotifyLevel::Info);
            }
            _ => ui.notify(
                "Usage: /om:workspace [view|sync|forget <id>|clear]",
                NotifyLevel::Warning,
            ),
        }
        Ok(())
    }

    fn view(&self, agent: &Rc<Agent>, args: &str) {
        let mode = if args.is_empty() { "visible" } else { args };
        if mode != "visible" && mode != "full" {
            agent
                .ui()
                .notify("Usage: /om:view [full]", NotifyLevel::Warning);
            return;
        }
        let branch = agent.branch();
        let projection = if mode == "full" {
            full_projection(&branch, None)
        } else {
            visible_projection(&branch)
        };
        let mut lines = vec!["── Reflections ──".to_owned()];
        lines.extend(projection.reflections.iter().map(reflection_line));
        lines.push("── Observations ──".to_owned());
        lines.extend(projection.observations.iter().map(observation_line));
        agent.ui().notify(&lines.join("\n"), NotifyLevel::Info);
    }
}

impl Feature for MemoryFeature {
    fn name(&self) -> &'static str {
        "observational-memory"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        if memory_config(agent).enabled {
            vec![Rc::new(RecallTool::new(agent, self.state.clone()))]
        } else {
            Vec::new()
        }
    }

    fn commands(&self) -> Vec<FeatureCommand> {
        vec![
            FeatureCommand::new("om:status", "Observational memory status"),
            FeatureCommand::new(
                "om:workspace",
                "Workspace memory (/om:workspace [view|sync|forget <id>|clear])",
            ),
            FeatureCommand::new("om:view", "Show memory (/om:view [full])"),
        ]
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match name {
                "om:status" => self.status(agent),
                "om:workspace" => self.workspace_command(agent, &args).await?,
                "om:view" => self.view(agent, &args),
                _ => {}
            }
            Ok(())
        })
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        // Catch up on memory a previous run could not promote (e.g. killed during shutdown).
        schedule_promotion(&self.state, agent, true);
        Box::pin(async { Ok(()) })
    }

    fn before_agent_start<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            maybe_consolidate(&self.state, agent);
            if !workspace_on(agent, &memory_config(agent)) {
                agent.flush_panel();
                return Ok(None);
            }
            let text = workspace_snapshot(&self.state, agent);
            agent.flush_panel();
            let text = text?;
            if text.is_empty() {
                return Ok(None);
            }
            Ok(Some(BeforeStart {
                system_prompt: Some(PromptAddition::Sections(vec![PromptSection {
                    frozen: Some(true),
                    ..PromptSection::new(
                        "observational-memory",
                        "Workspace memory",
                        "feature:observational-memory",
                        text,
                    )
                }])),
                messages: Vec::new(),
            }))
        })
    }

    fn turn_end<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        _message: &'a pirc_protocol::AssistantMessage,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        maybe_consolidate(&self.state, agent);
        // Threshold progress moves every turn.
        agent.panel_changed("memory");
        agent.flush_panel();
        Box::pin(async { Ok(()) })
    }

    fn agent_settled<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        let state = self.state.clone();
        let config = memory_config(agent);
        if !config.enabled || config.passive || state.auto_compacting.get() || agent.is_compacting()
        {
            return Box::pin(async { Ok(()) });
        }
        let threshold = compact_threshold(&config, context_window(agent));
        let progress = raw_tokens_since_last_compaction(&agent.branch());
        if progress < threshold {
            return Box::pin(async { Ok(()) });
        }
        notify(
            agent,
            &config,
            &format!(
                "compaction threshold reached (~{} estimated source tokens); triggering compaction",
                locale(progress as f64)
            ),
        );
        state.auto_compacting.set(true);
        agent.flush_panel();
        let agent = agent.clone();
        // `setTimeout(…, 0)`.
        tokio::task::spawn_local(async move {
            tokio::task::yield_now().await;
            if agent.is_running() || agent.is_compacting() {
                state.auto_compacting.set(false);
                notify(&agent, &config, "automatic compaction deferred");
                agent.flush_panel();
                return;
            }
            if raw_tokens_since_last_compaction(&agent.branch()) < threshold {
                state.auto_compacting.set(false);
                notify(
                    &agent,
                    &config,
                    "automatic compaction skipped — another compaction already ran",
                );
                agent.flush_panel();
                return;
            }
            if let Err(error) = agent.compact(None).await
                && error != "Compaction cancelled"
            {
                agent.ui().notify(
                    &format!("Observational memory: automatic compaction failed — {error}"),
                    NotifyLevel::Warning,
                );
            }
            state.auto_compacting.set(false);
            agent.panel_changed("memory");
            agent.flush_panel();
        });
        Box::pin(async { Ok(()) })
    }

    fn before_compact<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        context: CompactContext<'a>,
    ) -> LocalBoxFuture<'a, Result<Option<CompactDecision>, String>> {
        let state = &self.state;
        let config = memory_config(agent);
        let decision = if !config.enabled {
            None
        } else if state.compact_hook_busy.get() {
            agent.ui().notify(
                "Observational memory: another compaction is already in progress; cancelling duplicate",
                NotifyLevel::Warning,
            );
            Some(CompactDecision::Cancel)
        } else {
            state.compact_hook_busy.set(true);
            let details = build_compaction_projection(
                &agent.branch(),
                context.first_kept_entry_id,
                config.observations_pool_max_tokens as f64,
            );
            let summary = render_summary(&details.reflections, &details.observations);
            state.compact_hook_busy.set(false);
            (!summary.is_empty()).then(|| {
                CompactDecision::Plan(CompactionPlan {
                    summary,
                    first_kept_entry_id: context.first_kept_entry_id.to_owned(),
                    tokens_before: context.tokens_before,
                    details: Some(details.to_value()),
                })
            })
        };
        Box::pin(async move { Ok(decision) })
    }

    fn after_compact<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        agent.panel_changed("memory");
        agent.flush_panel();
        Box::pin(async { Ok(()) })
    }

    fn shutdown<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, ()> {
        Box::pin(async move {
            let state = &self.state;
            state.lifetime.borrow().abort();
            let consolidating = state.consolidating.borrow().clone();
            if let Some(job) = consolidating {
                job.wait().await;
            }
            let promoting = state.promoting.borrow().clone();
            if let Some(job) = promoting {
                job.wait().await;
            }
            *state.lifetime.borrow_mut() = AbortController::new();
            let config = memory_config(agent);
            if !workspace_on(agent, &config) || config.passive {
                return;
            }
            // Best effort: if the process is killed first, init() catches up next time.
            let timeout = AbortController::new();
            let timer = {
                let timeout = timeout.clone();
                let ms = config.workspace.shutdown_timeout_ms;
                tokio::task::spawn_local(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    timeout.abort();
                })
            };
            let _ = promote(state, agent, &timeout.signal(), true).await;
            timer.abort();
            agent.flush_panel();
        })
    }

    /// Live-only state; the ledger itself is built by the node
    /// (`panel::memory_panel`).
    fn panel(&self, _agent: &Rc<Agent>) -> Option<Map<String, Value>> {
        let state = &self.state;
        let phase = if state.consolidating.borrow().is_some() {
            let phase = state.phase.borrow();
            json!(if phase.is_empty() { "starting" } else { &phase })
        } else {
            Value::Null
        };
        let rate_limited: Vec<Value> = state
            .tracker
            .borrow()
            .entries()
            .into_iter()
            .map(|(model, until)| json!({ "model": model, "until": until }))
            .collect();
        let errors: Map<String, Value> = state
            .last_error
            .borrow()
            .iter()
            .map(|(stage, message)| (stage.clone(), json!(message)))
            .collect();
        let mut out = Map::new();
        out.insert(
            "memoryRuntime".to_owned(),
            json!({
                "phase": phase,
                "autoCompacting": state.auto_compacting.get(),
                "rateLimited": rate_limited,
                "lastErrors": errors,
            }),
        );
        Some(out)
    }
}

#[cfg(test)]
mod tests;
