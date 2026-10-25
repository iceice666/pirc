//! `goal` (`agent/features/goal/`): session goals, after DeepSeek Harness /
//! Codex. One persisted completion objective keeps the agent working across
//! automatic continuation rounds until the model marks it complete or
//! blocked, a round limit is reached, or the user pauses it.
//!
//! A round starts once the agent is fully idle after a run that ended
//! cleanly (each round is its own run, so `limits.maxTurns` applies per
//! round). An aborted or failed run pauses the goal instead. A restarted
//! agent process restores an active goal disarmed: it continues only after
//! a resume.
//!
//! Authority: creating, editing, pausing and resuming need a human request
//! (the latest input came from the user, not from a continuation round);
//! complete and blocked are always allowed, blocked only after
//! `minBlockedRounds`.

pub mod model;

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use pirc_protocol::{Message, StopReason};
use serde_json::{Map, Value, json};

use self::model::{
    Goal, GoalAction, GoalUpdate, apply_update, at_limit, auto_pause, create_goal, format_goal,
    goal_widget, is_open, parse_goal, start_round, valid_max_rounds,
};
use crate::agent::{Agent, Delivery};
use crate::feature::{BeforeStart, Feature, FeatureCommand, off_in_mode};
use crate::session_store::EntryData;
use crate::tools::result_schema::{bool_, fields, int, nullable, obj, one_of_strings, str_};
use crate::tools::{Tool, ToolContext, ToolResult, ToolSpec, js, spec_tool};
use crate::ui::{DialogOptions, NotifyLevel};
use crate::{LocalBoxFuture, now_ms};

pub const GOAL_ENTRY: &str = "goal-state-v1";
pub const GOAL_WIDGET: &str = "goal";
const CONTEXT: &str = "goal-context";
const CONTINUATION: &str = "goal-continuation";
const COMPACTION_RETRY_MS: u64 = 250;

const HELP: &str = "/goal: Show the goal
/goal set <objective>: Create a goal and start working on it
/goal edit <objective>: Replace the objective
/goal rounds <n>: Set the continuation round limit
/goal pause: Stop continuing after the current run
/goal resume: Continue (also rearms a restored goal)
/goal clear: Remove the goal (confirmation required)";

/// `goalFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    let child = crate::channels::team_child_name(&|name| std::env::var(name).ok()).is_some();
    Rc::new(GoalFeature {
        state: Rc::new(State {
            child,
            ..State::default()
        }),
    })
}

/// `features.goal` (`settingsSchema`): unusable settings as a whole fall
/// back to the defaults, as `safeParse` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Settings {
    enabled: bool,
    /// Rounds that must pass before the model may mark a goal blocked.
    min_blocked_rounds: i64,
    /// Round limit for goals created without `max_goal_rounds`.
    default_max_rounds: Option<i64>,
}

const DEFAULTS: Settings = Settings {
    enabled: true,
    min_blocked_rounds: 3,
    default_max_rounds: None,
};

/// A JSON number that is an integer (`z.number().int()`), however large:
/// one past `i64` saturates, and `valid_max_rounds` refuses what is not a
/// safe integer when it is used, as TS did.
fn integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number as i64)
}

fn parse_settings(value: Option<&Value>) -> Settings {
    let object = match value {
        None | Some(Value::Null) => return DEFAULTS,
        Some(Value::Object(object)) => object,
        Some(_) => return DEFAULTS,
    };
    let parse = || -> Option<Settings> {
        let enabled = match object.get("enabled") {
            None => true,
            Some(value) => value.as_bool()?,
        };
        let min_blocked_rounds = match object.get("minBlockedRounds") {
            None => 3,
            Some(value) => integer(value).filter(|n| (0..=100).contains(n))?,
        };
        let default_max_rounds = match object.get("defaultMaxRounds") {
            None => None,
            Some(value) => Some(integer(value).filter(|n| *n > 0)?),
        };
        Some(Settings {
            enabled,
            min_blocked_rounds,
            default_max_rounds,
        })
    };
    parse().unwrap_or(DEFAULTS)
}

/// The feature's state, shared with its tools (the TS closure).
#[derive(Default)]
struct State {
    goal: RefCell<Option<Goal>>,
    /// In-memory: a restored active goal waits for a resume before continuing.
    armed: Cell<bool>,
    /// The current run was started or steered by the user (not a
    /// continuation or a notice).
    human: Cell<bool>,
    /// User input arrived since the last run started.
    human_pending: Cell<bool>,
    /// The last run reached a clean stop (not aborted, failed or cut off).
    clean_end: Cell<bool>,
    /// The model has not seen the current goal state yet.
    needs_snapshot: Cell<bool>,
    scheduled: Cell<bool>,
    closed: Cell<bool>,
    /// A team member or subagent (`teamChildMode() !== undefined`).
    child: bool,
}

impl State {
    fn settings(&self, agent: &Agent) -> Settings {
        parse_settings(agent.config().features.get("goal"))
    }

    fn enabled(&self, agent: &Agent) -> bool {
        !self.child && self.settings(agent).enabled && !off_in_mode(agent, "goal")
    }

    fn goal(&self) -> Option<Goal> {
        self.goal.borrow().clone()
    }

    fn active_and_armed(&self) -> bool {
        self.armed.get() && self.goal.borrow().as_ref().is_some_and(Goal::is_active)
    }

    fn paint(&self, agent: &Agent) {
        if !agent.has_ui() || self.closed.get() {
            return;
        }
        let lines = self.goal().map(|goal| goal_widget(&goal, self.armed.get()));
        agent.ui().set_widget(GOAL_WIDGET, lines.as_deref());
    }

    fn save(&self, agent: &Agent, next: Option<Goal>) -> Result<(), String> {
        agent.append_entry(EntryData::Custom {
            custom_type: GOAL_ENTRY.to_owned(),
            data: next.as_ref().map_or(Value::Null, Goal::to_value),
        })?;
        *self.goal.borrow_mut() = next;
        self.paint(agent);
        Ok(())
    }

    fn read(&self, agent: &Agent) {
        let mut invalid = false;
        let mut goal = None;
        for entry in agent.custom_entries(GOAL_ENTRY) {
            let EntryData::Custom { data, .. } = &entry.data else {
                continue;
            };
            match parse_goal(data) {
                Some(parsed) => goal = parsed,
                None => invalid = true,
            }
        }
        *self.goal.borrow_mut() = goal;
        if invalid {
            agent.ui().notify(
                "Invalid goal history; corrupted snapshots were skipped.",
                NotifyLevel::Warning,
            );
        }
    }

    fn describe(&self, current: Option<&Goal>) -> String {
        match current {
            Some(goal) if goal.is_active() && !self.armed.get() => format!(
                "{}\n(Disarmed after a restart: it continues once the user asks to resume.)",
                format_goal(Some(goal))
            ),
            _ => format_goal(current),
        }
    }

    fn snapshot_message(&self) -> Message {
        Message::Custom {
            custom_type: CONTEXT.to_owned(),
            content: format!(
                "Goal state (replaces earlier goal state):\n{}",
                self.describe(self.goal().as_ref())
            ),
            display: false,
            details: None,
            timestamp: now_ms(),
        }
    }

    fn continuation_text(&self, current: &Goal, agent: &Agent) -> String {
        let min_blocked_rounds = self.settings(agent).min_blocked_rounds;
        let limit = current
            .max_rounds()
            .map(|max| format!(" of {}", js::string_of(max)))
            .unwrap_or_default();
        [
            format!(
                "Goal continuation round {}{limit} (goal {}, revision {}).",
                current.rounds(),
                current.id(),
                js::string_of(&current.revision_value())
            ),
            format!("Objective: {}", current.objective()),
            String::new(),
            "Keep working toward the objective: check what is already done, then make concrete progress. Do not redo finished work.".to_owned(),
            "When the objective is fully achieved and verified, call update_goal with action \"complete\".".to_owned(),
            format!(
                "If the same concrete blocker has persisted for at least {min_blocked_rounds} rounds, call update_goal with action \"blocked\" and a blocked_reason. Difficulty, uncertainty or remaining work is not a blocker."
            ),
        ]
        .join("\n")
    }

    /// `tryContinue`: start the next round once the agent is idle and not
    /// compacting. A failure to record the round ends it silently (TS threw
    /// inside a timer).
    fn try_continue(self: &Rc<Self>, agent: &Rc<Agent>) {
        self.scheduled.set(false);
        if self.closed.get() || !self.enabled(agent) || !self.active_and_armed() {
            return;
        }
        // Another run (user input, background notice) settles and schedules again.
        if agent.is_running() || agent.pending_count() > 0 {
            return;
        }
        if agent.is_compacting() {
            self.scheduled.set(true);
            let (state, agent) = (self.clone(), agent.clone());
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(COMPACTION_RETRY_MS)).await;
                state.try_continue(&agent);
            });
            return;
        }
        let Some(goal) = self.goal() else {
            return;
        };
        if at_limit(&goal) {
            let max = goal.max_rounds().map(js::string_of).unwrap_or_default();
            let paused = auto_pause(
                &goal,
                &format!("Used all {max} continuation rounds."),
                now_ms(),
            );
            if self.save(agent, Some(paused)).is_err() {
                return;
            }
            self.needs_snapshot.set(true);
            agent.ui().notify(
                &format!("Goal paused: used all {max} continuation rounds."),
                NotifyLevel::Warning,
            );
            return;
        }
        let next = start_round(&goal, now_ms());
        if self.save(agent, Some(next.clone())).is_err() {
            return;
        }
        self.human_pending.set(false);
        self.needs_snapshot.set(false);
        let _ = agent.deliver(
            Delivery {
                custom_type: CONTINUATION.to_owned(),
                content: self.continuation_text(&next, agent),
                display: true,
                details: Some(
                    json!({ "goalId": next.id(), "revision": next.revision_value(),
                    "round": next.rounds() }),
                ),
            },
            true,
            false,
        );
    }

    /// `schedule`: after the other features settled (`setTimeout(…, 0)`).
    fn schedule(self: &Rc<Self>, agent: &Rc<Agent>) {
        if self.scheduled.get() {
            return;
        }
        self.scheduled.set(true);
        let (state, agent) = (self.clone(), agent.clone());
        // Behind timeouts set earlier while settling: memory's automatic
        // compaction starts first, and the round waits for it.
        crate::set_timeout_zero(async move {
            state.try_continue(&agent);
        });
    }

    fn require_human(&self, action: &str) -> Result<(), String> {
        if self.human.get() {
            return Ok(());
        }
        Err(format!(
            "{action} requires a direct request from the user; it is not allowed during an automatic continuation round."
        ))
    }

    fn create(
        &self,
        agent: &Agent,
        objective: &str,
        max_rounds: Option<i64>,
    ) -> Result<Goal, String> {
        if let Some(goal) = self.goal().filter(|goal| is_open(Some(goal))) {
            return Err(format!(
                "Goal {} is still {}; complete it or change it with update_goal edit instead of creating another.",
                goal.id(),
                goal.phase()
            ));
        }
        let next = create_goal(
            &crate::random_hex(6),
            objective,
            max_rounds.or(self.settings(agent).default_max_rounds),
            now_ms(),
        )?;
        self.armed.set(true);
        self.save(agent, Some(next.clone()))?;
        Ok(next)
    }

    fn update(
        &self,
        agent: &Agent,
        action: GoalAction,
        update: GoalUpdate,
    ) -> Result<Goal, String> {
        let Some(goal) = self.goal() else {
            return Err("There is no goal.".to_owned());
        };
        // Resuming a restored active goal only rearms it.
        if action == GoalAction::Resume && goal.is_active() {
            if self.armed.get() {
                return Err("The goal is already active".to_owned());
            }
            self.armed.set(true);
            self.paint(agent);
            return Ok(goal);
        }
        let next = apply_update(
            &goal,
            action,
            &update,
            self.settings(agent).min_blocked_rounds,
            now_ms(),
        )?;
        if action == GoalAction::Resume {
            self.armed.set(true);
        }
        self.save(agent, Some(next.clone()))?;
        match action {
            GoalAction::Complete => agent.ui().notify("Goal complete.", NotifyLevel::Info),
            GoalAction::Blocked => agent.ui().notify(
                &format!(
                    "Goal blocked: {}",
                    next.reason().map(js::string_of).unwrap_or_default()
                ),
                NotifyLevel::Warning,
            ),
            _ => {}
        }
        Ok(next)
    }

    /// `result(text, current, isError)`.
    fn result(&self, text: &str, current: Option<&Goal>, is_error: bool) -> ToolResult {
        let goal = current.map_or(Value::Null, Goal::to_value);
        let mut data = Map::new();
        data.insert("goal".to_owned(), goal.clone());
        data.insert("armed".to_owned(), json!(self.armed.get()));
        ToolResult {
            details: Some(json!({ "goal": goal, "armed": self.armed.get() })),
            is_error,
            data: Some(data),
            ..ToolResult::text(text)
        }
    }

    /// `/goal <subcommand> [rest]`.
    async fn command(self: &Rc<Self>, agent: &Rc<Agent>, args: &str) -> Result<(), String> {
        if !self.enabled(agent) {
            return Err(if self.child {
                "Goals are not available to team members".to_owned()
            } else {
                "Goals are disabled (features.goal.enabled)".to_owned()
            });
        }
        // `/^(\S+)(?:\s+([\s\S]*))?$/` on the trimmed arguments.
        let args = js::trim(args);
        let (command, rest) = match args.find(js::is_space) {
            _ if args.is_empty() => ("show", ""),
            Some(at) => (&args[..at], js::trim(&args[at..])),
            None => (args, ""),
        };
        let ui = agent.ui();
        if command == "help" {
            ui.notify(HELP, NotifyLevel::Info);
            return Ok(());
        }
        if command == "show" {
            ui.notify(&self.describe(self.goal().as_ref()), NotifyLevel::Info);
            return Ok(());
        }
        let message = match command {
            "set" => {
                if rest.is_empty() {
                    return Err("Usage: /goal set <objective>".to_owned());
                }
                if let Some(goal) = self.goal().filter(|goal| is_open(Some(goal))) {
                    let question = format!(
                        "Replace the {} goal \"{}\"?",
                        goal.phase(),
                        js::head16(&goal.objective(), 200)
                    );
                    let replace = ui
                        .confirm("Replace goal", &question, DialogOptions::default())
                        .await;
                    if replace != Some(true) {
                        return Ok(());
                    }
                    self.save(agent, None)?;
                }
                self.create(agent, rest, None)?;
                "Goal created.".to_owned()
            }
            "edit" => {
                if rest.is_empty() {
                    return Err("Usage: /goal edit <objective>".to_owned());
                }
                self.update(
                    agent,
                    GoalAction::Edit,
                    GoalUpdate {
                        objective: Some(rest.to_owned()),
                        ..GoalUpdate::default()
                    },
                )?;
                "Goal updated.".to_owned()
            }
            "rounds" => {
                let digits = rest.strip_prefix(|c: char| ('1'..='9').contains(&c));
                if !digits.is_some_and(|tail| tail.bytes().all(|b| b.is_ascii_digit())) {
                    return Err("Usage: /goal rounds <n>".to_owned());
                }
                // `validMaxRounds(Number(rest))`: past 2^53 it is not safe.
                let number: f64 = rest.parse().unwrap_or(f64::INFINITY);
                let limit = valid_max_rounds(Some(&json!(number)))?;
                self.update(
                    agent,
                    GoalAction::Edit,
                    GoalUpdate {
                        max_rounds: limit,
                        ..GoalUpdate::default()
                    },
                )?;
                format!("Goal round limit set to {rest}.")
            }
            "pause" | "resume" => {
                if !rest.is_empty() {
                    return Err(format!("Usage: /goal {command}"));
                }
                let action = if command == "pause" {
                    GoalAction::Pause
                } else {
                    GoalAction::Resume
                };
                self.update(agent, action, GoalUpdate::default())?;
                if command == "pause" {
                    "Goal paused.".to_owned()
                } else {
                    "Goal resumed.".to_owned()
                }
            }
            "clear" => {
                if self.goal().is_none() {
                    ui.notify("No goal.", NotifyLevel::Info);
                    return Ok(());
                }
                let confirmed = ui
                    .confirm(
                        "Clear goal",
                        "Remove the session goal?",
                        DialogOptions::default(),
                    )
                    .await;
                if confirmed != Some(true) {
                    return Ok(());
                }
                self.save(agent, None)?;
                "Goal cleared.".to_owned()
            }
            _ => return Err("Unknown command (/goal help)".to_owned()),
        };
        self.needs_snapshot.set(true);
        ui.notify(&message, NotifyLevel::Info);
        // Idle: start working now. Running: the current run settles first.
        if !agent.is_running() {
            self.schedule(agent);
        }
        Ok(())
    }
}

struct GoalFeature {
    state: Rc<State>,
}

impl Feature for GoalFeature {
    fn name(&self) -> &'static str {
        "goal"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        if !self.state.enabled(agent) {
            return Vec::new();
        }
        let weak = Rc::downgrade(agent);
        vec![
            Rc::new(CreateGoal::new(self.state.clone(), weak.clone())),
            Rc::new(GetGoal::new(self.state.clone())),
            Rc::new(UpdateGoal::new(self.state.clone(), weak)),
        ]
    }

    fn commands(&self) -> Vec<FeatureCommand> {
        vec![FeatureCommand::new("goal", "Session goal (/goal help)")]
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        _name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.state.command(agent, &args).await })
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let state = &self.state;
            if state.enabled(agent) {
                state.read(agent);
                state.armed.set(false);
                state.needs_snapshot.set(state.goal.borrow().is_some());
                state.paint(agent);
            }
            Ok(())
        })
    }

    fn user_input(&self, _agent: &Rc<Agent>, _text: &str) {
        // A steer joins the current run; a prompt starts the next one.
        self.state.human.set(true);
        self.state.human_pending.set(true);
    }

    fn will_continue(&self, agent: &Rc<Agent>) -> bool {
        let state = &self.state;
        state.enabled(agent)
            && state.active_and_armed()
            && !state.goal.borrow().as_ref().is_some_and(at_limit)
    }

    fn before_agent_start<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            let state = &self.state;
            state.human.set(state.human_pending.replace(false));
            state.clean_end.set(false);
            if !state.needs_snapshot.replace(false) {
                return Ok(None);
            }
            Ok(Some(BeforeStart {
                system_prompt: None,
                messages: vec![state.snapshot_message()],
            }))
        })
    }

    fn turn_end<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
        _message: &'a pirc_protocol::AssistantMessage,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        // A turn after an earlier clean agentEnd (follow-ups) may still fail.
        self.state.clean_end.set(false);
        Box::pin(async { Ok(()) })
    }

    fn agent_end<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
        produced: &'a [Message],
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        let clean = matches!(produced.last(),
            Some(Message::Assistant(message)) if message.stop_reason == StopReason::Stop);
        self.state.clean_end.set(clean);
        Box::pin(async { Ok(()) })
    }

    fn agent_settled<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let state = &self.state;
            // Another feature (e.g. a background notice) already started the next run.
            if agent.is_running() {
                return Ok(());
            }
            state.human_pending.set(false);
            if !state.enabled(agent) || !state.active_and_armed() {
                return Ok(());
            }
            if !state.clean_end.get() {
                let Some(goal) = state.goal() else {
                    return Ok(());
                };
                state.save(
                    agent,
                    Some(auto_pause(
                        &goal,
                        "The last run was interrupted or failed.",
                        now_ms(),
                    )),
                )?;
                state.needs_snapshot.set(true);
                agent.ui().notify(
                    "Goal paused: the last run was interrupted or failed.",
                    NotifyLevel::Warning,
                );
                return Ok(());
            }
            state.schedule(agent);
            Ok(())
        })
    }

    fn after_compact<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let state = &self.state;
            if state.enabled(agent) {
                state.read(agent);
                state.needs_snapshot.set(state.goal.borrow().is_some());
                state.paint(agent);
            }
            Ok(())
        })
    }

    fn shutdown<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, ()> {
        self.state.closed.set(true);
        if agent.has_ui() {
            agent.ui().set_widget(GOAL_WIDGET, None);
        }
        Box::pin(async {})
    }
}

/// `GOAL_RESULT`.
fn goal_result() -> Value {
    fields(
        vec![
            (
                "goal",
                nullable(obj(
                    vec![
                        ("id", str_(None)),
                        ("revision", int(None)),
                        ("objective", str_(None)),
                        (
                            "phase",
                            one_of_strings(&["active", "paused", "blocked", "complete"], None),
                        ),
                        ("rounds", int(Some("Continuation rounds started so far"))),
                        ("maxRounds", int(None)),
                        ("blockedReason", str_(None)),
                        ("pausedReason", str_(None)),
                        ("createdAt", int(Some("Epoch milliseconds"))),
                        ("updatedAt", int(Some("Epoch milliseconds"))),
                    ],
                    &["maxRounds", "blockedReason", "pausedReason"],
                )),
            ),
            ("armed", bool_(Some("Continuation rounds will run"))),
        ],
        &[],
    )
}

fn max_rounds_field(description: &str) -> Value {
    json!({ "type": "integer", "minimum": 1, "description": description })
}

/// The agent behind a tool; it outlives its tools.
fn upgrade(agent: &Weak<Agent>) -> Result<Rc<Agent>, String> {
    agent
        .upgrade()
        .ok_or_else(|| "The agent is gone".to_owned())
}

/// `create_goal`.
struct CreateGoal {
    spec: ToolSpec,
    state: Rc<State>,
    agent: Weak<Agent>,
}

impl CreateGoal {
    fn new(state: Rc<State>, agent: Weak<Agent>) -> Self {
        Self {
            spec: ToolSpec::new(
                "create_goal",
                json!({
                    "type": "object",
                    "properties": {
                        "objective": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The concrete completion objective inferred from the user request.",
                        },
                        "max_goal_rounds": max_rounds_field(
                            "Optional limit on automatic continuation rounds."),
                    },
                    "required": ["objective"],
                    "additionalProperties": false,
                }),
                Some(goal_result()),
            ),
            state,
            agent,
        }
    }

    async fn run(&self, args: Map<String, Value>, _ctx: ToolContext) -> Result<ToolResult, String> {
        let agent = upgrade(&self.agent)?;
        let state = &self.state;
        let created = (|| {
            state.require_human("create_goal")?;
            let objective = match args.get("objective") {
                None | Some(Value::Null) => String::new(),
                Some(value) => js::string_of(value),
            };
            let max_rounds = valid_max_rounds(args.get("max_goal_rounds"))?;
            state.create(&agent, &objective, max_rounds)
        })();
        Ok(match created {
            Ok(created) => state.result(
                &format!("Goal created.\n{}", format_goal(Some(&created))),
                Some(&created),
                false,
            ),
            Err(error) => state.result(&error, state.goal().as_ref(), true),
        })
    }
}

spec_tool!(CreateGoal, ptc: false);

/// `get_goal`.
struct GetGoal {
    spec: ToolSpec,
    state: Rc<State>,
}

impl GetGoal {
    fn new(state: Rc<State>) -> Self {
        Self {
            spec: ToolSpec::new(
                "get_goal",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                Some(goal_result()),
            ),
            state,
        }
    }

    async fn run(
        &self,
        _args: Map<String, Value>,
        _ctx: ToolContext,
    ) -> Result<ToolResult, String> {
        let goal = self.state.goal();
        Ok(self
            .state
            .result(&self.state.describe(goal.as_ref()), goal.as_ref(), false))
    }
}

spec_tool!(GetGoal, ptc: false);

/// `update_goal`.
struct UpdateGoal {
    spec: ToolSpec,
    state: Rc<State>,
    agent: Weak<Agent>,
}

impl UpdateGoal {
    fn new(state: Rc<State>, agent: Weak<Agent>) -> Self {
        Self {
            spec: ToolSpec::new(
                "update_goal",
                json!({
                    "type": "object",
                    "properties": {
                        "goal_id": { "type": "string", "description": "Exact id from get_goal." },
                        "revision": { "type": "integer", "description": "Exact revision from get_goal." },
                        "action": { "type": "string",
                            "enum": ["edit", "pause", "resume", "complete", "blocked"] },
                        "objective": { "type": "string",
                            "description": "Replacement objective (edit only)." },
                        "max_goal_rounds": max_rounds_field("Replacement cap (edit only)."),
                        "blocked_reason": {
                            "type": "string",
                            "description": "Concrete blocking condition (blocked only).",
                        },
                    },
                    "required": ["goal_id", "revision", "action"],
                    "additionalProperties": false,
                }),
                Some(goal_result()),
            ),
            state,
            agent,
        }
    }

    fn apply(
        &self,
        agent: &Agent,
        args: &Map<String, Value>,
    ) -> Result<(GoalAction, Goal), String> {
        let state = &self.state;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .and_then(GoalAction::parse)
            .ok_or_else(|| format!("Unknown action {}", js::shown(args.get("action"))))?;
        let Some(goal) = state.goal() else {
            return Err("There is no goal.".to_owned());
        };
        let same_id = args.get("goal_id").and_then(Value::as_str) == Some(goal.id().as_str());
        let same_revision = match (args.get("revision"), goal.revision_value()) {
            (Some(Value::Number(given)), Value::Number(current)) => {
                given.as_f64() == current.as_f64()
            }
            _ => false,
        };
        if !same_id || !same_revision {
            return Err(format!(
                "Stale goal reference: the current goal is {} at revision {}. Call get_goal and retry.",
                goal.id(),
                js::string_of(&goal.revision_value())
            ));
        }
        if matches!(
            action,
            GoalAction::Edit | GoalAction::Pause | GoalAction::Resume
        ) {
            state.require_human(&format!("update_goal {}", action.as_str()))?;
        }
        if action != GoalAction::Edit
            && (args.contains_key("objective") || args.contains_key("max_goal_rounds"))
        {
            return Err("objective and max_goal_rounds are only valid with edit".to_owned());
        }
        if action != GoalAction::Blocked && args.contains_key("blocked_reason") {
            return Err("blocked_reason is only valid with blocked".to_owned());
        }
        let update = GoalUpdate {
            objective: args.get("objective").map(js::string_of),
            max_rounds: match args.get("max_goal_rounds") {
                None => None,
                Some(value) => valid_max_rounds(Some(value))?,
            },
            blocked_reason: args.get("blocked_reason").map(js::string_of),
        };
        Ok((action, state.update(agent, action, update)?))
    }

    async fn run(&self, args: Map<String, Value>, _ctx: ToolContext) -> Result<ToolResult, String> {
        let agent = upgrade(&self.agent)?;
        let state = &self.state;
        Ok(match self.apply(&agent, &args) {
            Ok((action, updated)) => state.result(
                &format!(
                    "Goal updated ({}).\n{}",
                    action.as_str(),
                    state.describe(Some(&updated))
                ),
                Some(&updated),
                false,
            ),
            Err(error) => state.result(&error, state.goal().as_ref(), true),
        })
    }
}

spec_tool!(UpdateGoal, ptc: false);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_fall_back_as_a_whole() {
        assert_eq!(parse_settings(None), DEFAULTS);
        assert_eq!(parse_settings(Some(&json!(true))), DEFAULTS);
        assert_eq!(
            parse_settings(Some(&json!({ "enabled": false, "minBlockedRounds": 0,
                "defaultMaxRounds": 2 }))),
            Settings {
                enabled: false,
                min_blocked_rounds: 0,
                default_max_rounds: Some(2),
            }
        );
        for bad in [
            json!({ "minBlockedRounds": 500, "defaultMaxRounds": 1 }),
            json!({ "enabled": "no", "defaultMaxRounds": 1 }),
            json!({ "defaultMaxRounds": 0 }),
            json!({ "defaultMaxRounds": null }),
            json!({ "minBlockedRounds": 1.5 }),
        ] {
            assert_eq!(parse_settings(Some(&bad)), DEFAULTS, "{bad}");
        }
    }
}
