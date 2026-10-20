//! `assistant` (`agent/features/assistant/`): the chat assistant's tools
//! (`memory_note`, `memory_search`, `delegate`, `delegation_status`) and
//! the code that finds a quote in the user's own messages, so the model
//! never decides where a memory or a request came from.
//!
//! No session runs this feature: the chat node is gone, and the brain of
//! plans/rewrite/02-brain-host.md takes these over (plans/rewrite/06-workers.md
//! for delegation). The gateway refuses its operations until then.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use pirc_protocol::Message;
use serde_json::{Map, Value, json};

use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::channels::{ChannelError, NodeChannels, process_gateway};
use crate::feature::Feature;
pub use crate::origins::{current_origins, find_quote, find_recent_quote};
use crate::redact::redact_secrets;
use crate::session_store::EntryData;
use crate::tools::js::{self, locale_string_en_us};
use crate::tools::prompts::{PromptVar, tool_prompt};
use crate::tools::result_schema::{arr, bool_, fields, int, nullable, obj, str_};
use crate::tools::{Tool, ToolContext, ToolResult, typed};

/// Session entry: the memory frozen into this chat's system prompt, with
/// the revisions it showed.
pub const ASSISTANT_SNAPSHOT: &str = "assistant.snapshot";
pub const NOTE_TOOL: &str = "memory_note";
pub const DELEGATE_TOOL: &str = "delegate";
pub const DELEGATIONS_TOOL: &str = "delegation_status";
pub const SEARCH_TOOL: &str = "memory_search";
const MEMORY_TOOLS: [&str; 1] = [NOTE_TOOL];
/// A delegation's quote must come from the user's last this many messages
/// (auto mode's classifier window; the gateway's `QUOTE_MESSAGES`).
const QUOTE_MESSAGES: usize = 3;
/// Session entry: a note revision this chat wrote (`learn` after a restart).
const NOTE_REVISION: &str = "assistant.note_revision";

/// `number(value)`: `toLocaleString('en-US')`.
fn number(value: Option<&Value>) -> String {
    locale_string_en_us(value.and_then(Value::as_f64).unwrap_or(f64::NAN))
}

/// `String(value)`, `undefined` when absent.
fn string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::string_of)
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

// ---------- the feature ----------

#[derive(Default)]
struct State {
    /// Revision of each entry as this chat last saw it, sent with replace
    /// and remove.
    revisions: RefCell<HashMap<String, Value>>,
}

type Shared = Rc<State>;

/// `learn`: after a restart, the snapshot's revisions, then every write
/// this chat made.
fn learn(state: &State, agent: &Agent) {
    let mut revisions = state.revisions.borrow_mut();
    for entry in agent.branch() {
        match &entry.data {
            EntryData::Custom { custom_type, data } if custom_type == ASSISTANT_SNAPSHOT => {
                if let Some(seen) = data.get("revisions").and_then(Value::as_object) {
                    for (id, revision) in seen {
                        if revision.is_number() {
                            revisions.insert(id.clone(), revision.clone());
                        }
                    }
                }
            }
            EntryData::Custom { custom_type, data } if custom_type == NOTE_REVISION => {
                if let (Some(id), Some(revision)) = (
                    data.get("id").and_then(Value::as_str),
                    data.get("revision").filter(|r| r.is_number()),
                ) {
                    revisions.insert(id.to_owned(), revision.clone());
                }
            }
            EntryData::Message(Message::ToolResult {
                tool_name, details, ..
            }) if tool_name == NOTE_TOOL => {
                let details = details.as_ref();
                if let (Some(id), Some(revision)) = (
                    details.and_then(|d| d.get("id")).and_then(Value::as_str),
                    details
                        .and_then(|d| d.get("revision"))
                        .filter(|r| r.is_number()),
                ) {
                    revisions.insert(id.to_owned(), revision.clone());
                }
            }
            _ => {}
        }
    }
}

fn append_custom(agent: &Agent, custom_type: &str, data: Value) -> Result<(), String> {
    agent
        .append_entry(EntryData::Custom {
            custom_type: custom_type.to_owned(),
            data,
        })
        .map(|_| ())
}

/// `text(value, details, isError)`.
fn text(value: impl Into<String>, details: Option<Value>, is_error: bool) -> ToolResult {
    ToolResult {
        details,
        is_error,
        ..ToolResult::text(value)
    }
}

/// `failure`: a gateway error as the tool's result; other errors throw.
fn failure(error: ChannelError) -> Result<ToolResult, String> {
    let ChannelError::Coded { code, message, .. } = error else {
        return Err(error.message().to_owned());
    };
    let message =
        if ["gateway_offline", "gateway_timeout", "gateway_closed"].contains(&code.as_str()) {
            "Memory is unavailable right now (the gateway cannot be reached); nothing was saved."
                .to_owned()
        } else if code == "forgotten" {
            "The user asked to forget this; do not save it again.".to_owned()
        } else {
            message
        };
    Ok(text(message, Some(json!({ "code": code })), true))
}

/// A string argument, trimmed (`typeof v === 'string' ? v.trim() : ''`).
fn trimmed(args: &Map<String, Value>, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .map(js::trim)
        .unwrap_or_default()
        .to_owned()
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => unreachable!("an object"),
    }
}

/// The documented fields of a gateway delegation record (`delegationData`).
fn delegation_data(delegation: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "title", "workspace", "status"] {
        out.insert(key.to_owned(), json!(string(delegation.get(key))));
    }
    for key in ["role", "model", "thinking", "dispatch", "session", "result"] {
        if let Some(value) = delegation.get(key).filter(|v| v.is_string()) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["resultOffset", "resultChars"] {
        if let Some(value) = delegation.get(key).filter(|v| v.is_number()) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    if delegation.get("resultChars").is_some() {
        let next = delegation.get("nextOffset").cloned().unwrap_or(Value::Null);
        out.insert("nextOffset".to_owned(), next);
    }
    Value::Object(out)
}

/// `a ?? b` of two record fields.
fn either<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    value.filter(|v| !v.is_null()).or(fallback)
}

/// `resultFooter`: where a chunked delegation result stands, and how to
/// read on.
fn result_footer(delegation: &Value) -> String {
    let Some(chars) = delegation.get("resultChars") else {
        return String::new();
    };
    let start = string(either(delegation.get("resultOffset"), Some(&json!(0))));
    let next = delegation.get("nextOffset");
    let end = string(either(next, Some(chars)));
    let chars = js::string_of(chars);
    match next {
        None => format!("\n[Result characters {start}–{end} of {chars}; end of result]"),
        Some(_) => format!(
            "\n[Result characters {start}–{end} of {chars}; continue with delegation_status id={} offset={end}]",
            string(delegation.get("id"))
        ),
    }
}

/// `DELEGATION`.
fn delegation_schema() -> Value {
    obj(
        vec![
            ("id", str_(None)),
            ("title", str_(None)),
            ("workspace", str_(None)),
            ("status", str_(None)),
            ("role", str_(None)),
            ("model", str_(None)),
            ("thinking", str_(None)),
            (
                "dispatch",
                str_(Some(
                    "approved: the user approved it; auto: it started without asking",
                )),
            ),
            ("session", str_(Some("Name of the session doing the work"))),
            ("result", str_(Some("This chunk of the final answer"))),
            ("resultOffset", int(None)),
            ("resultChars", int(None)),
            (
                "nextOffset",
                nullable(int(Some("Where the next chunk starts, or null at the end"))),
            ),
        ],
        &[
            "role",
            "model",
            "thinking",
            "dispatch",
            "session",
            "result",
            "resultOffset",
            "resultChars",
            "nextOffset",
        ],
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Note,
    Delegate,
    Delegations,
    Search,
}

/// One of the assistant's tools.
struct AssistantTool {
    kind: Kind,
    name: &'static str,
    agent: Weak<Agent>,
    state: Shared,
    gateway: Rc<NodeChannels>,
    /// One description, or `memory_search`'s four (a getter in TS: only
    /// mention tools the chat's capability policy allows), by
    /// `recall + 2 × delegation`.
    descriptions: Vec<String>,
    parameters: Map<String, Value>,
    result_schema: Value,
}

fn param(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn action_param() -> Value {
    json!({ "type": "string", "enum": ["add", "replace", "remove"] })
}

impl AssistantTool {
    fn new(kind: Kind, agent: &Rc<Agent>, state: Shared, gateway: Rc<NodeChannels>) -> Self {
        let fixed = |name: &str| vec![tool_prompt(name, &[]).expect("a tool description")];
        let (name, descriptions, parameters, result_schema) = match kind {
            Kind::Note => (
                NOTE_TOOL,
                fixed(NOTE_TOOL),
                json!({
                    "type": "object",
                    "properties": {
                        "action": action_param(),
                        "id": param("The note to replace or remove, like n1a2b3c4d."),
                        "content": param("The note, one self-contained line (add and replace)."),
                        "quote": param("Optional: the user's exact words in this chat that the note rests on. They are checked against the user's messages."),
                    },
                    "required": ["action"],
                    "additionalProperties": false,
                }),
                fields(
                    vec![
                        ("id", str_(Some("The note, like n1a2b3c4d"))),
                        ("revision", int(None)),
                        ("unchanged", bool_(Some("It already said this"))),
                        ("used", int(Some("Characters MEMORY uses now"))),
                        ("max", int(None)),
                    ],
                    &[],
                ),
            ),
            Kind::Delegate => (
                DELEGATE_TOOL,
                fixed(DELEGATE_TOOL),
                json!({
                    "type": "object",
                    "properties": {
                        "workspace": param("The workspace id (like m5pro:workspace_…), or its name if no other workspace has it. Leave it out in a project linked to exactly one workspace to use that one."),
                        "task": param("The whole task, standing on its own."),
                        "title": param("A short title; it names the new session."),
                        "follows": param("An earlier delegation's id (like d1a2b3c4d): send the task to its session instead."),
                        "quote": param("The user's exact words, from one of their last three messages, that asked for this work. They are checked against those messages."),
                        "role": {
                            "type": "string",
                            "pattern": "^[a-z][a-z0-9_-]{0,39}$",
                            "description": "A role of the target workspace (see ## Workspaces); default: none (the workspace default). Not with follows.",
                        },
                    },
                    "required": ["task"],
                    "additionalProperties": false,
                }),
                // Asks the user; nothing runs until they approve it in the chat.
                fields(vec![("delegation", delegation_schema())], &[]),
            ),
            Kind::Delegations => (
                DELEGATIONS_TOOL,
                fixed(DELEGATIONS_TOOL),
                json!({
                    "type": "object",
                    "properties": {
                        "id": param("A delegation id, like d1a2b3c4d."),
                        "offset": {
                            "type": "integer",
                            "minimum": 0,
                            "description": "With id: first result character to return (default 0)",
                        },
                    },
                    "additionalProperties": false,
                }),
                fields(vec![("delegations", arr(delegation_schema(), None))], &[]),
            ),
            Kind::Search => (
                SEARCH_TOOL,
                (0..4)
                    .map(|index| {
                        tool_prompt(
                            SEARCH_TOOL,
                            &[
                                ("recall", PromptVar::Flag(index & 1 == 1)),
                                ("delegation", PromptVar::Flag(index & 2 == 2)),
                            ],
                        )
                        .expect("the memory_search description")
                    })
                    .collect(),
                json!({
                    "type": "object",
                    "properties": {
                        "query": param("Words to look for, separated by spaces."),
                        "workspace": param("Only this workspace and other clones of its repository: its id, or its name if no other workspace has it."),
                        "limit": { "type": "number", "description": "At most this many results (1 to 20, default 8)." },
                        "everywhere": { "type": "boolean", "description": "In a project linked to workspaces: search all workspaces at once instead of the linked ones first (default false)." },
                    },
                    "required": ["query"],
                    "additionalProperties": false,
                }),
                fields(
                    vec![(
                        "hits",
                        arr(
                            obj(
                                vec![
                                    ("id", str_(Some("Recall it with recall({ id })"))),
                                    ("kind", str_(None)),
                                    ("workspace", str_(None)),
                                    ("date", str_(None)),
                                    ("status", str_(None)),
                                    ("git", str_(None)),
                                    ("content", str_(None)),
                                ],
                                &["git"],
                            ),
                            None,
                        ),
                    )],
                    &[],
                ),
            ),
        };
        Self {
            kind,
            name,
            agent: Rc::downgrade(agent),
            state,
            gateway,
            descriptions,
            parameters: object(parameters),
            result_schema,
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let agent = self.agent.upgrade().ok_or("The agent is gone")?;
        match self.kind {
            Kind::Note => self.note(&agent, &args, &ctx).await,
            Kind::Delegate => self.delegate(&agent, &args, &ctx).await,
            Kind::Delegations => self.delegations(&args, &ctx).await,
            Kind::Search => self.search(&args, &ctx).await,
        }
    }

    fn request(
        &self,
        op: &str,
        args: Map<String, Value>,
        ctx: &ToolContext,
    ) -> crate::channels::PendingRequest<Value> {
        self.gateway.gateway.request(op, args, Some(&ctx.signal))
    }

    fn base_revision(&self, id: &str) -> Value {
        match self.state.revisions.borrow().get(id) {
            Some(revision) if !revision.is_null() => revision.clone(),
            _ => Value::Null,
        }
    }

    fn remember(&self, agent: &Agent, id: &Value, revision: &Value) -> Result<(), String> {
        self.state
            .revisions
            .borrow_mut()
            .insert(js::string_of(id), revision.clone());
        // The tool result reaches the session inside a ptc result, without
        // these details: record the revision on its own for a restart.
        append_custom(
            agent,
            NOTE_REVISION,
            json!({ "id": id, "revision": revision }),
        )
    }

    async fn note(
        &self,
        agent: &Agent,
        args: &Map<String, Value>,
        ctx: &ToolContext,
    ) -> Result<ToolResult, String> {
        let action = args.get("action").and_then(Value::as_str).unwrap_or("");
        if !["add", "replace", "remove"].contains(&action) {
            return Ok(text("action must be add, replace or remove", None, true));
        }
        let id = trimmed(args, "id");
        let content = trimmed(args, "content");
        if action != "add" && id.is_empty() {
            return Ok(text(
                "id is required to replace or remove a note",
                None,
                true,
            ));
        }
        if action != "remove" && content.is_empty() {
            return Ok(text(
                "content is required to add or replace a note",
                None,
                true,
            ));
        }
        let branch = agent.branch();
        let mut origins =
            current_origins(&branch, &agent.running_script_capabilities(), &MEMORY_TOOLS);
        let mut entry_ids: Vec<String> = Vec::new();
        let mut quote = None;
        if let Some(raw) = args
            .get("quote")
            .and_then(Value::as_str)
            .filter(|quote| !js::trim(quote).is_empty())
        {
            let Some(found) = find_quote(&branch, raw) else {
                return Ok(text(
                    "That quote is not in the user's messages in this chat. Quote their exact words, or leave quote out.",
                    None,
                    true,
                ));
            };
            entry_ids.push(found);
            if !origins.iter().any(|origin| origin == "user") {
                origins.push("user".to_owned());
            }
            quote = Some(redact_secrets(js::trim(raw)));
        }
        origins.sort_by(|a, b| js::compare16(a, b));
        let mut request = Map::new();
        request.insert("action".to_owned(), json!(action));
        if !id.is_empty() {
            request.insert("id".to_owned(), json!(id));
        }
        if !content.is_empty() {
            request.insert("content".to_owned(), json!(redact_secrets(&content)));
        }
        if action != "add" {
            request.insert("baseRevision".to_owned(), self.base_revision(&id));
        }
        request.insert("origins".to_owned(), json!(origins));
        request.insert("entryIds".to_owned(), json!(entry_ids));
        if let Some(quote) = quote {
            request.insert("quote".to_owned(), json!(quote));
        }
        match self.request("memory.note", request, ctx).await {
            Ok(result) => {
                let (id, revision) = (
                    result.get("id").cloned().unwrap_or(Value::Null),
                    result.get("revision").cloned().unwrap_or(Value::Null),
                );
                self.remember(agent, &id, &revision)?;
                let usage = result.get("usage");
                let used = usage.and_then(|u| u.get("used")).cloned();
                let max = usage.and_then(|u| u.get("max")).cloned();
                let room = format!(
                    "MEMORY now uses {}/{} characters.",
                    number(used.as_ref()),
                    number(max.as_ref())
                );
                let shown = js::string_of(&id);
                let unchanged = result.get("unchanged") == Some(&Value::Bool(true));
                let done = if action == "remove" {
                    format!("Removed note {shown}; the user can restore it in Settings → Memory.")
                } else if js::truthy(result.get("unchanged")) {
                    format!("Note {shown} already says this; nothing changed.")
                } else {
                    format!(
                        "{} note {shown}. New chats will see it.",
                        if action == "add" { "Saved" } else { "Updated" }
                    )
                };
                let mut data = Map::new();
                data.insert("id".to_owned(), id.clone());
                data.insert("revision".to_owned(), revision.clone());
                data.insert("unchanged".to_owned(), json!(unchanged));
                if let Some(used) = used {
                    data.insert("used".to_owned(), used);
                }
                if let Some(max) = max {
                    data.insert("max".to_owned(), max);
                }
                Ok(typed(
                    format!("{done} {room}"),
                    Value::Object(data),
                    Some(json!({ "id": id, "revision": revision })),
                    false,
                ))
            }
            Err(ChannelError::Coded { code, details, .. })
                if code == "conflict"
                    && details.as_deref().is_some_and(|current| {
                        current.get("id").is_some_and(Value::is_string)
                            && current.get("revision").is_some_and(Value::is_number)
                    }) =>
            {
                let current = details.map(|d| *d).unwrap_or_default();
                let (id, revision) = (current["id"].clone(), current["revision"].clone());
                self.remember(agent, &id, &revision)?;
                let content = current
                    .get("content")
                    .map_or_else(|| "undefined".to_owned(), js::stringify);
                Ok(text(
                    format!(
                        "Note {} changed in another chat since you last saw it. It now reads: {content}. If your change still applies, call {NOTE_TOOL} again.",
                        js::string_of(&id)
                    ),
                    Some(json!({ "id": id, "revision": revision })),
                    true,
                ))
            }
            Err(error) => failure(error),
        }
    }

    async fn delegate(
        &self,
        agent: &Agent,
        args: &Map<String, Value>,
        ctx: &ToolContext,
    ) -> Result<ToolResult, String> {
        let task = trimmed(args, "task");
        if task.is_empty() {
            return Ok(text("task is required", None, true));
        }
        let branch = agent.branch();
        // What the chat read since the user's last message decides whether
        // an `untrusted` policy starts it at once. Earlier delegate calls
        // only report what the gateway recorded.
        let origins: Vec<String> =
            current_origins(&branch, &agent.running_script_capabilities(), &MEMORY_TOOLS)
                .into_iter()
                .filter(|origin| *origin != format!("tool:{DELEGATE_TOOL}"))
                .collect();
        let quote = args
            .get("quote")
            .and_then(Value::as_str)
            .map(js::trim)
            .filter(|quote| !quote.is_empty());
        let mut verified = None;
        if let Some(raw) = quote {
            let Some(found) = find_recent_quote(&branch, raw, QUOTE_MESSAGES) else {
                return Ok(text(
                    "That quote is not in the user's last three messages in this chat. Quote their exact words, or leave quote out.",
                    None,
                    true,
                ));
            };
            verified = Some((redact_secrets(raw), found));
        }
        // Without a workspace or follows, the gateway uses the project's only
        // linked workspace, or says to name one.
        let [workspace, title, follows, role] =
            ["workspace", "title", "follows", "role"].map(|key| trimmed(args, key));
        let mut request = Map::new();
        if !workspace.is_empty() {
            request.insert("workspace".to_owned(), json!(workspace));
        }
        request.insert("task".to_owned(), json!(redact_secrets(&task)));
        for (key, value) in [("title", &title), ("follows", &follows), ("role", &role)] {
            if !value.is_empty() {
                request.insert(key.to_owned(), json!(value));
            }
        }
        request.insert("origins".to_owned(), json!(origins));
        if let Some((quote, entry)) = verified {
            request.insert("quote".to_owned(), json!(quote));
            request.insert("entryIds".to_owned(), json!([entry]));
        }
        match self.request("delegation.create", request, ctx).await {
            Ok(result) => {
                let role = result
                    .get("role")
                    .filter(|role| js::truthy(Some(role)))
                    .map(|role| format!(", role {}", js::string_of(role)))
                    .unwrap_or_default();
                let (id, title, workspace) = (
                    string(result.get("id")),
                    string(result.get("title")),
                    string(result.get("workspace")),
                );
                Ok(typed(
                    if result.get("dispatch").and_then(Value::as_str) == Some("auto") {
                        format!(
                            "Started delegation {id} (“{title}”, {workspace}{role}) without asking: the user's delegation approval setting allows it. The user sees it in this chat and can stop it. You will get a message when it finishes, fails or needs them."
                        )
                    } else {
                        format!(
                            "Asked the user to approve delegation {id} (“{title}”, {workspace}{role}). They can pick the model when approving. Nothing runs until they do; you will get a message when it finishes, fails or needs them."
                        )
                    },
                    json!({ "delegation": delegation_data(&result) }),
                    Some(json!({ "delegationId": result.get("id") })),
                    false,
                ))
            }
            Err(error) => failure(error),
        }
    }

    async fn delegations(
        &self,
        args: &Map<String, Value>,
        ctx: &ToolContext,
    ) -> Result<ToolResult, String> {
        let id = trimmed(args, "id");
        let offset = args
            .get("offset")
            .filter(|offset| offset.as_f64().is_some_and(|n| n.fract() == 0.0 && n > 0.0))
            .cloned();
        let mut request = Map::new();
        if !id.is_empty() {
            request.insert("id".to_owned(), json!(id));
            if let Some(offset) = offset {
                request.insert("offset".to_owned(), offset);
            }
        }
        let result = match self.request("delegation.status", request, ctx).await {
            Ok(result) => result,
            Err(error) => return failure(error),
        };
        let listed = array(result.get("delegations"));
        let delegations: Vec<Value> = listed.iter().map(delegation_data).collect();
        if listed.is_empty() {
            return Ok(typed(
                "No delegations yet.",
                json!({ "delegations": delegations }),
                None,
                false,
            ));
        }
        let shown: Vec<String> = listed
            .iter()
            .map(|d| {
                let session = d
                    .get("session")
                    .filter(|s| js::truthy(Some(s)))
                    .map(|s| format!(" (session “{}”)", js::string_of(s)))
                    .unwrap_or_default();
                let result = d
                    .get("result")
                    .filter(|r| js::truthy(Some(r)))
                    .map(|r| format!("\n{}", js::string_of(r)))
                    .unwrap_or_default();
                format!(
                    "{} · {} · “{}” → {}{session}{result}{}",
                    string(d.get("id")),
                    string(d.get("status")),
                    string(d.get("title")),
                    string(d.get("workspace")),
                    result_footer(d)
                )
            })
            .collect();
        let ids: Vec<Value> = listed
            .iter()
            .map(|d| d.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        Ok(ToolResult {
            data: Some(object(json!({ "delegations": delegations }))),
            ..text(
                shown.join("\n\n"),
                Some(json!({ "delegations": ids })),
                false,
            )
        })
    }

    async fn search(
        &self,
        args: &Map<String, Value>,
        ctx: &ToolContext,
    ) -> Result<ToolResult, String> {
        let query = trimmed(args, "query");
        if query.is_empty() {
            return Ok(text("query is required", None, true));
        }
        let workspace = trimmed(args, "workspace");
        let limit = args
            .get("limit")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| n.floor().clamp(1.0, 20.0));
        let mut request = Map::new();
        request.insert("query".to_owned(), json!(query));
        if !workspace.is_empty() {
            request.insert("workspace".to_owned(), json!(workspace));
        }
        if let Some(limit) = limit {
            request.insert("limit".to_owned(), crate::messages::js::number_value(limit));
        }
        if args.get("everywhere") == Some(&Value::Bool(true)) {
            request.insert("everywhere".to_owned(), json!(true));
        }
        let result = match self.request("memory.search", request, ctx).await {
            Ok(result) => result,
            Err(error) => return failure(error),
        };
        let listed = array(result.get("hits"));
        let hits: Vec<Value> = listed
            .iter()
            .map(|hit| {
                let mut out = Map::new();
                for key in ["id", "kind", "workspace", "date", "status"] {
                    out.insert(key.to_owned(), json!(string(hit.get(key))));
                }
                if let Some(git) = hit.get("git").filter(|g| g.is_string()) {
                    out.insert("git".to_owned(), git.clone());
                }
                out.insert("content".to_owned(), json!(string(hit.get("content"))));
                Value::Object(out)
            })
            .collect();
        // In a project with links, the gateway says where it looked.
        let searched = result.get("searched").and_then(Value::as_str);
        if listed.is_empty() {
            return Ok(typed(
                format!(
                    "Nothing found for {}{}.",
                    js::stringify(&json!(query)),
                    if searched == Some("everywhere") {
                        ", in the workspaces linked to this project or any other"
                    } else {
                        ""
                    }
                ),
                json!({ "hits": hits }),
                None,
                false,
            ));
        }
        let shown: Vec<String> = listed
            .iter()
            .map(|hit| {
                let kind = string(hit.get("kind"));
                let status = string(hit.get("status"));
                let workspace = string(hit.get("workspace"));
                let delegation = kind == "delegation";
                let place = if delegation {
                    format!("delegation to {workspace}")
                } else {
                    workspace
                };
                let state = if delegation || status != "active" {
                    format!(" · {status}")
                } else {
                    String::new()
                };
                let git = hit
                    .get("git")
                    .filter(|g| js::truthy(Some(g)))
                    .map(|g| format!(" · {}", js::string_of(g)))
                    .unwrap_or_default();
                format!(
                    "[{}] {place} · {}{git}{state}\n{}",
                    string(hit.get("id")),
                    string(hit.get("date")),
                    string(hit.get("content"))
                )
            })
            .collect();
        let ids: Vec<Value> = listed
            .iter()
            .map(|hit| hit.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        let scope = match searched {
            Some("linked") => {
                "From the workspaces linked to this project and their clones; pass everywhere: true to search all workspaces.\n\n"
            }
            Some("everywhere") => {
                "Nothing in the workspaces linked to this project; these are from all workspaces.\n\n"
            }
            _ => "",
        };
        Ok(ToolResult {
            data: Some(object(json!({ "hits": hits }))),
            ..text(
                format!("{scope}{}", shown.join("\n\n")),
                Some(json!({ "hits": ids })),
                false,
            )
        })
    }
}

impl Tool for AssistantTool {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &str {
        if self.kind != Kind::Search {
            return &self.descriptions[0];
        }
        let (recall, delegation) = self.agent.upgrade().map_or((true, true), |agent| {
            (
                agent.get_tool("recall").is_some(),
                agent.get_tool(DELEGATE_TOOL).is_some(),
            )
        });
        &self.descriptions[usize::from(recall) + 2 * usize::from(delegation)]
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

/// `assistantFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(AssistantFeature {
        state: Rc::new(State::default()),
    })
}

struct AssistantFeature {
    state: Shared,
}

impl Feature for AssistantFeature {
    fn name(&self) -> &'static str {
        "assistant"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        let Some(gateway) = process_gateway() else {
            return Vec::new();
        };
        [Kind::Note, Kind::Delegate, Kind::Delegations, Kind::Search]
            .into_iter()
            .map(|kind| {
                Rc::new(AssistantTool::new(
                    kind,
                    agent,
                    self.state.clone(),
                    gateway.clone(),
                )) as Rc<dyn Tool>
            })
            .collect()
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        if process_gateway().is_some() {
            learn(&self.state, agent);
        }
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
pub(crate) fn registered_tool_names(agent: &Rc<Agent>) -> Vec<String> {
    let gateway = crate::channels::node_channels();
    let state = Rc::new(State::default());
    [Kind::Note, Kind::Delegate, Kind::Delegations, Kind::Search]
        .into_iter()
        .map(|kind| {
            AssistantTool::new(kind, agent, state.clone(), gateway.clone())
                .name()
                .to_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests;
