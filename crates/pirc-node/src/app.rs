//! The node's own routes (`node/app.ts`, all but the panels'). Owner:
//! **core**.
//!
//! - Workspaces: `POST /api/workspaces` (chat projects on the chat node,
//!   directories under `$HOME` elsewhere, never around the node's state or
//!   a credential store), `GET`/`PATCH /api/workspaces/:id/instructions`,
//!   `GET /api/workspaces/:id/project-config`,
//!   `POST /api/workspaces/:id/project-trust`; on the chat node
//!   `GET /api/assistant/prompts`, `PUT /api/assistant/prompts/:name`.
//! - Sessions: `POST /api/sessions`, `DELETE /api/sessions/:id` (chat
//!   only, fenced, idempotent), `PATCH /api/sessions/:id` (rename),
//!   `GET /api/sessions/:id/snapshot`, `POST /api/sessions/:id/deliver`,
//!   `POST /api/sessions/:id/commands`, control (`GET .../control`,
//!   `POST .../control/acquire|heartbeat|release`),
//!   `POST .../interactions/:interactionId/answer`, `POST .../uploads`.
//! - `POST /api/workspace-memory/recall`.
//!
//! Request bodies are checked as the TS zod schemas did: unknown keys are
//! dropped unless the schema was strict, `.trim()` applies before the
//! length checks, lengths count UTF-16 units, and a failure is 400
//! `invalid_input` "Invalid request".
//!
//! Golden cases: `app.integration.test.ts`, `chat-workspaces`,
//! `project-instructions`, `project-trust`, `assistant-prompts` and the
//! node halves of `relay.integration.test.ts`.

use std::collections::HashMap;
use std::fs::{DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use pirc_config::NodeConfig;
use pirc_protocol::WorkspaceKind;
use serde_json::{Map, Value, json};

use crate::assistant_prompts::{self, PromptName};
use crate::chat;
use crate::error::{ApiError, ApiResult};
use crate::router::{Body, Request, Response, Route, delete, get, parse, patch, post, put};
use crate::runner::{CommandPayload, Delivery};
use crate::services::Node;
use crate::store::{NameSource, SessionRow, Store, UploadKind, UploadRow, Workspace};
use crate::util::{head16, hex, payload_hash, prefix_uuid, random_bytes, sha256_hex};

/// Core's routes for this node's role (the assistant prompt routes exist on
/// the chat node only).
pub fn routes(config: &NodeConfig) -> Vec<Route> {
    let deletions = Arc::new(Deletions::default());
    let mut routes = vec![
        post("/api/workspaces", create_workspace),
        get("/api/workspaces/:id/instructions", read_instructions),
        patch("/api/workspaces/:id/instructions", write_instructions),
        get("/api/workspaces/:id/project-config", project_config),
        post("/api/workspaces/:id/project-trust", project_trust),
        post("/api/sessions", create_session),
        delete("/api/sessions/:id", move |node, request| {
            delete_session(node, request, deletions.clone())
        }),
        patch("/api/sessions/:id", rename_session),
        get("/api/sessions/:id/snapshot", snapshot),
        post("/api/sessions/:id/deliver", deliver),
        post("/api/workspace-memory/recall", recall_workspace_memory),
        post("/api/sessions/:id/commands", command),
        get("/api/sessions/:id/control", control),
        post("/api/sessions/:id/control/acquire", acquire),
        post("/api/sessions/:id/control/heartbeat", heartbeat),
        post("/api/sessions/:id/control/release", release),
        post(
            "/api/sessions/:id/interactions/:interactionId/answer",
            answer,
        ),
        post("/api/sessions/:id/uploads", upload),
    ];
    if config.chat() {
        routes.push(get("/api/assistant/prompts", read_prompts));
        routes.push(put("/api/assistant/prompts/:name", write_prompt));
    }
    routes
}

// ---------- request checks (the zod schemas of node/app.ts) ----------

/// JS string length.
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn object(value: &Value) -> ApiResult<&Map<String, Value>> {
    value.as_object().ok_or_else(ApiError::invalid_input)
}

/// A `.strict()` object: no key but `allowed`.
fn strict(map: &Map<String, Value>, allowed: &[&str]) -> ApiResult<()> {
    if map.keys().all(|key| allowed.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(ApiError::invalid_input())
    }
}

/// `z.string()` (`.trim()` first when `trim`) with `min..=max` UTF-16 units.
fn string(
    map: &Map<String, Value>,
    key: &str,
    trim: bool,
    min: usize,
    max: usize,
) -> ApiResult<String> {
    let text = map
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(ApiError::invalid_input)?;
    let text = if trim { chat::js_trim(text) } else { text };
    let units = length(text);
    if units < min || units > max {
        return Err(ApiError::invalid_input());
    }
    Ok(text.to_owned())
}

/// The same, optional (`undefined` only: `null` is not a string).
fn optional_string(
    map: &Map<String, Value>,
    key: &str,
    trim: bool,
    min: usize,
    max: usize,
) -> ApiResult<Option<String>> {
    match map.get(key) {
        None => Ok(None),
        Some(_) => string(map, key, trim, min, max).map(Some),
    }
}

/// `z.number().int()`: an integral JS number.
fn js_int(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    if let Some(int) = number.as_i64() {
        return Some(int);
    }
    let float = number.as_f64()?;
    (float.is_finite() && float.fract() == 0.0 && float.abs() < 9.007_199_254_740_992e15)
        .then_some(float as i64)
}

/// `z.number().int().positive()` / `.nonnegative()`.
fn integer(map: &Map<String, Value>, key: &str, min: i64) -> ApiResult<i64> {
    map.get(key)
        .and_then(js_int)
        .filter(|value| *value >= min)
        .ok_or_else(ApiError::invalid_input)
}

fn optional_bool(map: &Map<String, Value>, key: &str) -> ApiResult<Option<bool>> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ApiError::invalid_input()),
    }
}

fn enumerated(map: &Map<String, Value>, key: &str, values: &[&str]) -> ApiResult<String> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| values.contains(value))
        .map(str::to_owned)
        .ok_or_else(ApiError::invalid_input)
}

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

fn param<'a>(request: &'a Request, name: &str) -> &'a str {
    request.param(name).unwrap_or_default()
}

/// `claim(request)`: the session, if the user owns it and it is not being
/// deleted.
fn claim(node: &Node, request: &Request) -> ApiResult<SessionRow> {
    node.db
        .lock()
        .claim_session(param(request, "id"), &request.user, false)
}

/// A file-system failure: logged, answered 500 (TS threw a plain error).
fn io_failure(what: &str, path: &Path, error: impl std::fmt::Display) -> ApiError {
    crate::log::error(&format!("{what} {}: {error}", path.display()));
    ApiError::internal()
}

fn created(body: Value) -> ApiResult<Response> {
    Ok(Response::status(201, body))
}

// ---------- workspaces ----------

/// `z.union([chat, directory])`: the chat project, or `(path, displayName)`.
enum NewWorkspace {
    Chat { display_name: String },
    Directory { path: String, display_name: String },
}

fn new_workspace(body: &Value) -> ApiResult<NewWorkspace> {
    let map = object(body)?;
    let display_name = || string(map, "displayName", true, 1, 200);
    if map.get("kind").and_then(Value::as_str) == Some("chat")
        && let Ok(display_name) = display_name()
    {
        return Ok(NewWorkspace::Chat { display_name });
    }
    match map.get("kind") {
        None => {}
        Some(kind) if kind == "directory" => {}
        Some(_) => return Err(ApiError::invalid_input()),
    }
    Ok(NewWorkspace::Directory {
        path: string(map, "path", true, 1, 4096)?,
        display_name: display_name()?,
    })
}

/// The requested directory: `~/rest` is `path.join(home, rest)`, where
/// (unlike `path.resolve`) an absolute `rest` (`~//etc`) stays under home.
fn requested_path(home: &Path, path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(pirc_policy::resolve_path(
            &home.to_string_lossy(),
            rest.trim_start_matches('/'),
        )),
        None => PathBuf::from(path),
    }
}

/// A workspace id: `workspace_<uuid>` with underscores (ids stay one word).
fn workspace_id() -> String {
    prefix_uuid("workspace").replace('-', "_")
}

async fn create_workspace(node: Node, request: Request) -> ApiResult<Response> {
    let config = &node.config;
    let (path, display_name) = match new_workspace(request.json())? {
        NewWorkspace::Chat { display_name } => {
            if !config.chat() {
                return Err(ApiError::forbidden(
                    "This node does not host chats (pirc-chat)",
                ));
            }
            let id = workspace_id();
            let dir = chat::chat_workspace_dir(config, &id)?;
            let workspace = node.db.lock().add_workspace(
                &id,
                &config.node_id,
                &display_name,
                &dir.to_string_lossy(),
                WorkspaceKind::Chat,
            )?;
            return created(json!({ "workspace": workspace }));
        }
        NewWorkspace::Directory { path, display_name } => (path, display_name),
    };
    if config.chat() {
        return Err(ApiError::forbidden(
            "The chat node hosts chat workspaces only (pirc-chat)",
        ));
    }
    let home_dir = node
        .env
        .get("HOME")
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let home = home_dir
        .canonicalize()
        .map_err(|error| io_failure("resolving", &home_dir, error))?;
    let requested = requested_path(&home, &path);
    if !requested.is_absolute() {
        return Err(ApiError::bad_request(
            "Workspace must use an absolute path or ~/path",
        ));
    }
    let canonical = match requested.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            return Err(ApiError::bad_request(
                "Workspace directory must already exist",
            ));
        }
    };
    match std::fs::metadata(&canonical) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(ApiError::bad_request("Workspace path must be a directory"));
        }
        Err(_) => {
            return Err(ApiError::bad_request(
                "Workspace directory must already exist",
            ));
        }
    }
    let canonical = canonical.to_string_lossy().into_owned();
    let home = home.to_string_lossy().into_owned();
    if !canonical.starts_with(&format!("{home}/")) {
        return Err(ApiError::forbidden(
            "Workspace must stay within the node home directory",
        ));
    }
    // A workspace is writable from its sessions' sandboxes: it must not
    // hold (or sit inside) the node's own state or a credential store.
    let database_dir = config
        .database_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut off: Vec<String> = [
        &config.state_dir,
        &config.sessions_dir,
        &config.uploads_dir,
        &database_dir,
        &config.browser.profiles_dir,
        &config.workspace_memory_dir,
    ]
    .iter()
    .map(|dir| dir.to_string_lossy().into_owned())
    .collect();
    off.extend(
        pirc_policy::SENSITIVE_HOME_PATHS
            .iter()
            .map(|item| pirc_policy::resolve_path(&home, item)),
    );
    let clash = off
        .iter()
        .map(|item| pirc_policy::real_resolve(item))
        .find(|item| {
            pirc_policy::is_inside(item, &canonical) || pirc_policy::is_inside(&canonical, item)
        });
    if let Some(clash) = clash {
        return Err(ApiError::forbidden(format!(
            "Workspace must not contain or sit inside {clash} (pirc's state or a credential store)"
        )));
    }
    let workspace = node.db.lock().add_workspace(
        &workspace_id(),
        &config.node_id,
        &display_name,
        &canonical,
        WorkspaceKind::Directory,
    )?;
    // Its roles, as registration reports them, for delegations.
    let mut body = serde_json::to_value(&workspace).unwrap_or_default();
    if let Some(roles) = crate::link::workspace_roles(config, &canonical) {
        body["roles"] = serde_json::to_value(roles).unwrap_or_default();
    }
    created(json!({ "workspace": body }))
}

/// `chatProject`: the workspace, which must be a chat project.
fn chat_project(node: &Node, request: &Request) -> ApiResult<Workspace> {
    let workspace = node.db.lock().get_workspace(param(request, "id"))?;
    if workspace.kind != WorkspaceKind::Chat {
        return Err(ApiError::bad_request(
            "Only chat projects have instructions",
        ));
    }
    Ok(workspace)
}

fn instructions(text: String) -> ApiResult<Response> {
    Ok(Response::json(json!({
        "instructions": { "text": text, "maxChars": chat::INSTRUCTIONS_MAX_CHARS }
    })))
}

async fn read_instructions(node: Node, request: Request) -> ApiResult<Response> {
    let workspace = chat_project(&node, &request)?;
    instructions(chat::read_project_instructions(&workspace))
}

/// `{text: string}`, strict.
fn text_body(body: &Value) -> ApiResult<String> {
    let map = object(body)?;
    strict(map, &["text"])?;
    map.get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(ApiError::invalid_input)
}

async fn write_instructions(node: Node, request: Request) -> ApiResult<Response> {
    let workspace = chat_project(&node, &request)?;
    let text = text_body(request.json())?;
    instructions(chat::write_project_instructions(&workspace, &text)?)
}

/// `directoryWorkspace`: the workspace, which must be a directory.
fn directory_workspace(node: &Node, request: &Request) -> ApiResult<Workspace> {
    let workspace = node.db.lock().get_workspace(param(request, "id"))?;
    if workspace.kind != WorkspaceKind::Directory {
        return Err(ApiError::bad_request(
            "Only directory workspaces have a project config",
        ));
    }
    Ok(workspace)
}

/// `projectSummary`: the project config's trust-relevant fields, their
/// hash and whether the user trusted exactly them; or the config's error.
fn project_summary(node: &Node, workspace: &Workspace) -> ApiResult<Map<String, Value>> {
    use pirc_agent::config as agent;
    let trusted_hash = node.db.lock().get_workspace_trust(&workspace.id)?;
    let mut summary = Map::new();
    match agent::read_project_config(&workspace.canonical_path) {
        Ok(project) => {
            let fields = agent::project_trust_fields(&project);
            let hash = agent::project_trust_hash(&fields);
            summary.insert("hooks".into(), fields.hooks.to_value());
            summary.insert(
                "env".into(),
                Value::Object(
                    fields
                        .env
                        .iter()
                        .map(|(key, value)| (key.clone(), Value::from(value.as_str())))
                        .collect(),
                ),
            );
            summary.insert(
                "allowedPaths".into(),
                Value::from(fields.allowed_paths.clone()),
            );
            summary.insert("hash".into(), Value::from(hash.as_str()));
            summary.insert("trustedHash".into(), json!(trusted_hash));
            summary.insert(
                "trusted".into(),
                Value::Bool(trusted_hash.as_deref() == Some(hash.as_str())),
            );
            summary.insert(
                "empty".into(),
                Value::Bool(agent::project_trust_empty(&fields)),
            );
        }
        Err(error) => {
            summary.insert("error".into(), Value::from(head16(&error, 2000)));
            summary.insert("hash".into(), Value::Null);
            summary.insert("trustedHash".into(), json!(trusted_hash));
            summary.insert("trusted".into(), Value::Bool(false));
            summary.insert("empty".into(), Value::Bool(true));
        }
    }
    Ok(summary)
}

async fn project_config(node: Node, request: Request) -> ApiResult<Response> {
    let workspace = directory_workspace(&node, &request)?;
    Ok(Response::json(
        json!({ "project": project_summary(&node, &workspace)? }),
    ))
}

async fn project_trust(node: Node, request: Request) -> ApiResult<Response> {
    let workspace = directory_workspace(&node, &request)?;
    // `{trusted: true, hash: string}` or `{trusted: false}`, both strict.
    let map = object(request.json())?;
    let hash = match map.get("trusted") {
        Some(Value::Bool(true)) => {
            strict(map, &["trusted", "hash"])?;
            Some(
                map.get("hash")
                    .and_then(Value::as_str)
                    .ok_or_else(ApiError::invalid_input)?
                    .to_owned(),
            )
        }
        Some(Value::Bool(false)) => {
            strict(map, &["trusted"])?;
            None
        }
        _ => return Err(ApiError::invalid_input()),
    };
    let Some(hash) = hash else {
        node.db
            .lock()
            .set_workspace_trust(&workspace.id, None, &request.user)?;
        return Ok(Response::json(
            json!({ "project": project_summary(&node, &workspace)? }),
        ));
    };
    let Some(hash) = pirc_agent::config::parse_trust_hash(Some(&hash)) else {
        return Err(ApiError::bad_request("hash must be a sha256 hex digest"));
    };
    let current = project_summary(&node, &workspace)?;
    if let Some(error) = current.get("error").and_then(Value::as_str) {
        return Err(ApiError::bad_request(format!(
            "The project config is invalid: {error}"
        )));
    }
    // Trust only what the user reviewed: the config may have changed since.
    if current.get("hash").and_then(Value::as_str) != Some(hash.as_str()) {
        return Err(ApiError::conflict(
            "The project config changed since it was shown; review it again before trusting it",
        ));
    }
    node.db
        .lock()
        .set_workspace_trust(&workspace.id, Some(&hash), &request.user)?;
    Ok(Response::json(
        json!({ "project": project_summary(&node, &workspace)? }),
    ))
}

async fn read_prompts(node: Node, _request: Request) -> ApiResult<Response> {
    let dir = &node.config.config_dir;
    Ok(Response::json(json!({
        "soul": assistant_prompts::inspect(dir, PromptName::Soul),
        "chat": assistant_prompts::inspect(dir, PromptName::Chat),
    })))
}

async fn write_prompt(node: Node, request: Request) -> ApiResult<Response> {
    let name = match param(&request, "name") {
        "soul" => PromptName::Soul,
        "chat" => PromptName::Chat,
        _ => return Err(ApiError::invalid_input()),
    };
    let text = text_body(request.json())?;
    let prompt = assistant_prompts::write(&node.config.config_dir, name, &text)?;
    Ok(Response::json(json!({ "prompt": prompt })))
}

// ---------- sessions ----------

async fn create_session(node: Node, request: Request) -> ApiResult<Response> {
    let map = object(request.json())?;
    let workspace_id = string(map, "workspaceId", false, 1, usize::MAX)?;
    let workspace = node.db.lock().get_workspace(&workspace_id)?;
    let storage = node.config.sessions_dir.join(prefix_uuid("pi"));
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&storage)
        .map_err(|error| io_failure("creating", &storage, error))?;
    let session =
        node.db
            .lock()
            .create_session(&workspace.id, &storage.to_string_lossy(), &request.user)?;
    created(json!({ "session": session }))
}

type Deletion = Shared<BoxFuture<'static, ApiResult<()>>>;

/// Chat deletions in flight: a retried DELETE joins the running one.
#[derive(Default)]
struct Deletions(Mutex<HashMap<String, Deletion>>);

async fn delete_session(
    node: Node,
    request: Request,
    deletions: Arc<Deletions>,
) -> ApiResult<Response> {
    let session_id = param(&request, "id").to_owned();
    let user = request.user.clone();
    let (session, workspace) = {
        let db = node.db.lock();
        let deletion = db.session_deletion(&session_id)?;
        if let Some(deletion) = &deletion {
            if deletion.owner_user != user {
                return Err(ApiError::forbidden("Chat belongs to another user"));
            }
            if deletion.status == "deleted" {
                return Ok(Response::empty(204));
            }
        }
        let session = db.claim_session(&session_id, &user, true)?;
        let workspace = db.get_workspace(&session.workspace_id)?;
        if workspace.kind != WorkspaceKind::Chat {
            return Err(ApiError::bad_request("Only chats can be deleted"));
        }
        db.begin_session_deletion(&session_id, &user)?;
        (session, workspace)
    };
    let task = {
        let mut running = deletions.0.lock().unwrap_or_else(|p| p.into_inner());
        running
            .entry(session_id.clone())
            .or_insert_with(|| {
                // Its own task: the cleanup finishes even if this request
                // goes away.
                let handle = tokio::spawn(finish_deletion(
                    node.clone(),
                    session,
                    workspace,
                    deletions.clone(),
                ));
                async move { handle.await.unwrap_or_else(|_| Err(ApiError::internal())) }
                    .boxed()
                    .shared()
            })
            .clone()
    };
    task.await?;
    Ok(Response::empty(204))
}

async fn finish_deletion(
    node: Node,
    session: SessionRow,
    workspace: Workspace,
    deletions: Arc<Deletions>,
) -> ApiResult<()> {
    // Removed on drop, so a panicking cleanup does not leave a finished
    // deletion that every retry would join (TS: `.finally(...)`).
    let _entry = DeletionEntry {
        deletions,
        session_id: session.id.clone(),
    };
    remove_session(&node, &session, &workspace).await
}

/// Removes a session's [`Deletions`] entry when dropped. The entry is
/// inserted under the map's lock before the task can take it, so the
/// removal never precedes the insertion.
struct DeletionEntry {
    deletions: Arc<Deletions>,
    session_id: String,
}

impl Drop for DeletionEntry {
    fn drop(&mut self) {
        self.deletions
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.session_id);
    }
}

async fn remove_session(node: &Node, session: &SessionRow, workspace: &Workspace) -> ApiResult<()> {
    node.runners.stop_session(&session.id).await?;
    node.terminals.dispose_session(&session.id).await;
    node.browser.close_session(&session.id).await;
    // Both paths are allocated by the node, never supplied by the caller.
    let sessions_dir = node.config.sessions_dir.to_string_lossy().into_owned();
    let private = pirc_policy::resolve_path("/", &session.private_session_path);
    if !pirc_policy::is_inside(&private, &sessions_dir)
        || private == pirc_policy::resolve_path("/", &sessions_dir)
    {
        crate::log::error(&format!(
            "deleting session {}: invalid private session path",
            session.id
        ));
        return Err(ApiError::internal());
    }
    remove_tree(Path::new(&session.private_session_path))?;
    let base = session
        .id
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or_default();
    remove_tree(
        &Path::new(&workspace.canonical_path)
            .join("sessions")
            .join(base),
    )?;
    node.branches
        .forget(Path::new(&session.private_session_path));
    node.db.lock().finish_session_deletion(&session.id)?;
    node.events.forget(&session.id);
    Ok(())
}

/// `rmSync(path, { recursive: true, force: true })`.
fn remove_tree(path: &Path) -> ApiResult<()> {
    let removed = match std::fs::symlink_metadata(path) {
        Err(_) => return Ok(()),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    };
    match removed {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(io_failure("removing", path, error))
        }
        _ => Ok(()),
    }
}

async fn rename_session(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let name = string(object(request.json())?, "name", true, 1, 200)?;
    if let Some(active) = node.runners.get(&session.id) {
        let mut command = Map::new();
        command.insert("type".into(), json!("set_session_name"));
        command.insert("name".into(), json!(name));
        let response = active.request(command).await?;
        if response.get("success") != Some(&Value::Bool(true)) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Agent rejected the name");
            return Err(ApiError::runner_unavailable(message));
        }
    }
    // Also tells connected clients; a no-op when the runner's echo already
    // applied it.
    apply_session_name(
        &node,
        &session.id,
        session.runner_epoch,
        &json!({ "name": name, "source": "user" }),
    )?;
    let session = node.db.lock().get_session(&session.id)?;
    Ok(Response::json(json!({ "session": session })))
}

/// The model and thinking level a live agent reports (`get_state`).
async fn live_agent(runner: &crate::runner::Runner) -> Option<Value> {
    let mut command = Map::new();
    command.insert("type".into(), json!("get_state"));
    let response = runner.request(command).await.ok()?;
    if response.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let data = response.get("data").filter(|data| truthy(data))?;
    let model = data.get("model").filter(|model| truthy(model)).map_or(
        Value::Null,
        |model| json!({ "provider": model.get("provider"), "id": model.get("id") }),
    );
    let thinking = data.get("thinkingLevel").cloned().unwrap_or(Value::Null);
    Some(json!({ "model": model, "thinkingLevel": thinking }))
}

/// JS truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

async fn snapshot(node: Node, request: Request) -> ApiResult<Response> {
    let claimed = claim(&node, &request)?;
    let session_id = claimed.id.clone();
    let active = node.runners.get(&session_id);
    let mut agent = match &active {
        Some(runner) => live_agent(runner).await,
        None => None,
    };
    // Read after the RPCs: the runner may have started and bumped the epoch.
    let session = node.db.lock().get_session(&session_id)?;
    let sandbox = match &active {
        Some(runner) if runner.alive() => runner.sandbox_status(),
        _ => Value::Null,
    };
    // The live state, the pending dialogs, the run and the watermark as of
    // one point between two agent lines, the watermark last (TS read them
    // in one tick after its awaits).
    let read = |state: crate::runner::ReducedState| -> ApiResult<_> {
        let db = node.db.lock();
        let interactions = db.pending_interactions(&session_id)?;
        let run = db.latest_run(&session_id)?;
        drop(db);
        let watermark = node.events.watermark(&session_id, session.runner_epoch);
        Ok((state, interactions, run, watermark))
    };
    let (state, interactions, run, watermark) = match &active {
        Some(runner) => runner.state_at(read)?,
        None => read(crate::runner::ReducedState::default())?,
    };
    // History comes from the session file, not the agent: it is there with
    // no runner at all, and a long transcript never has to fit one line.
    // Read after the watermark: the agent writes each message before
    // announcing it, so the file is never behind the watermark (it may be
    // ahead, as in TS).
    let branch = node
        .branches
        .read(Path::new(&claimed.private_session_path))
        .map_err(|error| {
            crate::log::error(&format!("reading session {session_id}: {error}"));
            ApiError::internal()
        })?;
    let history = pirc_agent::session_store::history_with_operations(&branch);
    // No live runner: the settings the next agent starts with, so the
    // client does not fall back to another model.
    if agent.is_none() {
        agent = next_agent_settings(&node, &session, &branch);
    }
    Ok(Response::json(json!({
        "session": session,
        "history": history,
        "partialMessage": state.partial_message,
        "operations": state.operations,
        "queue": state.queue,
        "run": run,
        "interactions": interactions,
        "notifications": state.notifications,
        "widgets": state.widgets,
        "statuses": state.statuses,
        "agent": agent,
        "watermark": watermark,
        "partialOutputLost": session.partial_output_lost,
        "sandbox": sandbox,
    })))
}

/// `sessionSettings(branch, loadAgentConfig(root, models))`, or `None` for
/// an invalid config (advisory only).
fn next_agent_settings(
    node: &Node,
    session: &SessionRow,
    branch: &[pirc_agent::session_store::SessionEntry],
) -> Option<Value> {
    let workspace = node.db.lock().get_workspace(&session.workspace_id).ok()?;
    let root = chat::session_root(&workspace, &session.id).ok()?;
    let env = |name: &str| node.env.get(name).map(str::to_owned);
    let config =
        pirc_agent::config::load_agent_config(&root.to_string_lossy(), node.models.current(), &env)
            .ok()?;
    let (model, thinking) =
        pirc_agent::config::session_settings(branch, config.default_model.as_ref(), &config.models);
    Some(json!({
        "model": model.map(|(provider, id)| json!({ "provider": provider, "id": id })),
        "thinkingLevel": thinking,
    }))
}

/// `deliverBody`: strict, with the lengths and patterns serde cannot check.
fn delivery(body: &Value) -> ApiResult<Delivery> {
    // `.optional()` refuses `null`, which serde would read as `None`.
    if let Value::Object(map) = body
        && ["details", "role", "model", "thinking"]
            .iter()
            .any(|key| map.get(*key).is_some_and(Value::is_null))
    {
        return Err(ApiError::invalid_input());
    }
    let delivery: Delivery = parse(body)?;
    let role_ok = delivery.role.as_deref().is_none_or(|role| {
        let mut chars = role.chars();
        chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && role.len() <= 40
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    });
    let ok = [
        "assistant-delegation",
        "assistant-delegation-update",
        "scheduled-run",
    ]
    .contains(&delivery.custom_type.as_str())
        && (1..=100_000).contains(&length(&delivery.content))
        && role_ok
        && delivery
            .model
            .as_ref()
            .is_none_or(|model| !model.provider.is_empty() && !model.id.is_empty())
        && delivery
            .thinking
            .as_deref()
            .is_none_or(|level| THINKING_LEVELS.contains(&level));
    if !ok {
        return Err(ApiError::invalid_input());
    }
    Ok(delivery)
}

/// The gateway pushes a message into a session: a delegated task, or news
/// of one. No control lease is needed or taken.
async fn deliver(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let body = delivery(request.json())?;
    node.runners.deliver(&session.id, &body).await?;
    Ok(Response::status(202, json!({ "delivered": true })))
}

fn hex_id(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The gateway recalls a workspace-memory note the assistant found. Only
/// the owner of the session that wrote it may read it; a forgotten note
/// answers without its content.
async fn recall_workspace_memory(node: Node, request: Request) -> ApiResult<Response> {
    let map = object(request.json())?;
    strict(map, &["ledgerKey", "id"])?;
    let ledger_key = map.get("ledgerKey").and_then(Value::as_str).unwrap_or("");
    let id = map.get("id").and_then(Value::as_str).unwrap_or("");
    if !hex_id(ledger_key, 16) || !hex_id(id, 12) {
        return Err(ApiError::invalid_input());
    }
    use pirc_agent::features::memory::{recall, workspace};
    let ledger = workspace::WorkspaceLedger::new(
        node.config
            .workspace_memory_dir
            .to_string_lossy()
            .into_owned(),
        ledger_key.to_owned(),
        String::new(),
    );
    let fold = ledger.fold().map_err(|error| {
        crate::log::error(&format!("workspace memory {ledger_key}: {error}"));
        ApiError::internal()
    })?;
    let mut readable = true;
    if let Some(item) = fold.items.get(id) {
        let owner: Option<String> = node
            .db
            .lock()
            .query_row(
                "SELECT owner_user FROM sessions WHERE private_session_path=?1",
                [&item.session_dir],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        readable = owner.as_deref() == Some(request.user.as_str());
    }
    let result = if readable {
        workspace::recall_from_workspace(&fold, id, recall).map_err(|error| {
            crate::log::error(&format!("workspace memory {ledger_key}: {error}"));
            ApiError::internal()
        })?
    } else {
        None
    };
    let Some((text, status)) = result else {
        return Err(ApiError::not_found(format!(
            "No workspace memory note {id}"
        )));
    };
    Ok(Response::json(json!({ "text": text, "status": status })))
}

/// `commandPayload`: the discriminated union, as zod outputs it (unknown
/// keys dropped), with its limits.
fn command_payload(value: &Value) -> ApiResult<CommandPayload> {
    let map = object(value)?;
    let kind = map
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(ApiError::invalid_input)?;
    let message = || string(map, "message", false, 1, 1_000_000);
    let upload_ids = || -> ApiResult<Option<Vec<String>>> {
        match map.get("uploadIds") {
            None => Ok(None),
            Some(Value::Array(items)) if items.len() <= 16 => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(ApiError::invalid_input)
                })
                .collect::<ApiResult<Vec<_>>>()
                .map(Some),
            Some(_) => Err(ApiError::invalid_input()),
        }
    };
    Ok(match kind {
        "prompt" => CommandPayload::Prompt {
            message: message()?,
            upload_ids: upload_ids()?,
        },
        "steer" => CommandPayload::Steer {
            message: message()?,
            upload_ids: upload_ids()?,
        },
        "follow_up" => CommandPayload::FollowUp {
            message: message()?,
            upload_ids: upload_ids()?,
        },
        "stop" => CommandPayload::Stop,
        "clear_queue" => CommandPayload::ClearQueue,
        "send_now" => CommandPayload::SendNow {
            queue: enumerated(map, "queue", &["steering", "followUp"])?,
            index: integer(map, "index", 0)? as u64,
            message: message()?,
        },
        "set_model" => CommandPayload::SetModel {
            provider: string(map, "provider", false, 1, usize::MAX)?,
            model_id: string(map, "modelId", false, 1, usize::MAX)?,
        },
        "set_thinking" => CommandPayload::SetThinking {
            level: enumerated(map, "level", &THINKING_LEVELS)?,
        },
        _ => return Err(ApiError::invalid_input()),
    })
}

/// `{clientId, generation}` of a held control lease.
fn held_lease(map: &Map<String, Value>) -> ApiResult<(String, i64)> {
    Ok((
        string(map, "clientId", false, 1, usize::MAX)?,
        integer(map, "generation", 1)?,
    ))
}

async fn command(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let map = object(request.json())?;
    let command_id = string(map, "commandId", false, 1, 200)?;
    let (client_id, generation) = held_lease(map)?;
    let payload = command_payload(map.get("payload").unwrap_or(&Value::Null))?;
    let stored = serde_json::to_value(&payload).unwrap_or_default();
    let (row, duplicate) = {
        let db = node.db.lock();
        db.validate_lease(&session.id, &client_id, generation)?;
        db.receive_command(&command_id, &session.id, &payload_hash(&stored), &stored)?
    };
    if duplicate {
        return Ok(Response::json(json!({ "command": row, "duplicate": true })));
    }
    node.runners
        .dispatch(&session.id, &command_id, &payload, &request.user)
        .await?;
    let command = node.db.lock().get_command(&command_id)?;
    let status = if command.status == crate::store::CommandStatus::Accepted {
        202
    } else {
        503
    };
    Ok(Response::status(
        status,
        json!({ "command": command, "duplicate": false }),
    ))
}

async fn control(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let lease = node.db.lock().get_lease(&session.id)?;
    Ok(Response::json(json!({ "lease": lease })))
}

async fn acquire(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let map = object(request.json())?;
    let client_id = string(map, "clientId", false, 1, 200)?;
    if map.contains_key("generation") {
        integer(map, "generation", 0)?;
    }
    let force = optional_bool(map, "force")?.unwrap_or(false);
    let lease =
        node.db
            .lock()
            .acquire_lease(&session.id, &client_id, force, node.config.lease_ttl_ms)?;
    Ok(Response::json(json!({ "lease": lease })))
}

/// `heldLeaseBody`: `leaseBody` with a positive generation.
fn held_lease_body(body: &Value) -> ApiResult<(String, i64)> {
    let map = object(body)?;
    let client_id = string(map, "clientId", false, 1, 200)?;
    let generation = integer(map, "generation", 1)?;
    optional_bool(map, "force")?;
    Ok((client_id, generation))
}

async fn heartbeat(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let (client_id, generation) = held_lease_body(request.json())?;
    let lease = node.db.lock().heartbeat_lease(
        &session.id,
        &client_id,
        generation,
        node.config.lease_ttl_ms,
    )?;
    Ok(Response::json(json!({ "lease": lease })))
}

async fn release(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let (client_id, generation) = held_lease_body(request.json())?;
    node.db
        .lock()
        .release_lease(&session.id, &client_id, generation)?;
    Ok(Response::empty(204))
}

/// `answerBody.answer`: the first branch of the union that fits, as zod
/// outputs it.
fn interaction_answer(value: &Value) -> ApiResult<Map<String, Value>> {
    let map = object(value)?;
    let mut answer = Map::new();
    if map.get("cancelled") == Some(&Value::Bool(true)) {
        answer.insert("cancelled".into(), Value::Bool(true));
        return Ok(answer);
    }
    if let Some(Value::String(text)) = map.get("value") {
        let values = match map.get("values") {
            None => None,
            Some(Value::Array(items))
                if items.len() <= 64 && items.iter().all(Value::is_string) =>
            {
                Some(Value::Array(items.clone()))
            }
            Some(_) => None,
        };
        // A bad `values` fails this branch; the next may still fit.
        if values.is_some() || !map.contains_key("values") {
            answer.insert("value".into(), Value::String(text.clone()));
            if let Some(values) = values {
                answer.insert("values".into(), values);
            }
            return Ok(answer);
        }
    }
    if let Some(Value::Bool(confirmed)) = map.get("confirmed") {
        answer.insert("confirmed".into(), Value::Bool(*confirmed));
        return Ok(answer);
    }
    Err(ApiError::invalid_input())
}

async fn answer(node: Node, request: Request) -> ApiResult<Response> {
    let session = claim(&node, &request)?;
    let interaction_id = param(&request, "interactionId").to_owned();
    let map = object(request.json())?;
    let (client_id, generation) = held_lease(map)?;
    let answer = interaction_answer(map.get("answer").unwrap_or(&Value::Null))?;
    node.db
        .lock()
        .validate_lease(&session.id, &client_id, generation)?;
    let active = node
        .runners
        .get(&session.id)
        .filter(|active| active.epoch() == session.runner_epoch)
        .ok_or_else(|| {
            ApiError::new(
                409,
                "stale_interaction",
                "Interaction belongs to an inactive runner",
            )
        })?;
    let epoch = active.epoch();
    let interaction = node.db.lock().claim_interaction(
        &interaction_id,
        &session.id,
        epoch,
        &Value::Object(answer.clone()),
    )?;
    // Publishes `interaction_answered` before the answer goes on.
    node.runners
        .answer(
            &session.id,
            epoch,
            &interaction.rpc_id,
            &interaction.id,
            &answer,
        )
        .await?;
    Ok(Response::json(
        json!({ "interactionId": interaction.id, "status": "answered" }),
    ))
}

/// The image type of `bytes` by its signature (`sniffImage`).
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Images and generic files are stored on the node that runs the
/// session's agent.
async fn upload(node: Node, request: Request) -> ApiResult<Response> {
    claim(&node, &request)?;
    let Body::Raw {
        bytes,
        content_type,
    } = &request.body
    else {
        return Err(ApiError::bad_request("Upload body must be raw bytes"));
    };
    if bytes.is_empty() || bytes.len() > node.config.upload_max_bytes {
        return Err(ApiError::new(
            413,
            "payload_too_large",
            "Upload exceeds configured limit",
        ));
    }
    let query = request.query_object();
    let query = object(&query)?;
    let filename = optional_string(query, "filename", true, 1, 255)?;
    // `headers['content-type'].split(';', 1)[0]`, untrimmed.
    let declared = content_type.split(';').next().unwrap_or_default();
    let (mime_type, kind, filename) = match sniff_image(bytes) {
        Some(sniffed) => {
            if !declared.is_empty() && declared != "application/octet-stream" && declared != sniffed
            {
                return Err(ApiError::bad_request(
                    "Declared Content-Type does not match image content",
                ));
            }
            (sniffed.to_owned(), UploadKind::Image, None)
        }
        None => {
            // Not an image: a file the agent can read from the workspace
            // once the prompt is sent.
            let Some(filename) = filename else {
                return Err(ApiError::bad_request(
                    "filename is required for non-image uploads",
                ));
            };
            let base = filename
                .split('/')
                .rfind(|part| !part.is_empty())
                .unwrap_or_default();
            let cleaned = chat::js_trim(base);
            if cleaned.is_empty() {
                return Err(ApiError::bad_request("filename is invalid"));
            }
            let mime = if declared.is_empty() {
                "application/octet-stream".to_owned()
            } else {
                declared.to_owned()
            };
            (mime, UploadKind::File, Some(cleaned.to_owned()))
        }
    };
    let upload = UploadRow {
        id: prefix_uuid("upload"),
        owner_user: request.user.clone(),
        mime_type,
        byte_size: bytes.len() as i64,
        storage_name: format!("{}.bin", hex(&random_bytes::<24>())),
        sha256: sha256_hex(bytes),
        kind,
        filename,
    };
    let file = node.config.uploads_dir.join(&upload.storage_name);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut out| out.write_all(bytes))
        .map_err(|error| io_failure("writing", &file, error))?;
    node.db.lock().create_upload(&upload)?;
    created(json!({ "upload": {
        "id": upload.id,
        "mimeType": upload.mime_type,
        "byteSize": upload.byte_size,
        "kind": upload.kind,
        "filename": upload.filename,
    } }))
}

/// `applySessionName` (`session-name.ts`): persist a name the agent
/// reported or the user chose and publish `session_renamed`; a generated
/// (`auto`) title never replaces a user's name. Used by the runner
/// (`session_name_changed`) and the rename route.
pub fn apply_session_name(
    node: &Node,
    session_id: &str,
    epoch: i64,
    data: &Value,
) -> ApiResult<()> {
    let name = data["name"]
        .as_str()
        .map(|name| head16(chat::js_trim(name), 200))
        .unwrap_or_default();
    if name.is_empty() {
        return Ok(());
    }
    let auto = data["source"] == "auto";
    {
        let db = node.db.lock();
        if auto {
            if !db.auto_rename_session(session_id, name)? {
                return Ok(());
            }
        } else {
            let session = db.get_session(session_id)?;
            if session.name == name && session.name_source == NameSource::User {
                return Ok(());
            }
            db.rename_session(session_id, name)?;
        }
    }
    node.events.publish(
        session_id,
        epoch,
        "session_renamed",
        json!({ "name": name, "source": if auto { "auto" } else { "user" } }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_bodies() {
        let parsed = |value: Value| new_workspace(&value);
        assert!(matches!(
            parsed(json!({ "kind": "chat", "displayName": " Trip " })),
            Ok(NewWorkspace::Chat { display_name }) if display_name == "Trip"
        ));
        assert!(matches!(
            parsed(json!({ "path": " ~/p ", "displayName": "P", "extra": 1 })),
            Ok(NewWorkspace::Directory { path, .. }) if path == "~/p"
        ));
        for bad in [
            json!({ "kind": "chat", "displayName": "  " }),
            json!({ "kind": "other", "path": "/p", "displayName": "P" }),
            json!({ "displayName": "P" }),
            json!({ "path": "/p", "displayName": "x".repeat(201) }),
            json!([]),
        ] {
            assert!(parsed(bad).is_err());
        }
    }

    #[test]
    fn home_paths_join_as_node_did() {
        let home = Path::new("/home/u");
        for (path, expected) in [
            ("~/p", "/home/u/p"),
            ("~//etc", "/home/u/etc"),
            ("~///etc/x", "/home/u/etc/x"),
            ("~/../v", "/home/v"),
            ("/abs", "/abs"),
            ("rel", "rel"),
        ] {
            assert_eq!(
                requested_path(home, path),
                PathBuf::from(expected),
                "{path}"
            );
        }
    }

    #[test]
    fn deletion_entries_go_even_on_panic() {
        let deletions = Arc::new(Deletions::default());
        let finished: Deletion = async { Ok(()) }.boxed().shared();
        deletions.0.lock().unwrap().insert("s".into(), finished);
        let entry = DeletionEntry {
            deletions: deletions.clone(),
            session_id: "s".into(),
        };
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _entry = entry;
            panic!("cleanup failed");
        }));
        assert!(panicked.is_err());
        assert!(deletions.0.lock().unwrap().is_empty());
    }

    #[test]
    fn command_payloads_as_zod_outputs_them() {
        let payload = command_payload(&json!({ "type": "prompt", "message": "hi",
            "uploadIds": ["u"], "extra": true }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "type": "prompt", "message": "hi", "uploadIds": ["u"] })
        );
        assert_eq!(
            command_payload(&json!({ "type": "send_now", "queue": "followUp",
                "index": 1.0, "message": "m" }))
            .unwrap(),
            CommandPayload::SendNow {
                queue: "followUp".into(),
                index: 1,
                message: "m".into()
            }
        );
        for bad in [
            json!({ "type": "prompt", "message": "" }),
            json!({ "type": "prompt", "message": "m", "uploadIds": [""] }),
            json!({ "type": "send_now", "queue": "x", "index": 0, "message": "m" }),
            json!({ "type": "send_now", "queue": "steering", "index": -1, "message": "m" }),
            json!({ "type": "set_thinking", "level": "huge" }),
            json!({ "type": "nope" }),
        ] {
            assert!(command_payload(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn answers_and_deliveries() {
        assert_eq!(
            Value::Object(interaction_answer(&json!({ "value": "a", "confirmed": true })).unwrap()),
            json!({ "value": "a" })
        );
        assert_eq!(
            Value::Object(
                interaction_answer(&json!({ "value": "a", "values": [1], "confirmed": false }))
                    .unwrap()
            ),
            json!({ "confirmed": false })
        );
        assert_eq!(
            Value::Object(interaction_answer(&json!({ "cancelled": true })).unwrap()),
            json!({ "cancelled": true })
        );
        assert!(interaction_answer(&json!({ "cancelled": false })).is_err());
        assert!(
            delivery(&json!({ "customType": "scheduled-run", "content": "c",
            "role": "reviewer", "thinking": "high" }))
            .is_ok()
        );
        for bad in [
            json!({ "customType": "other", "content": "c" }),
            json!({ "customType": "scheduled-run", "content": "" }),
            json!({ "customType": "scheduled-run", "content": "c", "role": "Bad" }),
            json!({ "customType": "scheduled-run", "content": "c", "thinking": "x" }),
            json!({ "customType": "scheduled-run", "content": "c", "details": null }),
            json!({ "customType": "scheduled-run", "content": "c", "role": null }),
            json!({ "customType": "scheduled-run", "content": "c", "model": null }),
            json!({ "customType": "scheduled-run", "content": "c", "thinking": null }),
        ] {
            assert!(delivery(&bad).is_err(), "{bad}");
        }
        assert_eq!(sniff_image(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8"), Some("image/webp"));
        assert_eq!(sniff_image(b"hello"), None);
    }
}
