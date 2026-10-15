//! Delegation (`apps/gateway/src/daemon/delegations.ts`, docs/history/assistant.md):
//! the assistant in a chat hands a task to a new session in one of the
//! user's directory workspaces, or more instructions to a session it
//! started before. The user approves each one in the chat, where it shows
//! as a confirmation. Then the gateway creates and names the session on the
//! target node, delivers the task as a custom message (never as the user's
//! words), follows the session, and tells the chat when the task finishes,
//! fails or needs the user. Also its agent operations (`delegation.create`,
//! `delegation.status` in `agent-ops.ts`) and the push it sends (`announce`
//! in `daemon/app.ts`).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, ToSql, params};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::db::{Capability, Session, Store, Workspace, WorkspaceKind};
use crate::dispatch::{
    Progress, clip, deliver, is_watched_event, one_line, read_progress, redact_secrets,
    resolve_directory_workspace, start_session, workspace_online,
};
use crate::error::{ApiError, ApiResult};
use crate::events::GatewayEvent;
use crate::push::PushMessage;
use crate::util::{hex, now_ms, random_bytes};

pub const TASK_MAX_CHARS: usize = 20_000;
const TITLE_MAX_CHARS: usize = 80;
/// Stored in full up to this sanity cap; readers page through it.
const RESULT_MAX_CHARS: usize = 200_000;
/// How much of the result the chat's update message carries.
const RESULT_NOTICE_CHARS: usize = 4000;
/// One `delegation_status` read of a result.
pub const RESULT_CHUNK_CHARS: usize = 12_000;
const PENDING_MAX: usize = 10;
/// The chat hears about these; the user already sees an approval happen.
const NOTIFIED: &[&str] = &[
    "rejected",
    "expired",
    "waiting_input",
    "completed",
    "failed",
];
/// `THINKING_LEVELS` (`daemon/schedules.ts`).
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// How long after a watched event the delegated session is read.
const CHECK_DELAY: Duration = Duration::from_millis(150);

fn next_step(status: &str) -> Option<&'static str> {
    Some(match status {
        "completed" => "It finished: tell the user what came of it.",
        "failed" => "It failed: tell the user why.",
        "waiting_input" => {
            "The delegated session is waiting for the user: ask them to open it and answer there."
        }
        "rejected" => "The user declined it: do not ask again unless they want it.",
        "expired" => "Nobody approved it in time: ask again only if it is still wanted.",
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

impl ModelRef {
    fn json(&self) -> Value {
        json!({ "provider": self.provider, "id": self.id })
    }

    fn label(&self) -> String {
        format!("{}/{}", self.provider, self.id)
    }
}

/// A delegation row.
#[derive(Clone, Debug)]
pub struct Delegation {
    pub id: String,
    pub owner_user: String,
    /// The chat that asked (gateway session id).
    pub assistant_session_id: String,
    pub workspace_id: String,
    pub title: String,
    pub task: String,
    /// The earlier delegation whose session gets this task.
    pub follows: Option<String>,
    /// The role its new session starts in; picked by the assistant.
    pub role: Option<String>,
    /// Run it on this model; only the user picks it.
    pub model: Option<ModelRef>,
    pub thinking: Option<String>,
    pub status: String,
    /// The delegated session (gateway session id), once dispatched.
    pub target_session_id: Option<String>,
    /// The delegated agent's final answer, or why it failed.
    pub result: Option<String>,
    /// The last status the chat was told about.
    pub notified_status: Option<String>,
    /// Until when the user can approve it.
    pub expires_at: i64,
    pub dispatched_at: Option<i64>,
    pub created_at: i64,
}

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Delegation> {
    let model_json: Option<String> = row.get("model_json")?;
    let model = model_json
        .filter(|text| !text.is_empty())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            Some(ModelRef {
                provider: value.get("provider")?.as_str()?.to_owned(),
                id: value.get("id")?.as_str()?.to_owned(),
            })
        });
    Ok(Delegation {
        id: row.get("id")?,
        owner_user: row.get("owner_user")?,
        assistant_session_id: row.get("assistant_session_id")?,
        workspace_id: row.get("workspace_id")?,
        title: row.get("title")?,
        task: row.get("task")?,
        follows: row.get("follows")?,
        role: row.get("role")?,
        model,
        thinking: row.get("thinking")?,
        status: row.get("status")?,
        target_session_id: row.get("target_session_id")?,
        result: row.get("result")?,
        notified_status: row.get("notified_status")?,
        expires_at: row.get("expires_at")?,
        dispatched_at: row.get("dispatched_at")?,
        created_at: row.get("created_at")?,
    })
}

// ---------- strings as JavaScript sees them ----------

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` in UTF-16 units.
fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    if text.is_ascii() {
        let end = end.min(text.len());
        return text[start.min(end)..end].to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start.min(end)..end])
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(pirc_config::js_space)
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < 1e21 => {
                format!("{}", float as i64)
            }
            _ => number.to_string(),
        },
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

// ---------- per-gateway state ----------

/// What the TS `Delegations` instance kept in memory.
#[derive(Default)]
struct Shared {
    /// Delegations with a check pending.
    scheduled: Mutex<HashSet<String>>,
    /// `id:status` pairs being reported, so one status is never pushed twice at once.
    reporting: Mutex<HashSet<String>>,
}

fn shared(app: &App) -> Arc<Shared> {
    app.slots.get_or_init(Shared::default)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------- reading ----------

fn row(conn: &Connection, id: &str) -> ApiResult<Option<Delegation>> {
    Ok(conn
        .query_row("SELECT * FROM delegations WHERE id=?", [id], row_of)
        .optional()?)
}

fn rows(conn: &Connection, condition: &str, values: &[&dyn ToSql]) -> ApiResult<Vec<Delegation>> {
    let mut statement = conn.prepare(&format!(
        "SELECT * FROM delegations WHERE {condition} ORDER BY created_at"
    ))?;
    let found = statement.query_map(values, row_of)?;
    Ok(found.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, user: &str, id: &str) -> ApiResult<Delegation> {
    match row(conn, id)? {
        Some(delegation) if delegation.owner_user == user => Ok(delegation),
        _ => Err(ApiError::not_found(format!("No delegation {id}"))),
    }
}

/// Newest first.
fn list(conn: &Connection, user: &str, limit: usize) -> ApiResult<Vec<Delegation>> {
    let mut all = rows(conn, "owner_user=?", &[&user])?;
    all.reverse();
    all.truncate(limit);
    Ok(all)
}

fn label(conn: &Connection, workspace_id: &str) -> String {
    match conn.get_workspace(workspace_id) {
        Ok(workspace) => format!("{} on {}", workspace.display_name, workspace.host_id),
        Err(_) => workspace_id.to_owned(),
    }
}

fn session_name(conn: &Connection, session_id: &str) -> String {
    conn.get_session(session_id)
        .map_or_else(|_| session_id.to_owned(), |session| session.name)
}

/// What the assistant sees of a delegation. `full` returns the result from
/// `offset` in chunks, with `nextOffset` until the end.
fn brief(conn: &Connection, delegation: &Delegation, full: bool, offset: u64) -> ApiResult<Value> {
    let result = delegation.result.as_deref();
    let length = result.map_or(0, utf16_len);
    if full && result.is_some() && offset > length as u64 {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("offset exceeds result length {length}"),
        ));
    }
    let offset = offset as usize;
    let end = if result.is_none() {
        0
    } else {
        length.min(offset.saturating_add(RESULT_CHUNK_CHARS))
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(delegation.id));
    out.insert("title".into(), json!(delegation.title));
    out.insert(
        "workspace".into(),
        json!(label(conn, &delegation.workspace_id)),
    );
    out.insert("status".into(), json!(delegation.status));
    if let Some(follows) = delegation.follows.as_deref().filter(|f| !f.is_empty()) {
        out.insert("follows".into(), json!(follows));
    }
    if let Some(role) = delegation.role.as_deref().filter(|r| !r.is_empty()) {
        out.insert("role".into(), json!(role));
    }
    if let Some(model) = &delegation.model {
        out.insert("model".into(), json!(model.label()));
    }
    if let Some(thinking) = delegation.thinking.as_deref().filter(|t| !t.is_empty()) {
        out.insert("thinking".into(), json!(thinking));
    }
    if let Some(target) = delegation
        .target_session_id
        .as_deref()
        .filter(|t| !t.is_empty())
    {
        out.insert("session".into(), json!(session_name(conn, target)));
    }
    if let Some(result) = result.filter(|r| !r.is_empty()) {
        if full {
            out.insert("result".into(), json!(utf16_slice(result, offset, end)));
            if offset != 0 || end < length {
                out.insert("resultOffset".into(), json!(offset));
                out.insert("resultChars".into(), json!(length));
            }
            if end < length {
                out.insert("nextOffset".into(), json!(end));
            }
        } else {
            out.insert("result".into(), json!(clip(result, 600)));
        }
    }
    out.insert("createdAt".into(), json!(delegation.created_at));
    Ok(Value::Object(out))
}

/// The directory workspaces the assistant can delegate to
/// (`Delegations.workspaces`), and whether their node is online now.
pub fn workspaces(app: &App) -> ApiResult<Value> {
    let all = app.db.lock().list_workspaces()?;
    let listed: Vec<Value> = all
        .iter()
        .filter(|workspace| {
            workspace.kind == WorkspaceKind::Directory && workspace.id.contains(':')
        })
        .map(|workspace| {
            let mut item = Map::new();
            item.insert("id".into(), json!(workspace.id));
            item.insert("name".into(), json!(workspace.display_name));
            item.insert("node".into(), json!(workspace.host_id));
            item.insert("online".into(), json!(workspace_online(app, workspace)));
            if let Some(repo) = &workspace.repo {
                item.insert("repo".into(), json!(repo));
            }
            if let Some(roles) = roles(app, workspace) {
                item.insert("roles".into(), json!(roles));
            }
            Value::Object(item)
        })
        .collect();
    Ok(Value::Array(listed))
}

/// The roles a workspace's node reported when it connected; `None` when unknown.
fn roles(app: &App, workspace: &Workspace) -> Option<Vec<pirc_protocol::WorkspaceRole>> {
    app.nodes
        .get(&workspace.host_id)?
        .workspaces
        .into_iter()
        .find_map(|registered| {
            (format!("{}:{}", workspace.host_id, registered.id) == workspace.id)
                .then_some(registered.roles)
                .flatten()
        })
}

/// Delegations of this assistant session waiting for the user's approval,
/// as interactions (`pendingInteractions`).
pub fn pending_interactions(app: &App, session_id: &str) -> Vec<Value> {
    let conn = app.db.lock();
    let pending = rows(
        &conn,
        "assistant_session_id=? AND status='pending_approval' AND expires_at>?",
        &[&session_id, &now_ms()],
    );
    match pending {
        Ok(pending) => pending
            .iter()
            .map(|delegation| interaction_of(&conn, delegation))
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn interaction_of(conn: &Connection, delegation: &Delegation) -> Value {
    let place = label(conn, &delegation.workspace_id);
    let followed = delegation
        .follows
        .as_deref()
        .and_then(|id| row(conn, id).ok().flatten());
    let session = followed
        .and_then(|followed| followed.target_session_id)
        .filter(|target| !target.is_empty())
        .map(|target| session_name(conn, &target))
        .unwrap_or_default();
    let title = if session.is_empty() {
        format!(
            "Delegate to {place}{}?",
            delegation
                .role
                .as_deref()
                .filter(|role| !role.is_empty())
                .map(|role| format!(" as {role}"))
                .unwrap_or_default()
        )
    } else {
        format!("Send more instructions to “{session}” ({place})?")
    };
    json!({
        "id": delegation.id,
        "rpcId": delegation.id,
        "sessionId": delegation.assistant_session_id,
        "runnerEpoch": 0,
        "kind": "confirm",
        "status": "pending",
        "request": {
            "method": "confirm",
            "title": title,
            "message": format!("{}\n\n{}", delegation.title, delegation.task),
            "confirmLabel": "Delegate",
            "cancelLabel": "Don't",
            // Clients that know it offer a model picker; null is the workspace default.
            "modelChoice": {
                "model": delegation.model.as_ref().map(ModelRef::json),
                "thinking": delegation.thinking,
            },
        },
        "expiresAt": delegation.expires_at,
        "createdAt": delegation.created_at,
    })
}

// ---------- the assistant ----------

/// `delegation.create`'s arguments.
pub struct CreateArgs {
    workspace: Option<String>,
    task: String,
    title: Option<String>,
    follows: Option<String>,
    role: Option<String>,
}

fn new_id(conn: &Connection) -> ApiResult<String> {
    loop {
        let id = format!("d{}", hex(&random_bytes::<4>()));
        if row(conn, &id)?.is_none() {
            return Ok(id);
        }
    }
}

/// Record a delegation and ask the user in the chat; nothing runs before they approve.
fn create(app: &App, user: &str, assistant: &Session, input: CreateArgs) -> ApiResult<Delegation> {
    app.db
        .lock()
        .require_session_capability(&assistant.id, Capability::Delegation)?;
    let task = js_trim(&redact_secrets(&input.task)).to_owned();
    if task.is_empty() {
        return Err(ApiError::new(400, "invalid_input", "task is required"));
    }
    if utf16_len(&task) > TASK_MAX_CHARS {
        return Err(ApiError::new(
            413,
            "payload_too_large",
            format!("A task holds at most {TASK_MAX_CHARS} characters"),
        ));
    }
    let role = input
        .role
        .as_deref()
        .map(js_trim)
        .filter(|role| !role.is_empty())
        .map(str::to_owned);
    if role.is_some() && input.follows.is_some() {
        return Err(ApiError::new(
            400,
            "invalid_input",
            "A follow-up runs in the role its session started in; leave role out",
        ));
    }
    let (workspace, previous) = if let Some(follows) = &input.follows {
        let conn = app.db.lock();
        let previous = get(&conn, user, follows)?;
        if previous
            .target_session_id
            .as_deref()
            .is_none_or(str::is_empty)
            || !["running", "waiting_input", "completed", "failed"]
                .contains(&previous.status.as_str())
        {
            return Err(ApiError::new(
                409,
                "conflict",
                format!("Delegation {} has no session to continue", previous.id),
            ));
        }
        (conn.get_workspace(&previous.workspace_id)?, Some(previous))
    } else {
        let reference = input.workspace.as_deref().map(js_trim).unwrap_or_default();
        if reference.is_empty() {
            return Err(ApiError::new(
                400,
                "invalid_input",
                "Name a workspace, or an earlier delegation to follow up",
            ));
        }
        (resolve_directory_workspace(app, reference)?, None)
    };
    if !workspace_online(app, &workspace) {
        return Err(ApiError::new(
            503,
            "node_offline",
            format!(
                "{} is offline; delegate when it is back, or pick another workspace",
                workspace.host_id
            ),
        ));
    }
    if let Some(role) = &role {
        // Unknown roles (an older node) are checked by the agent when it starts.
        if let Some(known) = roles(app, &workspace)
            && !known.iter().any(|item| &item.name == role)
        {
            return Err(ApiError::new(
                400,
                "invalid_input",
                format!(
                    "No role {role} in {}; roles: {}",
                    workspace.display_name,
                    known
                        .iter()
                        .map(|item| item.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    }
    let delegation = {
        let conn = app.db.lock();
        let waiting = rows(
            &conn,
            "owner_user=? AND status='pending_approval'",
            &[&user],
        )?
        .len();
        if waiting >= PENDING_MAX {
            return Err(ApiError::new(
                429,
                "too_many_requests",
                format!("{waiting} delegations already wait for the user's approval"),
            ));
        }
        let given = input.title.as_deref().map(js_trim).unwrap_or_default();
        let first_line = task.split('\n').next().unwrap_or_default();
        let title = clip(
            &one_line(if !given.is_empty() {
                given
            } else if let Some(previous) = previous.as_ref().filter(|p| !p.title.is_empty()) {
                &previous.title
            } else {
                first_line
            }),
            TITLE_MAX_CHARS,
        );
        let id = new_id(&conn)?;
        let at = now_ms();
        conn.execute(
            "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,follows,role,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending_approval',?,?,?)",
            params![
                id,
                user,
                assistant.id,
                workspace.id,
                title,
                task,
                previous.as_ref().map(|p| p.id.clone()),
                role,
                at.saturating_add(i64::try_from(app.config.delegation_ttl_ms).unwrap_or(i64::MAX)),
                at,
                at
            ],
        )?;
        row(&conn, &id)?.ok_or_else(ApiError::internal)?
    };
    let interaction = interaction_of(&app.db.lock(), &delegation);
    app.events.publish(
        &assistant.id,
        assistant.runner_epoch,
        "interaction_created",
        interaction,
    );
    Ok(delegation)
}

// ---------- the user ----------

/// A model the user picked: `{provider,id}`, `provider/id`, or null/'' for the default.
fn model_of(value: &Value) -> ApiResult<Option<ModelRef>> {
    match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.is_empty() => return Ok(None),
        Value::String(text) => {
            if let Some(slash) = text.find('/')
                && slash > 0
                && slash < text.len() - 1
            {
                return Ok(Some(ModelRef {
                    provider: text[..slash].to_owned(),
                    id: text[slash + 1..].to_owned(),
                }));
            }
        }
        Value::Object(object) => {
            if let (Some(Value::String(provider)), Some(Value::String(id))) =
                (object.get("provider"), object.get("id"))
            {
                return Ok(Some(ModelRef {
                    provider: provider.clone(),
                    id: id.clone(),
                }));
            }
        }
        _ => {}
    }
    Err(ApiError::new(
        400,
        "invalid_input",
        "model is provider/model-id",
    ))
}

fn check_model(app: &App, model: Option<ModelRef>) -> ApiResult<Option<ModelRef>> {
    if let Some(model) = &model {
        let known = app
            .models()
            .providers
            .get(&model.provider)
            .is_some_and(|provider| provider.models.iter().any(|m| m.id == model.id));
        if !known {
            return Err(ApiError::new(
                400,
                "invalid_input",
                format!("Unknown model {}", model.label()),
            ));
        }
    }
    Ok(model)
}

fn check_thinking(thinking: Option<String>) -> ApiResult<Option<String>> {
    if let Some(level) = &thinking
        && !THINKING_LEVELS.contains(&level.as_str())
    {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("thinking is one of {}", THINKING_LEVELS.join(", ")),
        ));
    }
    Ok(thinking)
}

/// The user answered a confirmation in the chat `session_id`. `None` when
/// `interaction_id` is not a delegation of that chat, so the caller
/// forwards the answer to the node as usual. An approval may pick the model
/// and thinking level (`model`: `{provider,id}`, `provider/id`, or null for
/// the default), replacing what was there.
pub fn answer(
    app: &AppState,
    session_id: &str,
    interaction_id: &str,
    user: &str,
    answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    let Some(delegation) = row(&app.db.lock(), interaction_id)? else {
        return Ok(None);
    };
    if delegation.assistant_session_id != session_id {
        return Ok(None);
    }
    if delegation.owner_user != user {
        return Err(ApiError::new(
            403,
            "forbidden",
            "Delegation belongs to another user",
        ));
    }
    // `answer ?? {}`: a property of anything else is undefined.
    let reply = answer.filter(|value| !value.is_null());
    let field = |name: &str| reply.and_then(|value| value.get(name));
    let approved = field("confirmed") == Some(&Value::Bool(true));
    let mut model = delegation.model.clone();
    let mut thinking = delegation.thinking.clone();
    if approved {
        app.db
            .lock()
            .require_session_capability(session_id, Capability::Delegation)?;
        if let Some(value) = field("model") {
            model = check_model(app, model_of(value)?)?;
        }
        if let Some(value) = field("thinking") {
            thinking = check_thinking(match value {
                Value::Null => None,
                Value::String(text) if text.is_empty() => None,
                other => Some(js_string(other)),
            })?;
        }
    }
    let changed = {
        let at = now_ms();
        app.db.lock().execute(
            "UPDATE delegations SET status=?, model_json=?, thinking=?, updated_at=? WHERE id=? AND status='pending_approval' AND expires_at>?",
            params![
                if approved { "running" } else { "rejected" },
                model.as_ref().map(|model| model.json().to_string()),
                thinking,
                at,
                delegation.id,
                at
            ],
        )?
    };
    if changed == 0 {
        return Err(ApiError::new(
            409,
            "stale_interaction",
            "This delegation can no longer be answered",
        ));
    }
    publish_answered(app, &delegation);
    let id = delegation.id.clone();
    let background = app.clone();
    if approved {
        tokio::spawn(async move { dispatch(&background, &id).await });
    } else {
        tokio::spawn(async move { report(&background, &id).await });
    }
    Ok(Some(
        json!({ "interactionId": delegation.id, "status": "answered" }),
    ))
}

/// Lapse approvals nobody gave in time.
fn sweep(app: &AppState) {
    let expired = match rows(
        &app.db.lock(),
        "status='pending_approval' AND expires_at<=?",
        &[&now_ms()],
    ) {
        Ok(expired) => expired,
        Err(_) => return,
    };
    for delegation in expired {
        let changed = app.db.lock().execute(
            "UPDATE delegations SET status='expired', updated_at=? WHERE id=? AND status='pending_approval'",
            params![now_ms(), delegation.id],
        );
        if !matches!(changed, Ok(1..)) {
            continue;
        }
        publish_answered(app, &delegation);
        let background = app.clone();
        tokio::spawn(async move { report(&background, &delegation.id).await });
    }
}

// ---------- running it ----------

fn task_message(delegation: &Delegation) -> String {
    format!(
        "Task from the user's assistant, approved by the user (delegation {}):\n\n{}\n\nWork on it here. When you are done, end with a short summary of what you did and anything left over: the assistant receives your final message.",
        delegation.id, delegation.task
    )
}

async fn dispatch(app: &AppState, id: &str) {
    let delegation = match row(&app.db.lock(), id) {
        Ok(Some(delegation)) if delegation.status == "running" => delegation,
        _ => return,
    };
    if let Err(message) = start_task(app, &delegation).await {
        finish(
            app,
            &delegation.id,
            "failed",
            &format!("Could not start the task: {message}"),
        );
    }
}

/// Create (or find) the session and deliver the task; the error's message.
async fn start_task(app: &AppState, delegation: &Delegation) -> Result<(), String> {
    let message = |error: ApiError| error.message;
    let workspace = {
        let conn = app.db.lock();
        conn.require_session_capability(&delegation.assistant_session_id, Capability::Delegation)
            .map_err(message)?;
        conn.get_workspace(&delegation.workspace_id)
            .map_err(message)?
    };
    let node_id = workspace.host_id.clone();
    if !workspace_online(app, &workspace) {
        return Err(format!("{node_id} is offline"));
    }
    let previous = match &delegation.follows {
        Some(follows) => row(&app.db.lock(), follows).map_err(message)?,
        None => None,
    };
    let previous_target = previous
        .as_ref()
        .and_then(|previous| previous.target_session_id.clone())
        .filter(|target| !target.is_empty());
    let target = if let Some(previous_target) = previous_target {
        let target = app
            .db
            .lock()
            .get_session(&previous_target)
            .map_err(message)?;
        if target.owner_user.as_deref() != Some(delegation.owner_user.as_str()) {
            return Err("The session to follow up belongs to another user".into());
        }
        target
    } else {
        start_session(app, &workspace, &delegation.owner_user, &delegation.title)
            .await
            .map_err(|failure| failure.0)?
    };
    {
        let conn = app.db.lock();
        let at = now_ms();
        conn.execute(
            "UPDATE delegations SET target_session_id=?, dispatched_at=?, updated_at=? WHERE id=?",
            params![target.id, at, at, delegation.id],
        )
        .map_err(|error| ApiError::from(error).message)?;
        conn.require_session_capability(&delegation.assistant_session_id, Capability::Delegation)
            .map_err(message)?;
    }
    let mut task = Map::new();
    task.insert("customType".into(), json!("assistant-delegation"));
    task.insert("content".into(), json!(task_message(delegation)));
    task.insert(
        "details".into(),
        json!({ "delegationId": delegation.id, "title": delegation.title }),
    );
    if let Some(role) = delegation.role.as_deref().filter(|role| !role.is_empty())
        && previous.is_none()
    {
        task.insert("role".into(), json!(role));
    }
    if let Some(model) = &delegation.model {
        task.insert("model".into(), model.json());
    }
    if let Some(thinking) = delegation.thinking.as_deref().filter(|t| !t.is_empty()) {
        task.insert("thinking".into(), json!(thinking));
    }
    deliver(app, &target, &delegation.owner_user, Value::Object(task))
        .await
        .map_err(|failure| failure.0)
}

/// An event of some session (`onEvent`); runs outside the hub's lock.
fn on_event(app: &AppState, event: &GatewayEvent) {
    let (followed, chats) = {
        let conn = app.db.lock();
        let followed = rows(
            &conn,
            "target_session_id=? AND status IN ('running','waiting_input')",
            &[&event.session_id],
        )
        .unwrap_or_default();
        let chats = if event.kind == "node_reconnected" {
            rows(&conn, "assistant_session_id=?", &[&event.session_id]).unwrap_or_default()
        } else {
            Vec::new()
        };
        (followed, chats)
    };
    for delegation in followed {
        schedule(app, delegation.id);
    }
    // The chat's node is back: tell it what it missed.
    for delegation in chats {
        if NOTIFIED.contains(&delegation.status.as_str())
            && delegation.notified_status.as_deref() != Some(delegation.status.as_str())
        {
            let background = app.clone();
            tokio::spawn(async move {
                tokio::time::sleep(CHECK_DELAY).await;
                report(&background, &delegation.id).await;
            });
        }
    }
}

fn schedule(app: &AppState, id: String) {
    if !lock(&shared(app).scheduled).insert(id.clone()) {
        return;
    }
    let background = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(CHECK_DELAY).await;
        lock(&shared(&background).scheduled).remove(&id);
        if let Err(error) = check(&background, &id).await {
            crate::log::warn(&format!("delegation {id}: check failed: {error}"));
        }
    });
}

/// Read the delegated session: waiting for the user, still working, or
/// done, in which case the last answer after the task is the result.
async fn check(app: &AppState, id: &str) -> Result<(), String> {
    let (delegation, target) = {
        let conn = app.db.lock();
        let Some(delegation) = row(&conn, id).map_err(|error| error.message)? else {
            return Ok(());
        };
        let Some(target_id) = delegation
            .target_session_id
            .clone()
            .filter(|t| !t.is_empty())
        else {
            return Ok(());
        };
        if !["running", "waiting_input"].contains(&delegation.status.as_str())
            || delegation.dispatched_at.is_none()
        {
            return Ok(());
        }
        let target = conn
            .get_session(&target_id)
            .map_err(|error| error.message)?;
        (delegation, target)
    };
    let progress = read_progress(
        app,
        &target,
        &delegation.owner_user,
        delegation.dispatched_at.unwrap_or_default(),
        |message| {
            message
                .get("details")
                .and_then(|details| details.get("delegationId"))
                .and_then(Value::as_str)
                == Some(delegation.id.as_str())
        },
    )
    .await
    .map_err(|failure| failure.0)?;
    match progress {
        Progress::Dropped => finish(
            app,
            id,
            "failed",
            "The agent stopped before it took the task",
        ),
        Progress::Waiting => {
            if delegation.status == "waiting_input" {
                return Ok(());
            }
            update(app, id, "waiting_input", false);
            announce(app, id);
            let background = app.clone();
            let id = id.to_owned();
            tokio::spawn(async move { report(&background, &id).await });
        }
        Progress::Working => {
            // Answered: back to work, and a later wait is reported again.
            if delegation.status == "waiting_input" {
                update(app, id, "running", true);
            }
        }
        Progress::Over {
            status,
            failure_reason,
            answer,
        } => {
            if status == "succeeded" {
                let result = if answer.is_empty() {
                    "(no final answer)"
                } else {
                    &answer
                };
                finish(app, id, "completed", result);
            } else {
                let reason = failure_reason
                    .filter(|reason| !reason.is_empty())
                    .map(|reason| format!(": {reason}"))
                    .unwrap_or_default();
                let last = if answer.is_empty() {
                    String::new()
                } else {
                    format!("\n\nLast answer: {answer}")
                };
                finish(
                    app,
                    id,
                    "failed",
                    &format!("The run {status}{reason}{last}"),
                );
            }
        }
        Progress::Unknown | Progress::Queued => {}
    }
    Ok(())
}

fn update(app: &App, id: &str, status: &str, forget_report: bool) {
    let sql = format!(
        "UPDATE delegations SET status=?, updated_at=?{} WHERE id=?",
        if forget_report {
            ", notified_status=NULL"
        } else {
            ""
        }
    );
    if let Err(error) = app.db.lock().execute(&sql, params![status, now_ms(), id]) {
        crate::log::warn(&format!("delegation {id}: {error}"));
    }
}

fn finish(app: &AppState, id: &str, status: &str, result: &str) {
    let changed = app.db.lock().execute(
        "UPDATE delegations SET status=?, result=?, updated_at=? WHERE id=? AND status IN ('running','waiting_input')",
        params![status, clip(&redact_secrets(result), RESULT_MAX_CHARS), now_ms(), id],
    );
    if !matches!(changed, Ok(1..)) {
        return;
    }
    announce(app, id);
    let background = app.clone();
    let id = id.to_owned();
    tokio::spawn(async move { report(&background, &id).await });
}

/// Tell the chat that asked; retried when its node comes back.
async fn report(app: &AppState, id: &str) {
    let (delegation, chat, content) = {
        let conn = app.db.lock();
        let Ok(Some(delegation)) = row(&conn, id) else {
            return;
        };
        if !NOTIFIED.contains(&delegation.status.as_str())
            || delegation.notified_status.as_deref() == Some(delegation.status.as_str())
        {
            return;
        }
        let Ok(chat) = conn.get_session(&delegation.assistant_session_id) else {
            return;
        };
        let content = update_message(&conn, &delegation);
        (delegation, chat, content)
    };
    let key = format!("{}:{}", delegation.id, delegation.status);
    if lock(&shared(app).reporting).contains(&key) {
        return;
    }
    let reachable = match (&chat.node_id, &chat.pi_session_id) {
        (Some(node_id), Some(remote)) if !node_id.is_empty() && !remote.is_empty() => {
            app.nodes.get(node_id).is_some()
        }
        _ => false,
    };
    if !reachable {
        return;
    }
    // Check and claim in one step: reports run on several threads at once.
    if !lock(&shared(app).reporting).insert(key.clone()) {
        return;
    }
    /// Releases the claim however the report ends (`finally`).
    struct Claim(Arc<Shared>, String);
    impl Drop for Claim {
        fn drop(&mut self) {
            lock(&self.0.reporting).remove(&self.1);
        }
    }
    let _claim = Claim(shared(app), key);
    let delivered = deliver(
        app,
        &chat,
        &delegation.owner_user,
        json!({
            "customType": "assistant-delegation-update",
            "content": content,
            "details": { "delegationId": delegation.id, "status": delegation.status },
        }),
    )
    .await;
    match delivered {
        Ok(()) => {
            if let Err(error) = app.db.lock().execute(
                "UPDATE delegations SET notified_status=? WHERE id=? AND status=?",
                params![delegation.status, delegation.id, delegation.status],
            ) {
                crate::log::warn(&format!("delegation {}: {error}", delegation.id));
            }
        }
        Err(failure) => crate::log::warn(&format!(
            "delegation {}: could not tell the chat: {}",
            delegation.id, failure.0
        )),
    }
}

// ---------- helpers ----------

/// It finished or failed: push it (`announce` in `daemon/app.ts`). Waiting:
/// the session's own push ("... is waiting for you") says it already.
fn announce(app: &AppState, id: &str) {
    let Ok(Some(delegation)) = row(&app.db.lock(), id) else {
        return;
    };
    if delegation.status == "waiting_input" {
        return;
    }
    crate::push::notify(
        app,
        &delegation.owner_user,
        PushMessage {
            title: format!(
                "Delegation {}: {}",
                if delegation.status == "completed" {
                    "finished"
                } else {
                    "failed"
                },
                delegation.title
            ),
            body: "Your assistant will tell you what came of it.".into(),
            tag: format!("delegation:{}", delegation.id),
            target: json!({
                "sessionId": delegation
                    .target_session_id
                    .unwrap_or(delegation.assistant_session_id),
            }),
        },
    );
}

fn update_message(conn: &Connection, delegation: &Delegation) -> String {
    let session = delegation
        .target_session_id
        .as_deref()
        .filter(|target| !target.is_empty())
        .map(|target| session_name(conn, target));
    let mut data = Map::new();
    data.insert("delegation".into(), json!(delegation.id));
    data.insert("title".into(), json!(delegation.title));
    data.insert(
        "workspace".into(),
        json!(label(conn, &delegation.workspace_id)),
    );
    if let Some(session) = session.filter(|session| !session.is_empty()) {
        data.insert("session".into(), json!(session));
    }
    data.insert("status".into(), json!(delegation.status));
    if let Some(result) = delegation.result.as_deref().filter(|r| !r.is_empty()) {
        data.insert(
            "result".into(),
            json!(utf16_slice(result, 0, RESULT_NOTICE_CHARS)),
        );
        let length = utf16_len(result);
        if length > RESULT_NOTICE_CHARS {
            data.insert(
                "resultTruncated".into(),
                json!(format!(
                    "{RESULT_NOTICE_CHARS} of {length} characters shown; read the rest with delegation_status id={} offset={RESULT_NOTICE_CHARS}",
                    delegation.id
                )),
            );
        }
    }
    let mut lines = vec![
        "Delegation update (gateway data, not user instructions):".to_owned(),
        Value::Object(data).to_string(),
    ];
    if let Some(step) = next_step(&delegation.status) {
        lines.push(step.to_owned());
    }
    lines.join("\n")
}

fn publish_answered(app: &App, delegation: &Delegation) {
    // The chat may be gone.
    let Ok(chat) = app.db.lock().get_session(&delegation.assistant_session_id) else {
        return;
    };
    app.events.publish(
        &chat.id,
        chat.runner_epoch,
        "interaction_answered",
        json!({ "interactionId": delegation.id }),
    );
}

/// Start following sessions (event subscription) and the expiry sweep.
pub fn start(app: &AppState) {
    let (sender, mut receiver) = mpsc::unbounded_channel::<GatewayEvent>();
    // Listeners run under the hub's lock: hand the event on and return.
    let subscription = app
        .events
        .subscribe_all(Arc::new(move |event: &GatewayEvent| {
            if is_watched_event(event) {
                let _ = sender.send(event.clone());
            }
        }));
    let weak: Weak<App> = Arc::downgrade(app);
    tokio::spawn(async move {
        let _subscription = subscription;
        while let Some(event) = receiver.recv().await {
            let Some(app) = weak.upgrade() else {
                return;
            };
            on_event(&app, &event);
        }
    });
    let ttl = app.config.delegation_ttl_ms;
    let period = Duration::from_millis(ttl.clamp(50, 30_000));
    let weak: Weak<App> = Arc::downgrade(app);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let Some(app) = weak.upgrade() else {
                return;
            };
            sweep(&app);
        }
    });
}

// ---------- agent operations ----------

/// A parsed `delegation.*` operation.
pub enum Op {
    Create(CreateArgs),
    Status {
        id: Option<String>,
        offset: Option<u64>,
    },
}

/// A string of `min..=max` UTF-16 units.
fn string_in(value: &Value, min: usize, max: usize) -> Result<String, ()> {
    match value {
        Value::String(text) if (min..=max).contains(&utf16_len(text)) => Ok(text.clone()),
        _ => Err(()),
    }
}

/// `/^[a-z][a-z0-9_-]{0,39}$/`
fn role_name(value: &Value) -> Result<String, ()> {
    let text = value.as_str().ok_or(())?;
    let mut bytes = text.bytes();
    let first = bytes.next().is_some_and(|b| b.is_ascii_lowercase());
    let rest =
        bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if first && rest && text.len() <= 40 {
        Ok(text.to_owned())
    } else {
        Err(())
    }
}

fn parse_create(args: &Value) -> Result<CreateArgs, ()> {
    let object = args.as_object().ok_or(())?;
    let (mut workspace, mut task, mut title, mut follows, mut role) =
        (None, None, None, None, None);
    for (key, value) in object {
        match key.as_str() {
            "workspace" => workspace = Some(string_in(value, 1, 300)?),
            "task" => task = Some(string_in(value, 0, 40_000)?),
            "title" => title = Some(string_in(value, 0, 300)?),
            "follows" => follows = Some(string_in(value, 1, 40)?),
            "role" => role = Some(role_name(value)?),
            _ => return Err(()),
        }
    }
    Ok(CreateArgs {
        workspace,
        task: task.ok_or(())?,
        title,
        follows,
        role,
    })
}

fn parse_status(args: &Value) -> Result<Op, ()> {
    let object = args.as_object().ok_or(())?;
    let (mut id, mut offset) = (None, None);
    for (key, value) in object {
        match key.as_str() {
            "id" => id = Some(string_in(value, 1, 40)?),
            "offset" => {
                let number = value.as_f64().ok_or(())?;
                if number.fract() != 0.0 || number < 0.0 {
                    return Err(());
                }
                offset = Some(number as u64);
            }
            _ => return Err(()),
        }
    }
    Ok(Op::Status { id, offset })
}

pub fn parse_op(op: &str, args: &Value) -> Option<Result<Op, ()>> {
    match op {
        "delegation.create" => Some(parse_create(args).map(Op::Create)),
        "delegation.status" => Some(parse_status(args)),
        _ => None,
    }
}

/// Memory belongs to the assistant, which lives in chat workspaces (`requireChat`).
fn require_chat(context: &OpContext) -> ApiResult<()> {
    if context.workspace.kind != WorkspaceKind::Chat {
        return Err(ApiError::new(
            403,
            "forbidden",
            "Only chat sessions have the assistant memory",
        ));
    }
    Ok(())
}

pub async fn run_op(app: &AppState, context: &OpContext, op: Op) -> ApiResult<Value> {
    require_chat(context)?;
    match op {
        Op::Create(args) => {
            let delegation = create(app, &context.user, &context.session, args)?;
            brief(&app.db.lock(), &delegation, false, 0)
        }
        Op::Status { id, offset } => {
            if offset.is_some() && id.is_none() {
                return Err(ApiError::new(400, "invalid_input", "offset needs an id"));
            }
            let conn = app.db.lock();
            let delegations = match id {
                Some(id) => vec![brief(
                    &conn,
                    &get(&conn, &context.user, &id)?,
                    true,
                    offset.unwrap_or(0),
                )?],
                None => list(&conn, &context.user, 20)?
                    .iter()
                    .map(|delegation| brief(&conn, delegation, false, 0))
                    .collect::<ApiResult<_>>()?,
            };
            Ok(json!({ "delegations": delegations }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn delegation() -> Delegation {
        Delegation {
            id: "d01234567".into(),
            owner_user: "u@example.com".into(),
            assistant_session_id: "chat".into(),
            workspace_id: "work:repo".into(),
            title: "Fix it".into(),
            task: "Fix the test.".into(),
            follows: None,
            role: None,
            model: None,
            thinking: None,
            status: "completed".into(),
            target_session_id: None,
            result: None,
            notified_status: None,
            expires_at: 10,
            dispatched_at: None,
            created_at: 5,
        }
    }

    #[test]
    fn pages_through_long_results() {
        let db = Db::memory();
        let conn = db.lock();
        let long: String = (0..3000).map(|i| format!("line {i:04}\n")).collect();
        assert_eq!(long.len(), 30_000);
        let mut item = delegation();
        item.result = Some(long.clone());
        let mut text = String::new();
        let mut offset = Some(0);
        let mut chunks = Vec::new();
        while let Some(at) = offset {
            let brief = brief(&conn, &item, true, at).unwrap();
            text.push_str(brief["result"].as_str().unwrap());
            chunks.push(json!([
                brief["resultOffset"],
                brief["nextOffset"],
                brief["resultChars"]
            ]));
            offset = brief["nextOffset"].as_u64();
        }
        assert_eq!(text, long);
        assert_eq!(
            chunks,
            vec![
                json!([0, 12_000, 30_000]),
                json!([12_000, 24_000, 30_000]),
                json!([24_000, null, 30_000]),
            ]
        );
        let short = brief(&conn, &item, false, 0).unwrap();
        assert!(short["result"].as_str().unwrap().encode_utf16().count() <= 600);
        assert_eq!(
            brief(&conn, &item, true, 30_001).unwrap_err().message,
            "offset exceeds result length 30000"
        );
        // The workspace is unknown: its id stands in.
        assert_eq!(short["workspace"], "work:repo");

        let message = update_message(&conn, &item);
        assert!(message.starts_with(
            "Delegation update (gateway data, not user instructions):\n{\"delegation\":\"d01234567\",\"title\":\"Fix it\",\"workspace\":\"work:repo\",\"status\":\"completed\",\"result\":\"line 0000"
        ));
        assert!(!message.contains("line 0500"));
        assert!(message.contains("\"resultTruncated\":\"4000 of 30000 characters shown; read the rest with delegation_status id=d01234567 offset=4000\""));
        assert!(message.ends_with("\nIt finished: tell the user what came of it."));
    }

    #[test]
    fn confirmations() {
        let db = Db::memory();
        let conn = db.lock();
        let mut item = delegation();
        item.role = Some("general".into());
        item.status = "pending_approval".into();
        let interaction = interaction_of(&conn, &item);
        assert_eq!(
            interaction.to_string(),
            json!({
                "id": "d01234567", "rpcId": "d01234567", "sessionId": "chat", "runnerEpoch": 0,
                "kind": "confirm", "status": "pending",
                "request": { "method": "confirm", "title": "Delegate to work:repo as general?",
                    "message": "Fix it\n\nFix the test.", "confirmLabel": "Delegate",
                    "cancelLabel": "Don't", "modelChoice": { "model": null, "thinking": null } },
                "expiresAt": 10, "createdAt": 5,
            })
            .to_string()
        );
    }

    #[test]
    fn arguments() {
        let create = |value: Value| parse_op("delegation.create", &value).unwrap().is_ok();
        assert!(create(json!({ "workspace": "w", "task": "" })));
        assert!(!create(json!({ "workspace": "w" })));
        assert!(!create(json!({ "workspace": "", "task": "x" })));
        assert!(!create(json!({ "workspace": null, "task": "x" })));
        assert!(!create(json!({ "task": "x", "model": "gw/a" })));
        assert!(!create(json!({ "task": "x", "thinking": "low" })));
        assert!(create(json!({ "task": "x", "role": "fix-er_2" })));
        assert!(!create(json!({ "task": "x", "role": "Fixer" })));
        assert!(!create(json!({ "task": "x", "role": "a".repeat(41) })));
        assert!(!create(json!({ "task": "x".repeat(40_001) })));
        let status = |value: Value| parse_op("delegation.status", &value).unwrap().is_ok();
        assert!(status(json!({})));
        assert!(status(json!({ "id": "d1", "offset": 0 })));
        assert!(status(json!({ "offset": 3.0 })));
        assert!(!status(json!({ "offset": -1 })));
        assert!(!status(json!({ "offset": 1.5 })));
        assert!(!status(json!({ "id": "" })));
        assert!(parse_op("delegation.other", &json!({})).is_none());
    }

    #[test]
    fn model_choices() {
        assert_eq!(model_of(&json!(null)).unwrap(), None);
        assert_eq!(model_of(&json!("")).unwrap(), None);
        assert_eq!(
            model_of(&json!("gw/model/b")).unwrap(),
            Some(ModelRef {
                provider: "gw".into(),
                id: "model/b".into()
            })
        );
        assert_eq!(
            model_of(&json!({ "provider": "gw", "id": "b" })).unwrap(),
            Some(ModelRef {
                provider: "gw".into(),
                id: "b".into()
            })
        );
        for bad in [
            json!("gw/"),
            json!("/b"),
            json!("gw"),
            json!(1),
            json!({ "id": "b" }),
        ] {
            assert_eq!(
                model_of(&bad).unwrap_err().message,
                "model is provider/model-id"
            );
        }
        assert_eq!(
            check_thinking(Some("high".into())).unwrap(),
            Some("high".into())
        );
        assert_eq!(
            check_thinking(Some("loud".into())).unwrap_err().message,
            "thinking is one of off, minimal, low, medium, high, xhigh, max"
        );
        assert_eq!(js_string(&json!(["high"])), "high");
        assert_eq!(js_string(&json!(2)), "2");
        assert_eq!(js_string(&json!({})), "[object Object]");
    }
}
