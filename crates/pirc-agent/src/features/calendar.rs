//! The agent's owner-scoped personal calendar tool. The Gateway checks
//! independent user grants on every read and proposal operation.

use serde_json::{Map, Value, json};

use crate::channels::{ChannelError, process_gateway};
use crate::feature::Feature;
use crate::features::web_search::feature_enabled;
use crate::tools::prompts::tool_prompt;
use crate::tools::result_schema::{
    ActionFields, arr, bool_, by_action, int, json as json_schema, nullable, obj, str_,
};
use crate::tools::{Tool, ToolContext, ToolResult, ToolSpec, js, typed};
use crate::{LocalBoxFuture, agent::Agent};
use std::rc::Rc;

pub const CALENDAR_TOOL: &str = "calendar";

/// Personal calendar access is independent of scheduled-agent access.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(CalendarFeature)
}

struct CalendarFeature;

impl Feature for CalendarFeature {
    fn name(&self) -> &'static str {
        "calendar"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        if process_gateway().is_some() && feature_enabled(agent, "calendar") {
            vec![tool()]
        } else {
            Vec::new()
        }
    }
}

pub fn tool() -> Rc<dyn Tool> {
    Rc::new(CalendarTool::new())
}

struct CalendarTool {
    spec: ToolSpec,
}

impl CalendarTool {
    fn new() -> Self {
        let description = tool_prompt(CALENDAR_TOOL, &[]).expect("the calendar description");
        let string = |description: &str| json!({ "type": "string", "description": description });
        let integer = |description: &str| json!({ "type": "integer", "description": description });
        let recurrence = json!({
            "type": "object",
            "properties": {
                "frequency": { "type": "string", "enum": ["daily", "weekly", "monthly", "yearly"] },
                "interval": { "type": "integer", "minimum": 1 },
                "weekdays": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } },
                "until": { "type": ["string", "null"], "description": "Optional final local date" },
                "count": { "type": ["integer", "null"], "minimum": 1 },
            },
            "required": ["frequency", "interval", "weekdays", "until", "count"],
            "additionalProperties": false,
        });
        let spec = json!({
            "type": "object",
            "properties": {
                "title": string("Event title"),
                "description": string("Optional details"),
                "location": string("Optional location"),
                "start": string("Local ISO date-time, or local date for an all-day event"),
                "end": string("Local ISO date-time, or exclusive local date for an all-day event"),
                "timezone": string("IANA time zone for this event"),
                "allDay": { "type": "boolean" },
                "recurrence": { "oneOf": [recurrence, { "type": "null" }] },
                "reminderMinutes": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
            },
            "required": ["title", "start", "end", "timezone"],
            "additionalProperties": false,
        });
        let parameters = json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["query", "get", "propose_create", "propose_update", "propose_delete", "proposal_result"] },
                "id": string("Event ID, or proposal ID for proposal_result"),
                "revision": integer("Revision returned by query or get; required for updates and deletions"),
                "from": string("Inclusive UTC instant or date-time with offset"),
                "to": string("Exclusive UTC instant or date-time with offset"),
                "timezone": string("IANA display time zone for grouping query results"),
                "cursor": string("Opaque pagination cursor returned by the previous query"),
                "spec": spec,
                "scope": { "type": "string", "enum": ["series", "occurrence", "following"], "description": "For repeating events: whole series, this occurrence, or this and following" },
                "occurrence": string("Original local start of the occurrence when scope is occurrence or following"),
            },
            "required": ["action"],
            "additionalProperties": false,
        });
        Self {
            spec: ToolSpec {
                name: CALENDAR_TOOL,
                description,
                parameters: parameters.as_object().expect("object schema").clone(),
                result_schema: Some(result_schema()),
            },
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .map(js::trim)
            .unwrap_or_default();
        let gateway = process_gateway().ok_or_else(|| "No gateway".to_owned())?;
        let (operation, request) = match action {
            "query" => (
                "calendar.query",
                fields(&args, &["from", "to", "timezone", "cursor"]),
            ),
            "get" => {
                if id.is_empty() {
                    return Ok(ToolResult::error("id is required"));
                }
                ("calendar.get", fields(&args, &["id"]))
            }
            "propose_create" => {
                if args.get("spec").is_none() {
                    return Ok(ToolResult::error("spec is required"));
                }
                ("calendar.proposeCreate", fields(&args, &["spec"]))
            }
            "propose_update" => {
                if id.is_empty() {
                    return Ok(ToolResult::error("id is required"));
                }
                if args.get("revision").and_then(Value::as_i64).is_none() {
                    return Ok(ToolResult::error("revision is required"));
                }
                if args.get("spec").is_none() {
                    return Ok(ToolResult::error("spec is required"));
                }
                (
                    "calendar.proposeUpdate",
                    fields(&args, &["id", "revision", "spec", "scope", "occurrence"]),
                )
            }
            "propose_delete" => {
                if id.is_empty() {
                    return Ok(ToolResult::error("id is required"));
                }
                if args.get("revision").and_then(Value::as_i64).is_none() {
                    return Ok(ToolResult::error("revision is required"));
                }
                (
                    "calendar.proposeDelete",
                    fields(&args, &["id", "revision", "scope", "occurrence"]),
                )
            }
            "proposal_result" => {
                if id.is_empty() {
                    return Ok(ToolResult::error("id is required"));
                }
                ("calendar.proposalResult", fields(&args, &["id"]))
            }
            _ => {
                return Ok(ToolResult::error(
                    "action must be query, get, propose_create, propose_update, propose_delete, or proposal_result",
                ));
            }
        };
        let result = match gateway
            .gateway
            .request(operation, request, Some(&ctx.signal))
            .await
        {
            Ok(result) => result,
            Err(error) => return failure(error),
        };
        let text = match action {
            "query" | "get" => pretty(&result),
            "propose_create" | "propose_update" | "propose_delete" => format!(
                "Calendar change proposed ({}) with proposal {}. Nothing is saved until the user approves it in this chat.",
                shown(result.get("operation")),
                shown(result.get("proposalId"))
            ),
            "proposal_result" => describe_result(&result),
            _ => unreachable!(),
        };
        let mut data = Map::new();
        data.insert("action".to_owned(), json!(action));
        let result_fields: &[&str] = match action {
            "query" => &[
                "items",
                "from",
                "to",
                "timezone",
                "limited",
                "nextCursor",
                "historyLimited",
                "dayStart",
            ],
            "get" => &["event", "id", "revision"],
            "propose_create" => &["proposalId", "status", "duplicate"],
            "propose_update" | "propose_delete" => {
                &["proposalId", "status", "eventId", "duplicate"]
            }
            "proposal_result" => &["proposalId", "status", "decision", "eventId", "result"],
            _ => unreachable!(),
        };
        for key in result_fields {
            if let Some(value) = result.get(*key)
                && (!value.is_null() || (*key == "nextCursor" && action == "query"))
            {
                data.insert((*key).to_owned(), value.clone());
            }
        }
        let mut details = Map::new();
        if let Some(value) = result.get("proposalId") {
            details.insert("proposalId".into(), value.clone());
        }
        if let Some(value) = result.get("eventId") {
            details.insert("eventId".into(), value.clone());
        }
        if let Some(value) = result.get("status") {
            details.insert("status".into(), value.clone());
        }
        Ok(typed(
            text,
            Value::Object(data),
            Some(Value::Object(details)),
            false,
        ))
    }
}

fn fields(args: &Map<String, Value>, names: &[&str]) -> Map<String, Value> {
    names
        .iter()
        .filter_map(|name| {
            args.get(*name)
                .map(|value| ((*name).to_owned(), value.clone()))
        })
        .collect()
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "unknown".into(), js::string_of)
}

fn describe_result(result: &Value) -> String {
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match status {
        "pending" => format!(
            "Calendar proposal {} is still waiting for user approval.",
            shown(result.get("proposalId"))
        ),
        "approved" => format!(
            "Calendar proposal was applied to event {}.",
            shown(result.get("eventId"))
        ),
        "rejected" => "The user rejected the calendar proposal; no change was made.".into(),
        "stale" => format!(
            "The calendar proposal is stale and was not applied: {}",
            shown(result.get("result").and_then(|v| v.get("reason")))
        ),
        "expired" => "The calendar proposal expired before approval; no change was made.".into(),
        other => format!("Calendar proposal status: {other}."),
    }
}

fn failure(error: ChannelError) -> Result<ToolResult, String> {
    let ChannelError::Coded { code, message, .. } = error else {
        return Err(error.message().to_owned());
    };
    Ok(ToolResult {
        details: Some(json!({"code": code})),
        ..ToolResult::error(message)
    })
}

fn result_schema() -> Value {
    let action = |name, properties, optional| -> ActionFields<'_> { (name, properties, optional) };
    by_action(vec![
        action(
            "query",
            vec![
                ("items", arr(json_schema(None), None)),
                ("from", int(None)),
                ("to", int(None)),
                ("timezone", str_(None)),
                ("limited", bool_(None)),
                ("nextCursor", nullable(str_(None))),
                ("historyLimited", bool_(None)),
                ("dayStart", str_(None)),
            ],
            &[],
        ),
        action(
            "get",
            vec![
                ("event", json_schema(None)),
                ("id", str_(None)),
                ("revision", int(None)),
            ],
            &[],
        ),
        action(
            "propose_create",
            vec![
                ("proposalId", str_(None)),
                ("status", str_(None)),
                ("duplicate", bool_(None)),
            ],
            &[],
        ),
        action(
            "propose_update",
            vec![
                ("proposalId", str_(None)),
                ("status", str_(None)),
                ("eventId", str_(None)),
                ("duplicate", bool_(None)),
            ],
            &["eventId"],
        ),
        action(
            "propose_delete",
            vec![
                ("proposalId", str_(None)),
                ("status", str_(None)),
                ("eventId", str_(None)),
                ("duplicate", bool_(None)),
            ],
            &["eventId"],
        ),
        action(
            "proposal_result",
            vec![
                ("proposalId", str_(None)),
                ("status", str_(None)),
                ("decision", nullable(str_(None))),
                ("eventId", str_(None)),
                (
                    "result",
                    nullable(obj(
                        vec![
                            ("status", str_(None)),
                            ("eventId", str_(None)),
                            ("revision", int(None)),
                            ("deleted", bool_(None)),
                            ("reason", str_(None)),
                        ],
                        &["status"],
                    )),
                ),
            ],
            &["decision", "eventId", "result"],
        ),
    ])
}

impl Tool for CalendarTool {
    fn name(&self) -> &str {
        self.spec.name
    }
    fn description(&self) -> &str {
        &self.spec.description
    }
    fn parameters(&self) -> &Map<String, Value> {
        &self.spec.parameters
    }
    fn result_schema(&self) -> Option<&Value> {
        self.spec.result_schema.as_ref()
    }
    fn execute<'a>(
        &'a self,
        args: Map<String, Value>,
        ctx: ToolContext,
    ) -> LocalBoxFuture<'a, Result<ToolResult, String>> {
        Box::pin(async move { CalendarTool::run(self, args, ctx).await })
    }
}

#[cfg(test)]
pub(crate) fn registered_tool_name() -> String {
    CalendarTool::new().name().to_owned()
}

#[cfg(test)]
pub(crate) fn registered_tool_names() -> Vec<String> {
    vec![registered_tool_name()]
}
