//! `schedules` (`agent/features/schedules.ts`, docs/guides/schedules.md): the
//! gateway keeps the user's schedules and starts each run in a new
//! session. The `schedule` tool lists them and proposes new ones or
//! changes, which the user approves in the chat; pausing and deleting take
//! effect at once. `/cron` gives the user the same without the model. Only
//! a node's main agent has a gateway (`channels::process_gateway`).

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use serde_json::{Map, Value, json};

use super::web_search::{feature_enabled, today};
use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::capabilities::Capabilities;
use crate::channels::{ChannelError, process_gateway};
use crate::feature::{Feature, FeatureCommand};
use crate::tools::prompts::{PromptVar, tool_prompt};
use crate::tools::result_schema::{ActionFields, arr, by_action, int, nullable, obj, str_};
use crate::tools::{Tool, ToolContext, ToolResult, ToolSpec, js, spec_tool, typed};
use crate::ui::NotifyLevel;

pub const SCHEDULE_TOOL: &str = "schedule";

const HELP: &str = "/cron — list schedules
/cron pause <id> | resume <id> | delete <id> | run <id>
Ask the agent to create or change a schedule; you approve it in the chat.";

/// `schedulesFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SchedulesFeature {
        current: RefCell::new(Weak::new()),
    })
}

fn enabled(agent: &Agent) -> bool {
    feature_enabled(agent, "schedules")
}

/// `unreachable`: the gateway itself could not answer.
fn unreachable(code: &str) -> bool {
    matches!(
        code,
        "gateway_offline" | "gateway_timeout" | "gateway_closed"
    )
}

/// A field as a template literal shows it (`undefined` when absent).
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::string_of)
}

/// `text.replace(/\s+/g, ' ')` with JavaScript's `\s`.
fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn squashed(value: Option<&Value>, key: &str) -> Result<String, String> {
    match value {
        Some(Value::String(text)) => Ok(squash(text)),
        _ => Err(format!("{key} is not a string")),
    }
}

/// `formatSchedules`: one line per schedule, then its prompt and last run.
pub fn format_schedules(schedules: &[Value], timezone: &str) -> Result<String, String> {
    if schedules.is_empty() {
        return Ok(format!("No schedules. Default time zone: {timezone}."));
    }
    let mut lines = vec![format!("Schedules (default time zone {timezone}):")];
    for item in schedules {
        let optional = |key: &str, label: &str| {
            if js::truthy(item.get(key)) {
                format!("; {label}{}", shown(item.get(key)))
            } else {
                String::new()
            }
        };
        let mut block = vec![
            format!(
                "- {} “{}” [{}] in {}: {}{}{}{}{}",
                shown(item.get("id")),
                shown(item.get("title")),
                shown(item.get("status")),
                shown(item.get("workspace")),
                shown(item.get("when")),
                optional("nextRun", "next "),
                optional("model", "model "),
                optional("thinking", "thinking "),
                optional("notify", "notifications: "),
            ),
            format!("  prompt: {}", squashed(item.get("prompt"), "prompt")?),
        ];
        if let Some(run) = item.get("lastRun").filter(|run| js::truthy(Some(run))) {
            let result = if js::truthy(run.get("result")) {
                format!(" — {}", squashed(run.get("result"), "result")?)
            } else {
                String::new()
            };
            let chars = if js::truthy(run.get("resultChars")) {
                format!(
                    " [{} characters; read it with action result id={}]",
                    shown(run.get("resultChars")),
                    shown(run.get("id"))
                )
            } else {
                String::new()
            };
            block.push(format!(
                "  last run {} ({}): {}{result}{chars}",
                shown(run.get("id")),
                shown(run.get("due")),
                shown(run.get("status")),
            ));
        }
        lines.push(block.join("\n"));
    }
    Ok(lines.join("\n"))
}

/// `formatRunResult`: a run's result chunk, with where it stands and how to
/// read on. `nextOffset: null` counts as given, as in TS.
pub fn format_run_result(run: &Value) -> String {
    let next = run.get("nextOffset");
    let end = match next {
        None | Some(Value::Null) => shown(run.get("resultChars")),
        Some(next) => js::string_of(next),
    };
    let session = if js::truthy(run.get("session")) {
        format!(" (session “{}”)", shown(run.get("session")))
    } else {
        String::new()
    };
    let head = format!(
        "Run {} of {} [{}]{session}",
        shown(run.get("id")),
        shown(run.get("schedule")),
        shown(run.get("status"))
    );
    if !js::truthy(run.get("resultChars")) {
        return format!("{head}: no result.");
    }
    let offset = shown(run.get("resultOffset"));
    let whole = run.get("resultOffset").and_then(Value::as_f64) == Some(0.0) && next.is_none();
    let footer = if whole {
        String::new()
    } else if next.is_none() {
        format!(
            "\n[Result characters {offset}–{end} of {}; end of result]",
            shown(run.get("resultChars"))
        )
    } else {
        format!(
            "\n[Result characters {offset}–{end} of {}; continue with action result id={} offset={end}]",
            shown(run.get("resultChars")),
            shown(run.get("id"))
        )
    };
    format!("{head}:\n{}{footer}", shown(run.get("result")))
}

/// `BRIEF`.
fn brief_schema() -> Value {
    obj(
        vec![
            ("id", str_(None)),
            ("title", str_(None)),
            ("workspace", str_(None)),
            (
                "when",
                str_(Some("The cron expression or one-off time, as text")),
            ),
            ("status", str_(None)),
            ("nextRun", str_(None)),
            ("model", str_(None)),
            ("thinking", str_(None)),
            ("notify", str_(None)),
            ("prompt", str_(None)),
            (
                "lastRun",
                obj(
                    vec![
                        ("id", str_(None)),
                        ("status", str_(None)),
                        ("due", str_(None)),
                        ("result", str_(None)),
                        ("resultChars", int(None)),
                    ],
                    &["result", "resultChars"],
                ),
            ),
        ],
        &["nextRun", "model", "thinking", "notify", "lastRun"],
    )
}

/// `pick`: only the documented fields of a gateway record, so results
/// match the contract.
fn pick(record: &Value, schema: &Value) -> Value {
    let mut out = Map::new();
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, field) in properties {
            let Some(value) = record.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            let value = if field.get("type") == Some(&json!("object")) {
                pick(value, field)
            } else {
                value.clone()
            };
            out.insert(key.clone(), value);
        }
    }
    Value::Object(out)
}

/// `SCHEDULE_RESULT`.
fn schedule_result() -> Value {
    let action = |name, properties, optional| -> ActionFields<'_> { (name, properties, optional) };
    by_action(vec![
        action(
            "list",
            vec![
                ("timezone", str_(None)),
                ("schedules", arr(brief_schema(), None)),
            ],
            &[],
        ),
        action(
            "create",
            vec![
                (
                    "proposalId",
                    str_(Some(
                        "The user approves it in the chat; it does not exist until then",
                    )),
                ),
                ("title", str_(None)),
            ],
            &[],
        ),
        action(
            "update",
            vec![("proposalId", str_(None)), ("title", str_(None))],
            &[],
        ),
        action(
            "pause",
            vec![
                ("id", str_(None)),
                ("title", str_(None)),
                ("nextRun", str_(None)),
            ],
            &["nextRun"],
        ),
        action(
            "resume",
            vec![
                ("id", str_(None)),
                ("title", str_(None)),
                ("nextRun", str_(None)),
            ],
            &["nextRun"],
        ),
        action(
            "delete",
            vec![
                ("id", str_(None)),
                ("title", str_(None)),
                (
                    "proposalId",
                    str_(Some(
                        "The user approves the deletion in the chat; the schedule stays until then",
                    )),
                ),
            ],
            &[],
        ),
        action(
            "result",
            vec![
                ("id", str_(Some("The run"))),
                ("schedule", str_(None)),
                ("status", str_(None)),
                ("session", str_(None)),
                ("result", str_(Some("This chunk of the result"))),
                ("resultOffset", int(None)),
                ("resultChars", int(None)),
                (
                    "nextOffset",
                    nullable(int(Some("Where the next chunk starts, or null at the end"))),
                ),
            ],
            &["session"],
        ),
    ])
}

fn param(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

/// `failure`: a gateway error as the tool's result.
fn failure(error: ChannelError) -> Result<ToolResult, String> {
    let ChannelError::Coded { code, message, .. } = error else {
        return Err(error.message().to_owned());
    };
    let text = if unreachable(&code) {
        "Schedules are unavailable right now: the gateway cannot be reached. Nothing changed."
            .to_owned()
    } else {
        message
    };
    Ok(ToolResult {
        details: Some(json!({ "code": code })),
        ..ToolResult::error(text)
    })
}

/// Insert `value` unless it is absent (`{key: undefined}` in TS).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.clone());
    }
}

/// `schedule`.
struct ScheduleTool {
    spec: ToolSpec,
}

impl ScheduleTool {
    fn new() -> Self {
        let description = tool_prompt(SCHEDULE_TOOL, &[("today", PromptVar::Text(&today()))])
            .expect("the schedule description");
        let parameters = json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "create", "update", "pause", "resume", "delete", "result"],
                },
                "id": param("The schedule (like s1a2b3c4d) for update, pause, resume and delete; the run (like r1a2b3c4d) for result"),
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "With result: first result character to return (default 0)",
                },
                "prompt": param("What the scheduled agent should do, standing on its own"),
                "title": param("A short title; it names each run session"),
                "cron": param("Repeat: 5-field cron expression"),
                "at": param("Once: ISO 8601 time; without an offset it is read in timezone"),
                "timezone": param("IANA time zone for cron and at"),
                "workspace": param("Where it runs (workspace id or name). Default: this workspace. Only the assistant may pick another one."),
                "notify": {
                    "type": "string",
                    "enum": ["all", "problems", "none"],
                    "description": "Push notifications: every run (all, the default), only runs that fail, are missed or wait for the user (problems), or none. Pick problems for frequent schedules.",
                },
            },
            "required": ["action"],
            "additionalProperties": false,
        });
        let Value::Object(parameters) = parameters else {
            unreachable!()
        };
        Self {
            spec: ToolSpec {
                name: SCHEDULE_TOOL,
                description,
                parameters,
                result_schema: Some(schedule_result()),
            },
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let trimmed = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .map(js::trim)
                .filter(|value| !value.is_empty())
        };
        let mut spec = Map::new();
        for key in [
            "title",
            "cron",
            "at",
            "timezone",
            "workspace",
            "notify",
            "prompt",
        ] {
            if let Some(value) = trimmed(key) {
                spec.insert(key.to_owned(), json!(value));
            }
        }
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .map(js::trim)
            .unwrap_or_default()
            .to_owned();
        let gateway = process_gateway().ok_or_else(|| "No gateway".to_owned())?;
        let request = |op: &str, args: Map<String, Value>| {
            gateway.gateway.request(op, args, Some(&ctx.signal))
        };
        let id_args = || {
            let mut out = Map::new();
            out.insert("id".to_owned(), json!(id));
            out
        };
        let id_required = || Ok(ToolResult::error("id is required"));
        match action {
            "list" => {
                let result = match request("schedule.list", Map::new()).await {
                    Ok(result) => result,
                    Err(error) => return failure(error),
                };
                let schedules = result
                    .get("schedules")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or_else(|| "The schedule list has no schedules".to_owned())?;
                let timezone = shown(result.get("timezone"));
                let brief = brief_schema();
                let mut data = Map::new();
                data.insert("action".to_owned(), json!(action));
                put(&mut data, "timezone", result.get("timezone"));
                data.insert(
                    "schedules".to_owned(),
                    Value::Array(schedules.iter().map(|item| pick(item, &brief)).collect()),
                );
                let ids: Vec<Value> = schedules
                    .iter()
                    .map(|item| item.get("id").cloned().unwrap_or(Value::Null))
                    .collect();
                Ok(typed(
                    format_schedules(&schedules, &timezone)?,
                    Value::Object(data),
                    Some(json!({ "ids": ids })),
                    false,
                ))
            }
            "create" | "update" => {
                let (op, args) = if action == "create" {
                    if !spec.contains_key("prompt") {
                        return Ok(ToolResult::error("prompt is required"));
                    }
                    ("schedule.create", spec)
                } else {
                    if id.is_empty() {
                        return id_required();
                    }
                    let mut args = id_args();
                    args.extend(spec);
                    ("schedule.update", args)
                };
                let result = match request(op, args).await {
                    Ok(result) => result,
                    Err(error) => return failure(error),
                };
                let title = shown(result.get("title"));
                let text = if action == "create" {
                    format!(
                        "Asked the user to approve the schedule “{title}”. It does not exist until they do; check with list afterwards."
                    )
                } else {
                    format!(
                        "Asked the user to approve the change to “{title}”. It keeps its current settings until they do."
                    )
                };
                let mut data = Map::new();
                data.insert("action".to_owned(), json!(action));
                put(&mut data, "proposalId", result.get("proposalId"));
                put(&mut data, "title", result.get("title"));
                let mut details = Map::new();
                put(&mut details, "proposalId", result.get("proposalId"));
                Ok(typed(
                    text,
                    Value::Object(data),
                    Some(Value::Object(details)),
                    false,
                ))
            }
            "delete" => {
                if id.is_empty() {
                    return id_required();
                }
                let result = match request("schedule.delete", id_args()).await {
                    Ok(result) => result,
                    Err(error) => return failure(error),
                };
                let mut data = Map::new();
                data.insert("action".to_owned(), json!(action));
                data.insert("id".to_owned(), json!(id));
                put(&mut data, "title", result.get("title"));
                put(&mut data, "proposalId", result.get("proposalId"));
                let mut details = Map::new();
                details.insert("id".to_owned(), json!(id));
                put(&mut details, "proposalId", result.get("proposalId"));
                Ok(typed(
                    format!(
                        "Asked the user to approve deleting “{}”. It stays, and keeps running, until they do; check with list afterwards.",
                        shown(result.get("title"))
                    ),
                    Value::Object(data),
                    Some(Value::Object(details)),
                    false,
                ))
            }
            "pause" | "resume" => {
                if id.is_empty() {
                    return id_required();
                }
                let result = match request(&format!("schedule.{action}"), id_args()).await {
                    Ok(result) => result,
                    Err(error) => return failure(error),
                };
                let done = if action == "pause" {
                    "Paused"
                } else {
                    "Resumed"
                };
                let next_run = result
                    .get("nextRun")
                    .filter(|value| js::truthy(Some(value)));
                let mut data = Map::new();
                data.insert("action".to_owned(), json!(action));
                data.insert("id".to_owned(), json!(id));
                put(&mut data, "title", result.get("title"));
                put(&mut data, "nextRun", next_run);
                Ok(typed(
                    format!(
                        "{done} “{}”{}.",
                        shown(result.get("title")),
                        next_run
                            .map(|next| format!("; next run {}", js::string_of(next)))
                            .unwrap_or_default()
                    ),
                    Value::Object(data),
                    Some(json!({ "id": id })),
                    false,
                ))
            }
            "result" => {
                if id.is_empty() {
                    return id_required();
                }
                // `Number.isInteger(args.offset) && args.offset > 0`.
                let offset = args.get("offset").filter(|offset| {
                    offset
                        .as_f64()
                        .is_some_and(|offset| offset.fract() == 0.0 && offset > 0.0)
                });
                let mut request_args = id_args();
                put(&mut request_args, "offset", offset);
                let run = match request("schedule.result", request_args).await {
                    Ok(run) => run,
                    Err(error) => return failure(error),
                };
                let next_offset = run.get("nextOffset").cloned().unwrap_or(Value::Null);
                let mut data = Map::new();
                data.insert("action".to_owned(), json!(action));
                for key in ["id", "schedule", "status"] {
                    put(&mut data, key, run.get(key));
                }
                if js::truthy(run.get("session")) {
                    put(&mut data, "session", run.get("session"));
                }
                for key in ["result", "resultOffset", "resultChars"] {
                    put(&mut data, key, run.get(key));
                }
                data.insert("nextOffset".to_owned(), next_offset.clone());
                let mut details = Map::new();
                put(&mut details, "id", run.get("id"));
                details.insert("nextOffset".to_owned(), next_offset);
                Ok(typed(
                    format_run_result(&run),
                    Value::Object(data),
                    Some(Value::Object(details)),
                    false,
                ))
            }
            _ => Ok(ToolResult::error(
                "action is one of list, create, update, pause, resume, delete, result",
            )),
        }
    }
}

spec_tool!(ScheduleTool, ptc: false);

struct SchedulesFeature {
    /// The agent, once initialized (`current`).
    current: RefCell<Weak<Agent>>,
}

/// `cronCommand`. `Err` for a failure that is not the gateway's (TS
/// rethrew it; the agent shows it as an error).
async fn cron_command(agent: &Rc<Agent>, args: &str) -> Result<(), String> {
    let gateway = process_gateway().ok_or_else(|| "No gateway".to_owned())?;
    let words: Vec<&str> = js::trim(args)
        .split(js::is_space)
        .filter(|word| !word.is_empty())
        .collect();
    let verb = words.first().copied().unwrap_or("list");
    let id = words.get(1).copied().unwrap_or("");
    let ui = agent.ui();
    let attempt = async {
        if agent.config().mode().full_assistant() {
            let context = gateway
                .gateway
                .request("assistant.context", Map::new(), None)
                .await?;
            agent.set_capabilities(Capabilities::from_value(
                context.get("capabilities").unwrap_or(&Value::Null),
            ));
        }
        if !agent.capabilities().allows("schedules") {
            ui.notify(
                "The schedules capability is disabled for this workspace.",
                NotifyLevel::Error,
            );
            return Ok(Ok(()));
        }
        if verb == "list" {
            let result = gateway
                .gateway
                .request("schedule.list", Map::new(), None)
                .await?;
            let Some(schedules) = result.get("schedules").and_then(Value::as_array).cloned() else {
                return Ok(Err("The schedule list has no schedules".to_owned()));
            };
            return Ok(format_schedules(&schedules, &shown(result.get("timezone")))
                .map(|text| ui.notify(&text, NotifyLevel::Info)));
        }
        if !matches!(verb, "pause" | "resume" | "delete" | "run") {
            ui.notify(HELP, NotifyLevel::Info);
            return Ok(Ok(()));
        }
        if id.is_empty() {
            ui.notify(&format!("Usage: /cron {verb} <id>"), NotifyLevel::Warning);
            return Ok(Ok(()));
        }
        let mut args = Map::new();
        args.insert("id".to_owned(), json!(id));
        let result = gateway
            .gateway
            .request(&format!("schedule.{verb}"), args, None)
            .await?;
        let message = if verb == "run" {
            format!(
                "Started run {} of {id} ({}).",
                shown(result.get("runId")),
                shown(result.get("status"))
            )
        } else if verb == "delete" {
            // The gateway cannot tell this command from the model (L10).
            format!(
                "Confirm deleting “{}” in this chat.",
                shown(result.get("title"))
            )
        } else {
            let done = if verb == "pause" { "Paused" } else { "Resumed" };
            format!("{done} “{}”.", shown(result.get("title")))
        };
        ui.notify(&message, NotifyLevel::Info);
        Ok(Ok(()))
    };
    match attempt.await {
        Ok(outcome) => outcome,
        Err(ChannelError::Coded { code, message, .. }) => {
            ui.notify(
                if unreachable(&code) {
                    "The gateway cannot be reached right now."
                } else {
                    &message
                },
                NotifyLevel::Error,
            );
            Ok(())
        }
        Err(error) => Err(error.message().to_owned()),
    }
}

impl Feature for SchedulesFeature {
    fn name(&self) -> &'static str {
        "schedules"
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        *self.current.borrow_mut() = Rc::downgrade(agent);
        Box::pin(async { Ok(()) })
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        if process_gateway().is_some() && enabled(agent) {
            vec![Rc::new(ScheduleTool::new())]
        } else {
            Vec::new()
        }
    }

    fn commands(&self) -> Vec<FeatureCommand> {
        if process_gateway().is_none() {
            return Vec::new();
        }
        if let Some(agent) = self.current.borrow().upgrade()
            && !enabled(&agent)
        {
            return Vec::new();
        }
        vec![FeatureCommand::new(
            "cron",
            "Scheduled tasks: /cron [list | pause|resume|delete|run <id>]",
        )]
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        _name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move { cron_command(agent, &args).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief() -> Value {
        json!({
            "id": "s1", "title": "CI check", "workspace": "Test on work",
            "when": "cron \"0 9 * * 1-5\" (Asia/Taipei)", "status": "active",
            "nextRun": "2026-09-30 09:00 (Asia/Taipei)", "prompt": "Check the CI dashboard.",
            "lastRun": { "id": "r1", "status": "completed",
                "due": "2026-09-29 09:00 (Asia/Taipei)", "result": "All green." },
        })
    }

    #[test]
    fn formats_the_list() {
        assert_eq!(
            format_schedules(&[], "UTC").unwrap(),
            "No schedules. Default time zone: UTC."
        );
        assert_eq!(
            format_schedules(&[brief()], "Asia/Taipei").unwrap(),
            [
                "Schedules (default time zone Asia/Taipei):",
                "- s1 “CI check” [active] in Test on work: cron \"0 9 * * 1-5\" (Asia/Taipei); next 2026-09-30 09:00 (Asia/Taipei)",
                "  prompt: Check the CI dashboard.",
                "  last run r1 (2026-09-29 09:00 (Asia/Taipei)): completed — All green.",
            ]
            .join("\n")
        );
        let mut long = brief();
        long["lastRun"]["resultChars"] = json!(5000);
        assert!(
            format_schedules(&[long], "UTC")
                .unwrap()
                .contains("All green. [5000 characters; read it with action result id=r1]")
        );
    }

    #[test]
    fn formats_a_run_result_and_how_to_read_on() {
        let run = |extra: Value| {
            let mut run = json!({ "id": "r1", "schedule": "s1", "status": "completed",
                "resultOffset": 0 });
            run.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            format_run_result(&run)
        };
        assert_eq!(
            run(json!({ "result": "ok", "resultChars": 2 })),
            "Run r1 of s1 [completed]:\nok"
        );
        assert_eq!(
            run(json!({ "result": "", "resultChars": 0 })),
            "Run r1 of s1 [completed]: no result."
        );
        assert_eq!(
            run(json!({ "result": "abc", "resultChars": 9, "nextOffset": 3 })),
            "Run r1 of s1 [completed]:\nabc\n[Result characters 0–3 of 9; continue with action result id=r1 offset=3]"
        );
        assert_eq!(
            run(
                json!({ "result": "ghi", "resultOffset": 6, "resultChars": 9,
                "session": "CI" })
            ),
            "Run r1 of s1 [completed] (session “CI”):\nghi\n[Result characters 6–9 of 9; end of result]"
        );
    }

    #[test]
    fn picks_documented_fields() {
        let mut record = brief();
        record["extra"] = json!(1);
        record["nextRun"] = Value::Null;
        record["lastRun"]["secret"] = json!("x");
        let picked = pick(&record, &brief_schema());
        assert_eq!(picked.get("extra"), None);
        assert_eq!(picked.get("nextRun"), None);
        assert_eq!(picked["lastRun"].get("secret"), None);
        assert_eq!(picked["lastRun"]["result"], json!("All green."));
    }
}
