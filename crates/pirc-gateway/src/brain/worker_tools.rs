//! The brain's workers (plans/rewrite/06-workers.md): `call_worker`,
//! `worker_status`, `stop_worker`, and the prompt section that says where
//! workers can go and which are still at it. Calling one asks nobody; the
//! gateway's `delegations` runs it, writes its message and thread in the
//! room, and tells the brain how it ended at its next turn there.
//!
//! A worker gets no memory of the people: only the task, the facts and
//! loops the brain hands it (`context`, by id; packed into text here with
//! where each came from), and the person's own words when the brain quotes
//! them (verified in their last messages, as for preferences), which its
//! auto mode reads as their request. A worker a wake calls works read-only,
//! and a wake cannot stop one.

use std::rc::{Rc, Weak};

use pirc_agent::LocalBoxFuture;
use pirc_agent::agent::Agent;
use pirc_agent::context::PromptSection;
use pirc_agent::feature::Feature;
use pirc_agent::origins::current_origins;
use pirc_agent::tools::{Tool, ToolContext, ToolResult};
use serde_json::{Map, Value, json};
use tokio::runtime::Handle;

use super::loops;
use super::memory::{RoomMemory, WRITING_TOOLS, object, quoted};
use super::turn::Progress;
use crate::app::App;
use crate::db::rooms::HOST_FACE_ID;
use crate::delegations::{self, NewWorker};
use crate::memory::text::clip;
use crate::memory_records::person;

/// Facts and loops handed to one worker, at most.
const CONTEXT_ITEMS: usize = 20;
const CONTEXT_ITEM_CHARS: usize = 600;
/// Workspaces and unfinished workers listed in the prompt, at most.
const LISTED: usize = 30;

/// The feature that gives a room's agent its worker tools.
pub struct WorkerFeature {
    pub memory: Rc<RoomMemory>,
    pub progress: Rc<Progress>,
    /// The gateway's main runtime, where workers start and node requests run.
    pub runtime: Handle,
}

impl Feature for WorkerFeature {
    fn name(&self) -> &'static str {
        "brain-workers"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        [Which::Call, Which::Status, Which::Stop]
            .into_iter()
            .map(|which| {
                Rc::new(WorkerTool::new(
                    which,
                    self.memory.clone(),
                    self.progress.clone(),
                    Rc::downgrade(agent),
                    self.runtime.clone(),
                )) as Rc<dyn Tool>
            })
            .collect()
    }
}

/// The workers section of a turn's prompt: what workers are, where they
/// can go (online or not), and those not done yet.
pub fn section(app: &App, waking: bool) -> PromptSection {
    let mut text = String::from(
        "## Workers\n\n\
         `call_worker` hands work to a worker: a coding agent in one of the workspaces below, with its own session, tools and judgement. \
         It starts at once, without asking anyone; at most 4 run at a time and the others wait their turn. \
         It knows nothing of the people or of what you remember: write the task in full, hand it the facts and loops that bear on it \
         (`context`, by id), and when a person asked for it, `quote` their own words so it may act on their request. \
         The room is shown your message about it, with a thread under it where its progress shows; when it ends, its report is said in the room \
         and you hear of it at your next turn here. Give a finished worker more to do with `follows`; look at them with `worker_status`.",
    );
    if waking {
        text.push_str(" While awake, a worker you call works read-only, and you cannot stop one.");
    } else {
        text.push_str(" `stop_worker` stops one.");
    }
    let listed = delegations::workspaces(app, None).unwrap_or_else(|_| json!([]));
    let workspaces = listed.as_array().map(Vec::as_slice).unwrap_or_default();
    if workspaces.is_empty() {
        text.push_str("\n\nWorkspaces: none yet, so no worker can be called now.");
    } else {
        text.push_str("\n\nWorkspaces (`workspace` takes the id):");
        for workspace in workspaces.iter().take(LISTED) {
            let field = |key: &str| workspace[key].as_str().unwrap_or_default();
            let mut line = format!(
                "\n- {}: {} on {}",
                field("id"),
                field("name"),
                field("node")
            );
            line.push_str(if workspace["online"] == true {
                " (online"
            } else {
                " (offline: a worker waits for it"
            });
            if let Some(roles) = workspace["roles"]
                .as_array()
                .filter(|roles| !roles.is_empty())
            {
                let names: Vec<&str> = roles
                    .iter()
                    .filter_map(|role| role["name"].as_str())
                    .collect();
                line.push_str(&format!("; roles: {}", names.join(", ")));
            }
            line.push(')');
            text.push_str(&line);
        }
    }
    let active = delegations::list(&app.db.lock(), None, true, LISTED).unwrap_or_default();
    if !active.is_empty() {
        text.push_str("\n\nWorkers not done yet:");
        let conn = app.db.lock();
        for delegation in active.iter().rev() {
            let brief = delegations::brief(&conn, delegation, false, 0).unwrap_or_default();
            text.push_str(&format!(
                "\n- [{}] {} · {} · {} · in {}",
                delegation.id,
                delegation.title,
                delegation.status,
                brief["workspace"].as_str().unwrap_or_default(),
                delegation.room_id,
            ));
        }
    }
    PromptSection::new("workers", "Workers", "built-in", text)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Which {
    Call,
    Status,
    Stop,
}

struct WorkerTool {
    which: Which,
    memory: Rc<RoomMemory>,
    progress: Rc<Progress>,
    agent: Weak<Agent>,
    runtime: Handle,
    description: String,
    parameters: Map<String, Value>,
}

impl WorkerTool {
    fn new(
        which: Which,
        memory: Rc<RoomMemory>,
        progress: Rc<Progress>,
        agent: Weak<Agent>,
        runtime: Handle,
    ) -> Self {
        let (description, parameters) = match which {
            Which::Call => (
                "Call a worker: a coding agent that does the task in one of the workspaces listed under Workers, at once and without asking anyone. \
                 The room is shown that you did, with a thread for its progress; you hear how it ended at your next turn here. \
                 Write `task` so it stands on its own: the worker knows nothing else. Say in your reply only what you need to; the room already shows the call.",
                object(
                    json!({
                        "task": { "type": "string", "description": "What to do, in full: the goal, what you know, what to bring back." },
                        "workspace": { "type": "string", "description": "The workspace's id (or its name, when only one has it). Not with `follows`." },
                        "title": { "type": "string", "description": "A few words for the room; the task's first line when left out." },
                        "read_only": { "type": "boolean", "description": "It only looks and reports, changing nothing (always so while you are awake)." },
                        "follows": { "type": "string", "description": "A finished worker's id: this task goes to its session, in its thread." },
                        "role": { "type": "string", "description": "A role the workspace lists, for a new worker." },
                        "quote": { "type": "string", "description": "The person's own words asking for it, exactly as they wrote them in one of their last messages." },
                        "context": {
                            "type": "object",
                            "description": "What you remember that bears on it, by id: it is handed over with where each came from.",
                            "properties": {
                                "fact_ids": { "type": "array", "items": { "type": "string" } },
                                "loop_ids": { "type": "array", "items": { "type": "string" } },
                            },
                            "additionalProperties": false,
                        },
                    }),
                    &["task"],
                ),
            ),
            Which::Status => (
                "Look at workers: one by `id` (its whole result, `offset` to read on), or the latest 20.",
                object(
                    json!({
                        "id": { "type": "string" },
                        "offset": { "type": "integer", "minimum": 0 },
                    }),
                    &[],
                ),
            ),
            Which::Stop => (
                "Stop a worker that is waiting or working, when it is no longer wanted. The room is told how it ended.",
                object(json!({ "id": { "type": "string" } }), &["id"]),
            ),
        };
        Self {
            which,
            memory,
            progress,
            agent,
            runtime,
            description: description.to_owned(),
            parameters,
        }
    }

    async fn run(&self, args: Map<String, Value>) -> Result<ToolResult, String> {
        let Some(agent) = self.agent.upgrade() else {
            return Err("The room's conversation is closed".to_owned());
        };
        let text = |key: &str| -> Option<String> {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let app = self.memory.app.clone();
        let waking = self.progress.wake.borrow().clone();
        match self.which {
            Which::Call => {
                let Some(task) = text("task") else {
                    return Ok(ToolResult::error("`task` is required"));
                };
                let branch = agent.branch();
                let mut owner = self
                    .memory
                    .owner()
                    .or_else(|| waking.as_ref().and_then(|wake| wake.user.clone()));
                let (quote, entry_ids) = match text("quote") {
                    None => (None, Vec::new()),
                    Some(_) if waking.is_some() => {
                        return Ok(ToolResult::error(
                            "Nobody asked while you are awake: call it without a quote",
                        ));
                    }
                    Some(quote) => {
                        let mut people: Vec<String> =
                            app.config.auth.allowed_users.iter().cloned().collect();
                        people.sort();
                        match quoted(&branch, &quote, &people) {
                            Some((who, entry_id)) => {
                                owner = Some(who);
                                (Some(quote), vec![entry_id])
                            }
                            None => {
                                return Ok(ToolResult::error(
                                    "That quote is not in what anyone here said in their last messages; leave it out or quote them exactly",
                                ));
                            }
                        }
                    }
                };
                let Some(owner) = owner else {
                    return Ok(ToolResult::error("Nobody has said anything here yet"));
                };
                let context = match args.get("context") {
                    None | Some(Value::Null) => None,
                    Some(context) => match pack(&app, &owner, context) {
                        Ok(packed) => packed,
                        Err(error) => return Ok(ToolResult::error(error)),
                    },
                };
                let origins = current_origins(
                    &branch,
                    &agent.running_script_capabilities(),
                    &WRITING_TOOLS,
                );
                let read_only =
                    waking.is_some() || args.get("read_only") == Some(&Value::Bool(true));
                let called = delegations::call(
                    &app,
                    NewWorker {
                        room_id: self.memory.room_id.clone(),
                        face_id: HOST_FACE_ID.to_owned(),
                        user: owner.clone(),
                        task,
                        title: text("title"),
                        workspace: text("workspace"),
                        follows: text("follows"),
                        role: text("role"),
                        read_only,
                        quote,
                        entry_ids,
                        origins,
                        context,
                        wake_id: waking.as_ref().map(|wake| wake.id.clone()),
                    },
                );
                let delegation = match called {
                    Ok(delegation) => delegation,
                    Err(error) => return Ok(ToolResult::error(error.message)),
                };
                // Started on the main runtime, where its node requests run.
                let pumped = app.clone();
                let started = self
                    .runtime
                    .spawn(async move { delegations::pump(&pumped) });
                let _ = started.await;
                let brief = {
                    let conn = app.db.lock();
                    delegations::get(&conn, &delegation.id)
                        .and_then(|fresh| delegations::brief(&conn, &fresh, false, 0))
                        .unwrap_or_default()
                };
                Ok(ToolResult::text(format!(
                    "Called worker {} for {owner}{}: {}. The room shows it, with a thread for its progress; you will hear how it ended at your next turn here.\n{}",
                    delegation.id,
                    if delegation.read_only {
                        " (read-only)"
                    } else {
                        ""
                    },
                    brief["status"].as_str().unwrap_or("queued"),
                    brief,
                )))
            }
            Which::Status => {
                let offset = args.get("offset").and_then(Value::as_u64);
                let conn = app.db.lock();
                let found = match text("id") {
                    Some(id) => delegations::get(&conn, &id).and_then(|delegation| {
                        delegations::brief(&conn, &delegation, true, offset.unwrap_or(0))
                            .map(|brief| json!({ "workers": [brief] }))
                    }),
                    None if offset.is_some() => {
                        return Ok(ToolResult::error("`offset` needs an `id`"));
                    }
                    None => delegations::list(&conn, None, false, 20).and_then(|list| {
                        list.iter()
                            .map(|delegation| delegations::brief(&conn, delegation, false, 0))
                            .collect::<Result<Vec<_>, _>>()
                            .map(|briefs| json!({ "workers": briefs }))
                    }),
                };
                Ok(match found {
                    Ok(found) => ToolResult::text(found.to_string()),
                    Err(error) => ToolResult::error(error.message),
                })
            }
            Which::Stop => {
                let Some(id) = text("id") else {
                    return Ok(ToolResult::error("`id` is required"));
                };
                if waking.is_some() {
                    return Ok(ToolResult::error(
                        "While awake you do nothing on anyone's behalf; ask in the room instead",
                    ));
                }
                let stopping = app.clone();
                let stopped = self
                    .runtime
                    .spawn(async move { delegations::stop(&stopping, None, &id).await })
                    .await;
                Ok(match stopped {
                    Ok(Ok(status)) => ToolResult::text(format!("Stopping: {status}")),
                    Ok(Err(error)) => ToolResult::error(error.message),
                    Err(_) => ToolResult::error("The worker could not be stopped"),
                })
            }
        }
    }
}

/// The facts and loops handed to a worker (`{fact_ids, loop_ids}`), as
/// `{facts, loops, text}`: what they say and where each came from.
fn pack(app: &App, owner: &str, context: &Value) -> Result<Option<Value>, String> {
    let ids = |key: &str| -> Result<Vec<String>, String> {
        match context.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) if items.len() <= CONTEXT_ITEMS => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| format!("`context.{key}` lists ids"))
                })
                .collect(),
            Some(_) => Err(format!("`context.{key}` lists at most {CONTEXT_ITEMS} ids")),
        }
    };
    let (fact_ids, loop_ids) = (ids("fact_ids")?, ids("loop_ids")?);
    if fact_ids.is_empty() && loop_ids.is_empty() {
        return Ok(None);
    }
    let conn = app.db.lock();
    let mut facts = Vec::new();
    let mut loops_given = Vec::new();
    let mut lines = Vec::new();
    for id in &fact_ids {
        let fact = person::get(&conn, owner, id)
            .ok()
            .filter(|fact| fact.status == "active")
            .ok_or_else(|| format!("No fact {id}"))?;
        let content = clip(&fact.content, CONTEXT_ITEM_CHARS);
        lines.push(format!(
            "- [{}] (fact, from {}) {content}",
            fact.id, fact.origin
        ));
        facts.push(json!({ "id": fact.id, "content": content, "origin": fact.origin }));
    }
    for id in &loop_ids {
        let open_loop = loops::get(&conn, id).map_err(|_| format!("No loop {id}"))?;
        let mut line = format!(
            "- [{}] (open loop, from {}) {}",
            open_loop.id,
            open_loop.origin,
            clip(&open_loop.what, CONTEXT_ITEM_CHARS)
        );
        if !open_loop.why.is_empty() {
            line.push_str(&format!(
                " (why: {})",
                clip(&open_loop.why, CONTEXT_ITEM_CHARS)
            ));
        }
        lines.push(line);
        loops_given.push(json!({
            "id": open_loop.id,
            "what": open_loop.what,
            "why": open_loop.why,
            "origin": open_loop.origin,
        }));
    }
    Ok(Some(
        json!({ "facts": facts, "loops": loops_given, "text": lines.join("\n") }),
    ))
}

impl Tool for WorkerTool {
    fn name(&self) -> &str {
        match self.which {
            Which::Call => "call_worker",
            Which::Status => "worker_status",
            Which::Stop => "stop_worker",
        }
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> &Map<String, Value> {
        &self.parameters
    }

    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        _ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(self.run(args))
    }
}
