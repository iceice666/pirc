//! Delegation (`apps/gateway/src/daemon/delegations.ts`, docs/architecture/assistant-memory.md):
//! the assistant in a chat hands a task to a new session in one of the
//! user's directory workspaces, or more instructions to a session it
//! started before. It starts at once, without asking the user
//! (plans/rewrite/decisions.md #10): the gateway creates and names the session on the target node, delivers
//! the task as a custom message (never as the user's words), follows the
//! session, relays the approvals it waits on to the chat, and tells the chat
//! when the task finishes, fails or needs the user. Also its agent
//! operations (`delegation.create`, `delegation.status` in `agent-ops.ts`)
//! and the push it sends (`announce` in `daemon/app.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, ToSql, params};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::agent_ops::OpContext;
use crate::app::{App, AppState};
use crate::db::{Session, Store, Workspace, atomic};
use crate::dispatch::{
    Progress, clip, deliver, is_watched_event, one_line, read_progress, redact_secrets,
    resolve_directory_workspace, start_session, workspace_online,
};
use crate::error::{ApiError, ApiResult};
use crate::events::GatewayEvent;
use crate::project_links::{self, Linked};
use crate::push::PushMessage;
use crate::util::{hex, new_id as random_id, now_ms, random_bytes};

pub const TASK_MAX_CHARS: usize = 20_000;
const TITLE_MAX_CHARS: usize = 80;
/// Stored in full up to this sanity cap; readers page through it.
const RESULT_MAX_CHARS: usize = 200_000;
/// How much of the result the chat's update message carries.
const RESULT_NOTICE_CHARS: usize = 4000;
/// One `delegation_status` read of a result.
pub const RESULT_CHUNK_CHARS: usize = 12_000;
/// Delegations that may run at once per user (plans/rewrite/decisions.md #10).
pub const RUNNING_MAX: usize = 4;
/// A quote must come from one of the user's last this many messages
/// (auto mode's classifier window).
pub const QUOTE_MESSAGES: usize = 3;
const QUOTE_MAX_CHARS: usize = 2000;
/// Ids of delegated sessions' dialogs relayed to the chat start with this.
pub const RELAY_PREFIX: &str = "relay.";
/// The chat hears about these; the user already sees an approval happen.
const NOTIFIED: &[&str] = &[
    "rejected",
    "expired",
    "waiting_input",
    "completed",
    "failed",
];
/// How long after a watched event the delegated session is read.
const CHECK_DELAY: Duration = Duration::from_millis(150);
/// Finished delegations are kept this long after their last change,
/// unless a later delegation follows them (decided 2026-10-16).
pub const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// How often old delegations are pruned.
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);

fn next_step(status: &str) -> Option<&'static str> {
    Some(match status {
        "completed" => "It finished: tell the user what came of it.",
        "failed" => "It failed: tell the user why.",
        "waiting_input" => {
            "The delegated session is waiting for the user. Its approvals are shown in this chat, where they can answer them; other questions are answered in that session. Tell them."
        }
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
    /// The user ticked "treat this task as my request for auto mode" when
    /// approving: the delegated run's classifier counts the task as one of
    /// their requests, for that run only.
    pub as_user_request: bool,
    /// `approved` (the card) or `auto` (the policy); `None` before it started.
    pub dispatch: Option<String>,
    /// The user's own words the chat's agent found in their recent
    /// messages: the delegated run's classifier reads them as their request.
    /// (Its message ids and the chat's origins are kept for audit only.)
    pub quote: Option<String>,
    pub status: String,
    /// The delegated session (gateway session id), once dispatched.
    pub target_session_id: Option<String>,
    /// The delegated agent's final answer, or why it failed.
    pub result: Option<String>,
    /// The last status the chat was told about.
    pub notified_status: Option<String>,
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
        as_user_request: row.get::<_, i64>("as_user_request")? != 0,
        dispatch: row.get("dispatch")?,
        quote: row.get("quote")?,
        status: row.get("status")?,
        target_session_id: row.get("target_session_id")?,
        result: row.get("result")?,
        notified_status: row.get("notified_status")?,
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

// ---------- per-gateway state ----------

/// What the TS `Delegations` instance kept in memory.
#[derive(Default)]
struct Shared {
    /// Delegations with a check pending.
    scheduled: Mutex<HashSet<String>>,
    /// `id:status` pairs being reported, so one status is never pushed twice at once.
    reporting: Mutex<HashSet<String>>,
    /// The confirm dialogs each delegation's session waits on, as its node
    /// reported them when last read, relayed to the chat that asked.
    relays: Mutex<HashMap<String, Vec<Value>>>,
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
    if let Some(dispatch) = delegation.dispatch.as_deref() {
        out.insert("dispatch".into(), json!(dispatch));
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
/// (`Delegations.workspaces`), and whether their node is online now. In a
/// project, those it is linked to come first (`linked`), then the other
/// clones of their repositories; a linked one whose node no longer has it
/// stays listed, marked `removed`.
#[allow(
    dead_code,
    reason = "the brain's delegation lists them (plans/rewrite/06-workers.md)"
)]
pub fn workspaces(app: &App, project: Option<&str>) -> ApiResult<Value> {
    let (all, links, repos) = {
        let conn = app.db.lock();
        let links = match project {
            Some(project) => project_links::links(&conn, project)?,
            None => Vec::new(),
        };
        let repos = project_links::repos(&conn, &links)?;
        (conn.list_workspaces()?, links, repos)
    };
    let mut listed: Vec<(Option<Linked>, Value)> = all
        .iter()
        .filter_map(|workspace| {
            app.mode(&workspace.mode)
                .filter(|mode| mode.delegate_target && workspace.id.contains(':'))
                .map(|mode| (workspace, mode))
        })
        .map(|(workspace, mode)| {
            let linked = project_links::linked(&links, &repos, workspace);
            let mut item = Map::new();
            item.insert("id".into(), json!(workspace.id));
            item.insert("name".into(), json!(workspace.display_name));
            item.insert("node".into(), json!(workspace.host_id));
            // The assistant names modes only when targets differ in mode.
            item.insert(
                "mode".into(),
                json!({ "id": mode.id, "label": mode.label, "description": mode.description }),
            );
            item.insert("online".into(), json!(workspace_online(app, workspace)));
            if let Some(repo) = &workspace.repo {
                item.insert("repo".into(), json!(repo));
            }
            if let Some(roles) = roles(app, workspace) {
                item.insert("roles".into(), json!(roles));
            }
            if let Some(linked) = linked {
                item.insert("linked".into(), json!(linked.name()));
                if linked == Linked::Workspace && project_links::removed(app, workspace) {
                    item.insert("removed".into(), json!(true));
                }
            }
            (linked, Value::Object(item))
        })
        .collect();
    // A link whose workspace the gateway no longer knows is not dropped silently.
    for link in &links {
        if !all
            .iter()
            .any(|workspace| workspace.id == link.workspace_id)
        {
            let node = link.workspace_id.split(':').next().unwrap_or_default();
            listed.push((
                Some(Linked::Workspace),
                json!({ "id": link.workspace_id, "name": link.workspace_id, "node": node,
                    "online": false, "linked": "workspace", "removed": true }),
            ));
        }
    }
    // Stable: linked, then clones, then the rest, each by name as before.
    listed.sort_by_key(|(linked, _)| linked.map_or(2, |linked| linked as u8));
    Ok(Value::Array(
        listed.into_iter().map(|(_, item)| item).collect(),
    ))
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

/// The dialogs this assistant session's delegated sessions wait on,
/// relayed as interactions (`pendingInteractions`).
pub fn pending_interactions(app: &App, session_id: &str) -> Vec<Value> {
    let conn = app.db.lock();
    let mut out = Vec::new();
    let active = rows(
        &conn,
        "assistant_session_id=? AND status IN ('running','waiting_input')",
        &[&session_id],
    )
    .unwrap_or_default();
    let relays = lock(&shared(app).relays).clone();
    for delegation in active {
        for dialog in relays.get(&delegation.id).into_iter().flatten() {
            out.push(relayed_of(&conn, &delegation, dialog));
        }
    }
    out
}

/// The running or waiting delegations of a chat, as its snapshot and
/// `delegations_changed` show them (with Stop).
pub fn active(app: &App, session_id: &str) -> Value {
    let conn = app.db.lock();
    let active = rows(
        &conn,
        "assistant_session_id=? AND status IN ('running','waiting_input')",
        &[&session_id],
    )
    .unwrap_or_default();
    Value::Array(
        active
            .iter()
            .map(|delegation| {
                json!({
                    "id": delegation.id,
                    "title": delegation.title,
                    "workspace": label(&conn, &delegation.workspace_id),
                    "status": delegation.status,
                    "dispatch": delegation.dispatch.as_deref().unwrap_or("approved"),
                    "targetSessionId": delegation.target_session_id,
                })
            })
            .collect(),
    )
}

/// Tell the chat's clients its running delegations changed.
fn publish_active(app: &App, chat_id: &str) {
    let Ok(chat) = app.db.lock().get_session(chat_id) else {
        return;
    };
    app.events.publish(
        &chat.id,
        chat.runner_epoch,
        "delegations_changed",
        json!({ "delegations": active(app, &chat.id) }),
    );
}

fn relay_id(delegation_id: &str, dialog_id: &str) -> String {
    format!("{RELAY_PREFIX}{delegation_id}.{dialog_id}")
}

/// A delegated session's dialog as the chat shows it: the same question,
/// naming the session it comes from.
fn relayed_of(conn: &Connection, delegation: &Delegation, dialog: &Value) -> Value {
    let id = relay_id(&delegation.id, dialog["id"].as_str().unwrap_or_default());
    let target = delegation.target_session_id.clone().unwrap_or_default();
    let mut request = Map::new();
    request.insert("method".into(), json!("confirm"));
    for key in ["title", "message", "confirmLabel", "cancelLabel"] {
        if let Some(value) = dialog["request"].get(key).filter(|v| v.is_string()) {
            request.insert(key.into(), value.clone());
        }
    }
    request.insert(
        "relayed".into(),
        json!({
            "sessionId": target,
            "sessionName": session_name(conn, &target),
            "workspace": label(conn, &delegation.workspace_id),
            "delegationId": delegation.id,
        }),
    );
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("rpcId".into(), json!(id));
    out.insert("sessionId".into(), json!(delegation.assistant_session_id));
    out.insert("runnerEpoch".into(), json!(0));
    out.insert("kind".into(), json!("confirm"));
    out.insert("status".into(), json!("pending"));
    out.insert("request".into(), Value::Object(request));
    if let Some(expires) = dialog.get("expiresAt").filter(|v| v.is_number()) {
        out.insert("expiresAt".into(), expires.clone());
    }
    out.insert(
        "createdAt".into(),
        dialog.get("createdAt").cloned().unwrap_or(json!(now_ms())),
    );
    Value::Object(out)
}

/// The relayed dialog a delegated session waits on, for the session
/// list's Needs you: `{sessionId, interactionId, title, message}`.
pub fn pending_approval(app: &App, delegation_id: &str) -> Option<Value> {
    let dialog = lock(&shared(app).relays)
        .get(delegation_id)?
        .first()?
        .clone();
    let delegation = row(&app.db.lock(), delegation_id).ok().flatten()?;
    if !["running", "waiting_input"].contains(&delegation.status.as_str()) {
        return None;
    }
    Some(json!({
        "sessionId": delegation.assistant_session_id,
        "interactionId": relay_id(delegation_id, dialog["id"].as_str().unwrap_or_default()),
        "title": dialog["request"]["title"],
        "message": dialog["request"]["message"],
    }))
}

/// Replace what the chat shows of a delegation's dialogs with `dialogs`
/// (the confirm dialogs its session waits on now): new ones are created in
/// the chat, gone ones answered there.
fn set_relays(app: &App, delegation: &Delegation, dialogs: Vec<Value>) {
    let dialogs: Vec<Value> = dialogs
        .into_iter()
        .filter(|dialog| {
            dialog["kind"] == "confirm" && dialog["id"].as_str().is_some_and(|id| !id.is_empty())
        })
        .collect();
    let before = {
        let shared = shared(app);
        let mut relays = lock(&shared.relays);
        let before = if dialogs.is_empty() {
            relays.remove(&delegation.id)
        } else {
            relays.insert(delegation.id.clone(), dialogs.clone())
        };
        before.unwrap_or_default()
    };
    let ids = |list: &[Value]| -> Vec<String> {
        list.iter()
            .filter_map(|dialog| dialog["id"].as_str().map(str::to_owned))
            .collect()
    };
    let (old, new) = (ids(&before), ids(&dialogs));
    if old == new {
        return;
    }
    let Ok(chat) = app.db.lock().get_session(&delegation.assistant_session_id) else {
        return;
    };
    for gone in old.iter().filter(|id| !new.contains(id)) {
        app.events.publish(
            &chat.id,
            chat.runner_epoch,
            "interaction_answered",
            json!({ "interactionId": relay_id(&delegation.id, gone), "interactionEpoch": 0 }),
        );
    }
    for dialog in &dialogs {
        if old
            .iter()
            .any(|id| Some(id.as_str()) == dialog["id"].as_str())
        {
            continue;
        }
        let relayed = relayed_of(&app.db.lock(), delegation, dialog);
        app.events
            .publish(&chat.id, chat.runner_epoch, "interaction_created", relayed);
    }
    // Needs you shows the waiting session's approval.
    app.sessions_changed(Some(&delegation.owner_user));
}

// ---------- the assistant ----------

/// `delegation.create`'s arguments.
pub struct CreateArgs {
    workspace: Option<String>,
    task: String,
    title: Option<String>,
    follows: Option<String>,
    role: Option<String>,
    /// The user's words the chat's agent verified, and their message ids.
    quote: Option<String>,
    entry_ids: Vec<String>,
    /// Where the chat's context since the user's last message came from;
    /// `None` from an older agent (counted as untrusted).
    origins: Option<Vec<String>>,
}

fn new_id(conn: &Connection) -> ApiResult<String> {
    loop {
        let id = format!("d{}", hex(&random_bytes::<4>()));
        if row(conn, &id)?.is_none() {
            return Ok(id);
        }
    }
}

/// The target of a `delegate` that names no workspace: the only workspace
/// the assistant's project is linked to. The user still confirms it.
fn linked_default(app: &App, project: &str) -> ApiResult<Workspace> {
    let conn = app.db.lock();
    let links = project_links::links(&conn, project)?;
    match links.as_slice() {
        [] => Err(ApiError::new(
            400,
            "invalid_input",
            "Name a workspace, or an earlier delegation to follow up",
        )),
        [link] => conn
            .get_workspace(&link.workspace_id)
            .ok()
            .filter(|workspace| {
                app.mode(&workspace.mode)
                    .is_some_and(|mode| mode.delegate_target)
            })
            .ok_or_else(|| {
                ApiError::new(
                    404,
                    "not_found",
                    format!(
                        "The workspace linked to this project ({}) no longer exists; name another",
                        link.workspace_id
                    ),
                )
            }),
        several => Err(ApiError::new(
            400,
            "invalid_input",
            format!(
                "This project is linked to several workspaces; name one: {}",
                several
                    .iter()
                    .map(|link| match conn.get_workspace(&link.workspace_id) {
                        Ok(workspace) => format!(
                            "{} on {} ({})",
                            workspace.display_name, workspace.host_id, workspace.id
                        ),
                        Err(_) => link.workspace_id.clone(),
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// Record a delegation and start it at once: the user is not asked
/// (plans/rewrite/decisions.md #10), but at most [`RUNNING_MAX`] run.
fn create(
    app: &AppState,
    user: &str,
    assistant: &Session,
    input: CreateArgs,
) -> ApiResult<Delegation> {
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
            (linked_default(app, &assistant.workspace_id)?, None)
        } else {
            (resolve_directory_workspace(app, reference)?, None)
        }
    };
    // The node is connected but no longer has the workspace (a link outlives
    // it on purpose): not a reason to wait for the node.
    if project_links::removed(app, &workspace) {
        return Err(ApiError::new(
            404,
            "not_found",
            format!(
                "{} ({}) was removed from {}; name another workspace",
                workspace.display_name, workspace.id, workspace.host_id
            ),
        ));
    }
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
    let quote = input
        .quote
        .as_deref()
        .map(|quote| js_trim(&redact_secrets(quote)).to_owned())
        .filter(|quote| !quote.is_empty());
    if quote.is_some() && input.entry_ids.is_empty() {
        return Err(ApiError::new(
            400,
            "invalid_input",
            "A quote needs the user's message it comes from",
        ));
    }
    let delegation = {
        let conn = app.db.lock();
        let running = rows(
            &conn,
            "owner_user=? AND status IN ('running','waiting_input')",
            &[&user],
        )?
        .len();
        if running >= RUNNING_MAX {
            return Err(ApiError::new(
                429,
                "too_many_requests",
                format!("{running} delegations already run; wait for one to finish"),
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
            "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,follows,role,status,expires_at,created_at,updated_at,dispatch,origins_json,quote,quote_entry_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                user,
                assistant.id,
                workspace.id,
                title,
                task,
                previous.as_ref().map(|p| p.id.clone()),
                role,
                "running",
                at,
                at,
                at,
                "auto",
                input.origins.as_ref().map(|origins| json!(origins).to_string()),
                quote,
                quote.as_ref().map(|_| json!(input.entry_ids).to_string()),
            ],
        )?;
        crate::memory_records::index::put_delegation(&conn, &id, &title, &task, None)?;
        row(&conn, &id)?.ok_or_else(ApiError::internal)?
    };
    publish_active(app, &assistant.id);
    app.sessions_changed(Some(user));
    let background = app.clone();
    let id = delegation.id.clone();
    tokio::spawn(async move { dispatch(&background, &id).await });
    Ok(delegation)
}

// ---------- the user ----------

/// The user answered, in the chat `session_id`, a dialog one of its
/// delegated sessions waits on (`relay.<delegation>.<dialog>`). `None` when
/// the id is not a relay. The node still decides: the answer goes to the
/// original dialog, from the owning user, without the delegated session's
/// control lease (decided 2026-10-19; docs/architecture/security-decisions.md).
pub async fn answer_relayed(
    app: &AppState,
    session_id: &str,
    interaction_id: &str,
    user: &str,
    answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    let Some((delegation_id, dialog_id)) = interaction_id
        .strip_prefix(RELAY_PREFIX)
        .and_then(|rest| rest.split_once('.'))
    else {
        return Ok(None);
    };
    let stale = || {
        ApiError::new(
            409,
            "stale_interaction",
            "The delegated session no longer waits on this",
        )
    };
    let (delegation, target) = {
        let conn = app.db.lock();
        let delegation = match row(&conn, delegation_id)? {
            Some(delegation) if delegation.assistant_session_id == session_id => delegation,
            _ => {
                return Err(ApiError::not_found(format!(
                    "No interaction {interaction_id}"
                )));
            }
        };
        if delegation.owner_user != user {
            return Err(ApiError::new(
                403,
                "forbidden",
                "Delegation belongs to another user",
            ));
        }
        let target = delegation
            .target_session_id
            .as_deref()
            .filter(|target| !target.is_empty())
            .ok_or_else(stale)?;
        let target = conn.get_session(target)?;
        (delegation, target)
    };
    let relayed = lock(&shared(app).relays)
        .get(&delegation.id)
        .is_some_and(|dialogs| dialogs.iter().any(|dialog| dialog["id"] == dialog_id));
    if !relayed {
        return Err(stale());
    }
    if target.owner_user.as_deref() != Some(user) {
        return Err(ApiError::new(
            403,
            "forbidden",
            "The delegated session belongs to another user",
        ));
    }
    app.require_writable(&target)?;
    let (Some(node_id), Some(remote)) = (&target.node_id, &target.pi_session_id) else {
        return Err(stale());
    };
    // `answer ?? {}`; only a confirmation is relayed.
    let confirmed = answer.and_then(|value| value.get("confirmed")) == Some(&Value::Bool(true));
    crate::dispatch::node_request(
        app,
        node_id,
        user,
        pirc_protocol::HttpMethod::Post,
        format!(
            "/api/sessions/{}/interactions/{}/relayed-answer",
            crate::routes::urlencoding_component(remote),
            crate::routes::urlencoding_component(dialog_id)
        ),
        Some(json!({ "answer": { "confirmed": confirmed } })),
    )
    .await
    .map_err(|failure| ApiError::new(409, "stale_interaction", failure.0))?;
    // Shown as answered at once; the next read of the session confirms it.
    let remaining: Vec<Value> = lock(&shared(app).relays)
        .get(&delegation.id)
        .map(|dialogs| {
            dialogs
                .iter()
                .filter(|dialog| dialog["id"] != dialog_id)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    set_relays(app, &delegation, remaining);
    schedule(app, delegation.id.clone());
    Ok(Some(
        json!({ "interactionId": interaction_id, "status": "answered" }),
    ))
}

/// Stop a running delegation's run (`POST /api/delegations/:id/stop`): the
/// gateway takes the delegated session's control when nobody holds it,
/// stops the run and lets go.
pub async fn stop(app: &AppState, user: &str, id: &str) -> ApiResult<Value> {
    let (delegation, target) = {
        let conn = app.db.lock();
        let delegation = get(&conn, user, id)?;
        let target = delegation
            .target_session_id
            .as_deref()
            .filter(|target| !target.is_empty())
            .filter(|_| ["running", "waiting_input"].contains(&delegation.status.as_str()))
            .ok_or_else(|| {
                ApiError::new(409, "conflict", format!("Delegation {id} is not running"))
            })?;
        let target = conn.get_session(target)?;
        (delegation, target)
    };
    app.require_writable(&target)?;
    let (Some(node_id), Some(remote)) = (&target.node_id, &target.pi_session_id) else {
        return Err(ApiError::new(
            409,
            "conflict",
            format!("Delegation {id} is not running"),
        ));
    };
    let url = |path: &str| {
        format!(
            "/api/sessions/{}{path}",
            crate::routes::urlencoding_component(remote)
        )
    };
    let conflict =
        |failure: crate::dispatch::NodeFailure| ApiError::new(409, "conflict", failure.0);
    let client = format!("gateway-stop-{}", delegation.id);
    let lease = crate::dispatch::node_request(
        app,
        node_id,
        user,
        pirc_protocol::HttpMethod::Post,
        url("/control/acquire"),
        Some(json!({ "clientId": client, "force": false })),
    )
    .await
    .map_err(|failure| {
        ApiError::new(
            409,
            "conflict",
            format!(
                "Could not take control of the delegated session ({}); stop it there",
                failure.0
            ),
        )
    })?;
    let generation = lease["lease"]["generation"].as_i64().unwrap_or(0);
    let stopped = crate::dispatch::node_request(
        app,
        node_id,
        user,
        pirc_protocol::HttpMethod::Post,
        url("/commands"),
        Some(json!({
            "commandId": random_id("command"),
            "clientId": client,
            "generation": generation,
            "payload": { "type": "stop" },
        })),
    )
    .await;
    let released = crate::dispatch::node_request(
        app,
        node_id,
        user,
        pirc_protocol::HttpMethod::Post,
        url("/control/release"),
        Some(json!({ "clientId": client, "generation": generation })),
    )
    .await;
    if let Err(failure) = released {
        crate::log::warn(&format!(
            "delegation {id}: releasing control: {}",
            failure.0
        ));
    }
    stopped.map_err(conflict)?;
    schedule(app, delegation.id.clone());
    Ok(json!({ "status": "stopping" }))
}

// ---------- running it ----------

fn task_message(delegation: &Delegation) -> String {
    format!(
        "Task from the user's assistant, started without a separate approval (delegation {}):\n\n{}\n\nWork on it here. When you are done, end with a short summary of what you did and anything left over: the assistant receives your final message.",
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
        // The chat that asked may have been deleted meanwhile.
        conn.get_session(&delegation.assistant_session_id)
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
        // The chat that asked may have been deleted meanwhile.
        conn.get_session(&delegation.assistant_session_id)
            .map_err(message)?;
    }
    let mut task = Map::new();
    task.insert("customType".into(), json!("assistant-delegation"));
    task.insert("content".into(), json!(task_message(delegation)));
    let mut details = json!({ "delegationId": delegation.id, "title": delegation.title });
    if delegation.as_user_request {
        // The delegated agent's auto mode counts the task as the user's
        // request for the run it starts.
        details["asUserRequest"] = json!(true);
    }
    if let Some(quote) = &delegation.quote {
        // The user's own words, verified in their chat: the delegated run's
        // auto mode reads them as their request (never the task text).
        details["userRequests"] = json!([quote]);
    }
    task.insert("details".into(), details);
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
        Progress::Waiting(dialogs) => {
            set_relays(app, &delegation, dialogs);
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
            set_relays(app, &delegation, Vec::new());
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
    status_shown(app, id);
    let found = row(&app.db.lock(), id);
    if let Ok(Some(delegation)) = found {
        publish_active(app, &delegation.assistant_session_id);
    }
}

/// The session list shows a delegated session's status: clients reload it.
fn status_shown(app: &App, id: &str) {
    let owner = row(&app.db.lock(), id)
        .ok()
        .flatten()
        .map(|delegation| delegation.owner_user);
    if let Some(owner) = owner {
        app.sessions_changed(Some(&owner));
    }
}

fn finish(app: &AppState, id: &str, status: &str, result: &str) {
    let changed = {
        let conn = app.db.lock();
        let result = clip(&redact_secrets(result), RESULT_MAX_CHARS);
        atomic(&conn, |conn| {
            let changed = conn.execute(
                "UPDATE delegations SET status=?, result=?, updated_at=? WHERE id=? AND status IN ('running','waiting_input')",
                params![status, result, now_ms(), id],
            )?;
            if changed > 0
                && let Some(delegation) = row(conn, id)?
            {
                crate::memory_records::index::put_delegation(
                    conn,
                    id,
                    &delegation.title,
                    &delegation.task,
                    Some(&result),
                )?;
            }
            Ok(changed)
        })
    };
    if !matches!(changed, Ok(1..)) {
        return;
    }
    let found = row(&app.db.lock(), id);
    if let Ok(Some(delegation)) = found {
        set_relays(app, &delegation, Vec::new());
        publish_active(app, &delegation.assistant_session_id);
    }
    status_shown(app, id);
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
            interaction: None,
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

/// Delete finished delegations last changed before `before` that no other
/// delegation follows; the number deleted. One that is followed goes once
/// the delegation following it has gone.
pub fn prune(conn: &Connection, before: i64) -> ApiResult<usize> {
    atomic(conn, |conn| {
        let pruned = conn.execute(
            "DELETE FROM delegations WHERE status IN ('rejected','expired','completed','failed') AND updated_at<? AND NOT EXISTS (SELECT 1 FROM delegations later WHERE later.follows=delegations.id)",
            [before],
        )?;
        if pruned > 0 {
            crate::memory_records::index::prune_delegations(conn)?;
            crate::memory_records::index::optimize(conn)?;
        }
        Ok(pruned)
    })
}

fn prune_old(app: &App) {
    match prune(&app.db.lock(), now_ms() - RETENTION_MS) {
        Ok(0) => {}
        Ok(count) => crate::log::info(&format!("pruned {count} delegations older than 90 days")),
        Err(error) => crate::log::warn(&format!("pruning delegations: {}", error.message)),
    }
}

/// Start following sessions (event subscription) and the hourly pruning of
/// old delegations.
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
    let weak: Weak<App> = Arc::downgrade(app);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PRUNE_EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let Some(app) = weak.upgrade() else {
                return;
            };
            prune_old(&app);
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

/// An array of at most `max` strings of `1..=chars` UTF-16 units.
fn strings_in(value: &Value, max: usize, chars: usize) -> Result<Vec<String>, ()> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= max)
        .ok_or(())?;
    items.iter().map(|item| string_in(item, 1, chars)).collect()
}

fn parse_create(args: &Value) -> Result<CreateArgs, ()> {
    let object = args.as_object().ok_or(())?;
    let (mut workspace, mut task, mut title, mut follows, mut role) =
        (None, None, None, None, None);
    let (mut quote, mut entry_ids, mut origins) = (None, Vec::new(), None);
    for (key, value) in object {
        match key.as_str() {
            "workspace" => workspace = Some(string_in(value, 1, 300)?),
            "task" => task = Some(string_in(value, 0, 40_000)?),
            "title" => title = Some(string_in(value, 0, 300)?),
            "follows" => follows = Some(string_in(value, 1, 40)?),
            "role" => role = Some(role_name(value)?),
            "quote" => quote = Some(string_in(value, 1, QUOTE_MAX_CHARS)?),
            "entryIds" => entry_ids = strings_in(value, QUOTE_MESSAGES, 200)?,
            "origins" => origins = Some(strings_in(value, 100, 200)?),
            _ => return Err(()),
        }
    }
    Ok(CreateArgs {
        workspace,
        task: task.ok_or(())?,
        title,
        follows,
        role,
        quote,
        entry_ids,
        origins,
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

/// `requireChat`: only the assistant delegates, and no session is the
/// assistant until the gateway hosts it (plans/rewrite/02-brain-host.md).
fn require_delegate(_context: &OpContext) -> ApiResult<()> {
    Err(ApiError::new(403, "forbidden", "No session can delegate"))
}

pub async fn run_op(app: &AppState, context: &OpContext, op: Op) -> ApiResult<Value> {
    require_delegate(context)?;
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
            as_user_request: false,
            dispatch: None,
            quote: None,
            status: "completed".into(),
            target_session_id: None,
            result: None,
            notified_status: None,
            dispatched_at: None,
            created_at: 5,
        }
    }

    #[test]
    fn prunes_old_finished_delegations_nobody_follows() {
        let db = Db::memory();
        let conn = db.lock();
        let day = 24 * 60 * 60 * 1000;
        let now = 1_000 * day;
        for (id, status, age, follows) in [
            ("old-done", "completed", 91, None),
            ("old-failed", "failed", 91, None),
            ("old-rejected", "rejected", 91, None),
            ("old-running", "running", 91, None),
            ("old-followed", "completed", 120, None),
            ("follower", "completed", 10, Some("old-followed")),
            ("recent", "completed", 89, None),
        ] {
            conn.execute(
                "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,follows,status,expires_at,created_at,updated_at) VALUES (?,'u','chat','w','t','x',?,?,0,0,?)",
                params![id, follows, status, now - age * day],
            )
            .unwrap();
        }
        assert_eq!(prune(&conn, now - RETENTION_MS).unwrap(), 3);
        let mut left: Vec<String> = conn
            .prepare("SELECT id FROM delegations ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        left.sort();
        assert_eq!(left, ["follower", "old-followed", "old-running", "recent"]);
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
}
