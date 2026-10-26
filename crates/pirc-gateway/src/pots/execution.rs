//! Explicit, one-shot host dispatch. Recovery observes or cancels; it never
//! repeats Prepare/Start. An unknown network outcome holds its concurrency slot.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use pirc_protocol::{HttpMethod, PotsControl, PotsOperation, PotsRequest};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::app::{App, AppState};
use crate::db::{Store, atomic};
use crate::dispatch::{
    Progress, TERMINAL_RUNS, is_watched_event, node_request, text_of, workspace_online,
};
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;

const UNCERTAIN: &str =
    "Dispatch outcome is uncertain; inspect the execution conversation. It will not be retried.";
const AUTH_CHANGED: &str = "Dispatch authorization changed; no further work was sent.";
const UNAVAILABLE: &str = "Execution is unavailable; inspect the execution conversation.";
const INCOMPLETE: &str = "Execution ended without completing the task.";
/// Sweep filter: active executions, plus terminal ones whose conversation the
/// Node has not yet handed back to the user.
const PENDING_EXECUTION: &str = "json_extract(data,'$.execution') IS NOT NULL AND (json_extract(data,'$.status') NOT IN ('completed','failed','interrupted','stopped') OR json_extract(data,'$.executionReleased') IS NOT 1)";

#[derive(Default)]
struct Runtime {
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    wake: tokio::sync::Notify,
    subscription: Mutex<Option<crate::events::Subscription>>,
}
fn task_lock(app: &App, id: &str) -> Arc<AsyncMutex<()>> {
    let runtime = app.slots.get_or_init(Runtime::default);
    let mut locks = runtime.locks.lock().unwrap_or_else(|p| p.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(id.into(), Arc::downgrade(&lock));
    lock
}
fn execution(task: &Task) -> ApiResult<&Execution> {
    task.execution.as_ref().ok_or_else(ApiError::internal)
}
fn node_id(task: &Task) -> ApiResult<&str> {
    execution(task)?
        .workspace_id
        .split_once(':')
        .map(|v| v.0)
        .ok_or_else(ApiError::internal)
}
async fn command(app: &App, task: &Task, operation: PotsOperation) -> ApiResult<Value> {
    let e = execution(task)?;
    let generation = if matches!(
        operation,
        PotsOperation::Prepare { .. } | PotsOperation::Start
    ) {
        e.generation
    } else {
        task.control_generation
    };
    let response = app
        .nodes
        .pots_request(
            node_id(task)?,
            PotsRequest {
                user: task.owner_user.clone(),
                dispatch_id: e.dispatch_id.clone(),
                binding_id: task.id.clone(),
                generation: generation.try_into().map_err(|_| ApiError::internal())?,
                operation,
            },
        )
        .await?;
    if response.status == 404 {
        return Err(ApiError::new(404, "dispatch_missing", UNAVAILABLE));
    }
    if response.status >= 400 {
        // Never copy an upstream response/error into a public pots record.
        return Err(ApiError::new(503, "dispatch_unavailable", UNAVAILABLE));
    }
    response
        .body
        .filter(Value::is_object)
        .ok_or_else(ApiError::internal)
}
fn progress(
    app: &App,
    task: &Task,
    status: TaskStatus,
    outcome: Option<&str>,
    failure: Option<&str>,
) -> ApiResult<Task> {
    let task = set_execution_progress(
        &app.db.lock(),
        &task.owner_user,
        &task.id,
        &execution(task)?.dispatch_id,
        status,
        outcome,
        failure,
        now_ms(),
    )?;
    app.sessions_changed(Some(&task.owner_user));
    Ok(task)
}
fn bind(app: &App, task: &Task, answer: &Value) -> ApiResult<Task> {
    let Some(remote) = answer.get("sessionId").and_then(Value::as_str) else {
        return Ok(task.clone());
    };
    if remote.is_empty() || remote.len() > 200 {
        return Err(ApiError::internal());
    }
    let e = execution(task)?;
    let node = node_id(task)?;
    let conn = app.db.lock();
    atomic(&conn, |conn| {
        // A remote deterministic session can be rediscovered after lost replies.
        let session = match conn.resolve_remote_session(node, remote)? {
            Some(id) => conn.get_session(&id)?,
            None => conn.create_session(
                &e.workspace_id,
                &format!("node://{node}/{remote}"),
                node,
                remote,
                &task.owner_user,
            )?,
        };
        bind_execution(
            conn,
            &task.owner_user,
            &task.id,
            &e.dispatch_id,
            &session.id,
            now_ms(),
        )
    })
}

pub(super) async fn start_task_route(
    app: &AppState,
    user: &str,
    id: &str,
    input: StartInput,
) -> ApiResult<Task> {
    let lock = task_lock(app, id);
    let _guard = lock.lock().await;
    // Readiness failures before reservation do not consume a dispatch budget.
    {
        let conn = app.db.lock();
        let task = get_task(&conn, user, id)?;
        if task.execution.is_none() {
            let s = get_suggestion(&conn, user, &task.origin_suggestion_id)?;
            let workspace = conn.get_workspace(&s.evidence.workspace_id)?;
            app.require_mode(&workspace)?;
            if !workspace_online(app, &workspace) {
                return Err(ApiError::new(
                    503,
                    "node_offline",
                    "Node or workspace is offline",
                ));
            }
        }
    }
    let (task, newly_reserved) = reserve_start_task(&app.db.lock(), user, id, input, now_ms())?;
    if !newly_reserved {
        return Ok(task); // No repeated IO even when a reply was lost.
    }
    let attempt: ApiResult<Task> = async {
        authorize_dispatch(
            &app.db.lock(),
            user,
            id,
            &execution(&task)?.dispatch_id,
            now_ms(),
        )?;
        let e = execution(&task)?;
        let local = e
            .workspace_id
            .split_once(':')
            .ok_or_else(ApiError::internal)?
            .1;
        let expires_at = get_suggestion(&app.db.lock(), user, &task.origin_suggestion_id)?
            .evidence
            .expires_at;
        let answer = command(
            app,
            &task,
            PotsOperation::Prepare {
                workspace_id: local.into(),
                content: e.instruction.clone(),
                expires_at,
            },
        )
        .await?;
        let task = bind(app, &task, &answer)?;
        if answer["state"] != "prepared" {
            return Err(ApiError::new(409, "dispatch_fenced", AUTH_CHANGED));
        }
        authorize_dispatch(
            &app.db.lock(),
            user,
            id,
            &execution(&task)?.dispatch_id,
            now_ms(),
        )?;
        let answer = command(app, &task, PotsOperation::Start).await?;
        // `released`: a takeover raced the send, which still crossed RPC.
        if !matches!(answer["state"].as_str(), Some("delivered" | "released")) {
            return Err(ApiError::new(503, "dispatch_uncertain", UNCERTAIN));
        }
        progress(app, &task, TaskStatus::Queued, None, None)
    }
    .await;
    if let Some(runtime) = app.slots.get::<Runtime>() {
        runtime.wake.notify_one();
    }
    match attempt {
        Ok(task) => {
            app.directory_changed();
            Ok(task)
        }
        Err(_) => {
            // A disconnect is not evidence of failure or permission to replay.
            let task = get_task_for_control(&app.db.lock(), user, id)?;
            progress(app, &task, task.status, None, Some(UNCERTAIN))
        }
    }
}

/// Controls persist before Node IO. A concurrent Start must then either fail its
/// host check or encounter the Node's durable send fence. Takeover never aborts
/// an already delivered run; it releases the execution conversation to the user.
/// Stop addresses only a ledger-owned session that pots still holds.
pub(super) async fn control_task_route(
    app: &AppState,
    user: &str,
    id: &str,
    input: TaskControl,
) -> ApiResult<Task> {
    let task = control_task(&app.db.lock(), user, id, input, now_ms())?;
    if task.execution.is_some() && !task.status.is_terminal() {
        apply_control(app, &task).await?;
    }
    app.sessions_changed(Some(user));
    let conn = app.db.lock();
    let mut task = get_task_for_control(&conn, user, id)?;
    if get_task(&conn, user, id).is_err() {
        // Owner cancellation remains possible after revocation, without turning
        // a control endpoint into a private result-preview endpoint.
        task.outcome = None;
        task.failure = None;
    }
    Ok(task)
}
async fn apply_control(app: &App, task: &Task) -> ApiResult<()> {
    let action = if task.status == TaskStatus::Stopping {
        Some(PotsControl::Stop)
    } else if task.taken_over {
        Some(PotsControl::Release)
    } else if task.coordination_paused {
        // A pause fences pots without handing the conversation over.
        Some(PotsControl::TakeOver)
    } else {
        None
    };
    if let Some(action) = action {
        // Offline controls remain pending; the reconciler retries only controls,
        // never an execution command.
        if let Ok(answer) = command(app, task, PotsOperation::Control { action }).await {
            let task = bind(app, task, &answer)?;
            match answer["state"].as_str() {
                Some("stopped") if task.status == TaskStatus::Stopping => {
                    progress(app, &task, TaskStatus::Stopped, None, None)?;
                }
                Some("cancelled" | "stopped") => {
                    progress(
                        app,
                        &task,
                        TaskStatus::Interrupted,
                        None,
                        Some(AUTH_CHANGED),
                    )?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

async fn reconcile(app: &App, task: Task) -> ApiResult<()> {
    let answer = match command(app, &task, PotsOperation::Status).await {
        Ok(answer) => answer,
        Err(error) if error.code == "dispatch_missing" => {
            // Crash before Prepare: a durable tombstone also fences a delayed
            // Prepare request already travelling on the Node link.
            let answer = command(
                app,
                &task,
                PotsOperation::Control {
                    action: PotsControl::Stop,
                },
            )
            .await?;
            if matches!(answer["state"].as_str(), Some("stopped" | "cancelled")) {
                progress(
                    app,
                    &task,
                    if task.status == TaskStatus::Stopping {
                        TaskStatus::Stopped
                    } else {
                        TaskStatus::Interrupted
                    },
                    None,
                    Some(UNCERTAIN),
                )?;
            }
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let mut task = bind(app, &task, &answer)?;
    if task.status == TaskStatus::Stopping || task.taken_over || task.coordination_paused {
        apply_control(app, &task).await?;
        task = get_task_for_control(&app.db.lock(), &task.owner_user, &task.id)?;
        if task.status.is_terminal() || task.status == TaskStatus::Stopping {
            return Ok(());
        }
    }
    match answer["state"].as_str() {
        Some("prepared" | "uncertain") => {
            // The process may have stopped between reserve, prepare and commit.
            // Fence and stop before releasing the concurrency reservation.
            let fenced = task.clone();
            if let Ok(stopped) = command(
                app,
                &fenced,
                PotsOperation::Control {
                    action: PotsControl::Stop,
                },
            )
            .await
                && matches!(stopped["state"].as_str(), Some("stopped" | "cancelled"))
            {
                progress(app, &task, TaskStatus::Interrupted, None, Some(UNCERTAIN))?;
            }
        }
        Some("cancelled" | "stopped") => {
            progress(
                app,
                &task,
                TaskStatus::Interrupted,
                None,
                Some(AUTH_CHANGED),
            )?;
        }
        Some("delivered" | "released") => {
            let session_id = task
                .execution_session_id
                .as_deref()
                .ok_or_else(ApiError::internal)?;
            let session = app
                .db
                .lock()
                .claim_session(session_id, &task.owner_user, false)?;
            if !app
                .db
                .lock()
                .checkpoint_workspace_visible_to_user(&session.workspace_id, &task.owner_user)?
            {
                let fenced = task.clone();
                let stopped = command(
                    app,
                    &fenced,
                    PotsOperation::Control {
                        action: PotsControl::Stop,
                    },
                )
                .await?;
                if stopped["state"] == "stopped" {
                    progress(
                        app,
                        &task,
                        TaskStatus::Interrupted,
                        None,
                        Some(AUTH_CHANGED),
                    )?;
                }
                return Ok(());
            }
            let observed = read_execution_progress(app, &task, &session).await?;
            match observed {
                Progress::Unknown => {}
                Progress::Queued => {
                    progress(app, &task, TaskStatus::Queued, None, None)?;
                }
                Progress::Working => {
                    progress(app, &task, TaskStatus::Running, None, None)?;
                }
                Progress::Waiting(_) => {
                    progress(app, &task, TaskStatus::WaitingInput, None, None)?;
                }
                Progress::Dropped => {
                    progress(app, &task, TaskStatus::Interrupted, None, Some(INCOMPLETE))?;
                }
                Progress::Over { status, answer, .. } => {
                    let succeeded = status == "succeeded";
                    progress(
                        app,
                        &task,
                        if succeeded {
                            TaskStatus::Completed
                        } else {
                            TaskStatus::Failed
                        },
                        Some(&answer),
                        if succeeded { None } else { Some(INCOMPLETE) },
                    )?;
                }
            }
        }
        _ => {
            progress(app, &task, task.status, None, Some(UNAVAILABLE))?;
        }
    }
    Ok(())
}

/// Once a task is terminal, hand its execution conversation to the user. The Node
/// refuses ordinary input there until then, so a Stop racing completion can never
/// abort the user's later work. An unknown send outcome is never handed over: it
/// is stopped instead, because the instruction may still be running.
async fn release(app: &App, task: &Task) -> ApiResult<()> {
    if !task.status.is_terminal() || task.execution.is_none() || task.execution_released {
        return Ok(());
    }
    let control = |action| PotsOperation::Control { action };
    let mut answer = command(app, task, control(PotsControl::Release)).await?;
    if matches!(answer["state"].as_str(), Some("uncertain" | "stopping")) {
        answer = command(app, task, control(PotsControl::Stop)).await?;
    }
    if matches!(
        answer["state"].as_str(),
        Some("released" | "cancelled" | "stopped")
    ) {
        mark_execution_released(
            &app.db.lock(),
            &task.owner_user,
            &task.id,
            &execution(task)?.dispatch_id,
        )?;
    }
    Ok(())
}

/// Read only the dedicated execution, never the original source transcript.
/// Ordinary follow-up input invalidates result attribution: the latest run may
/// belong to the user instead. Keep its slot until that run is actually over.
async fn read_execution_progress(
    app: &App,
    task: &Task,
    session: &crate::db::Session,
) -> ApiResult<Progress> {
    let remote = session
        .pi_session_id
        .as_deref()
        .ok_or_else(ApiError::internal)?;
    let snapshot = node_request(
        app,
        node_id(task)?,
        &task.owner_user,
        HttpMethod::Get,
        format!(
            "/api/sessions/{}/snapshot",
            crate::routes::urlencoding_component(remote)
        ),
        None,
    )
    .await
    .map_err(|_| ApiError::new(503, "execution_unavailable", UNAVAILABLE))?;
    Ok(snapshot_progress(
        &snapshot,
        &execution(task)?.dispatch_id,
        &task.id,
    ))
}
fn snapshot_progress(snapshot: &Value, dispatch_id: &str, binding_id: &str) -> Progress {
    let empty = Vec::new();
    let history = snapshot["history"].as_array().unwrap_or(&empty);
    let status = snapshot["run"]["status"].as_str().unwrap_or_default();
    let over = TERMINAL_RUNS.contains(&status);
    let marker = history.iter().position(|m| {
        m["role"] == "custom"
            && m["customType"] == "pots-dispatch"
            && m["details"]["dispatchId"] == dispatch_id
            && m["details"]["bindingId"] == binding_id
    });
    let Some(marker) = marker else {
        return if over {
            Progress::Dropped
        } else {
            Progress::Queued
        };
    };
    let later_input = history[marker + 1..].iter().any(|m| {
        m["role"] == "user"
            || (m["role"] == "custom"
                && matches!(
                    m["customType"].as_str(),
                    Some(
                        "assistant-delegation"
                            | "assistant-delegation-update"
                            | "scheduled-run"
                            | "pots-dispatch"
                    )
                ))
    });
    if over && later_input {
        return Progress::Dropped;
    }
    if let Some(interactions) = snapshot["interactions"]
        .as_array()
        .filter(|v| !v.is_empty())
    {
        return Progress::Waiting(interactions.clone());
    }
    if !over {
        return Progress::Working;
    }
    let last = history[marker + 1..]
        .iter()
        .rfind(|m| m["role"] == "assistant");
    let answer = last.map(text_of).unwrap_or_default();
    // A forced abort can settle the host run as succeeded. Its partial answer
    // is not successful task completion, regardless of the outer run status.
    let status = match last.and_then(|m| m["stopReason"].as_str()) {
        Some("aborted") => "cancelled",
        Some("error") => "failed",
        _ => status,
    };
    Progress::Over {
        status: status.into(),
        failure_reason: None,
        answer,
    }
}

/// Coalesced runtime events plus a slow recovery sweep, independent of clients.
/// Neither path issues Prepare/Start or restarts stopped work.
pub fn start(app: &AppState) {
    let runtime = app.slots.get_or_init(Runtime::default);
    let notify = Arc::downgrade(&runtime);
    let fence_app = Arc::downgrade(app);
    let subscription = app.events.subscribe_all(Arc::new(move |event| {
        if matches!(
            event.kind.as_str(),
            "runner_ready"
                | "runner_exit"
                | "runner_error"
                | "interaction_answered"
                | "node_reconnected"
                | "session_deleted"
        ) && let Some(app) = fence_app.upgrade()
        {
            // Never call the event hub/DB under the hub's listener lock.
            let session = event.session_id.clone();
            tokio::spawn(async move {
                let _ = fence_invalid_pending(&app, None, Some(&session)).await;
            });
        }
        if (is_watched_event(event) || event.kind == "node_offline")
            && let Some(runtime) = notify.upgrade()
        {
            runtime.wake.notify_one();
        }
    }));
    *runtime
        .subscription
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(subscription);
    let weak = Arc::downgrade(app);
    tokio::spawn(async move {
        let mut after = String::new();
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! { _ = interval.tick() => {}, _ = runtime.wake.notified() => {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }}
            let Some(app) = weak.upgrade() else {
                break;
            };
            let records: ApiResult<Vec<(String, String)>> = (|| {
                let conn = app.db.lock();
                let mut q = conn.prepare(&format!("SELECT id,owner_user FROM pots_tasks WHERE id>? AND {PENDING_EXECUTION} ORDER BY id LIMIT 100"))?;
                Ok(q.query_map([&after], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })();
            let Ok(records) = records else {
                continue;
            };
            if records.is_empty() {
                after.clear();
                continue;
            }
            after = if records.len() < 100 {
                String::new()
            } else {
                records.last().unwrap().0.clone()
            };
            let mut jobs = tokio::task::JoinSet::new();
            for (id, owner) in records {
                if jobs.len() >= 8 {
                    let _ = jobs.join_next().await;
                }
                let app = app.clone();
                jobs.spawn(async move {
                    let lock = task_lock(&app, &id);
                    let Ok(_guard) = lock.try_lock() else {
                        return;
                    };
                    let task = get_task_for_control(&app.db.lock(), &owner, &id);
                    let Ok(task) = task else {
                        return;
                    };
                    if !task.status.is_terminal() {
                        let _ = reconcile(&app, task).await;
                    }
                    // Release promptly once reconciliation made the task terminal.
                    let task = get_task_for_control(&app.db.lock(), &owner, &id);
                    if let Ok(task) = task {
                        let _ = release(&app, &task).await;
                    }
                });
            }
            while jobs.join_next().await.is_some() {}
        }
    });
}

/// Propagate host revocations even while a Start is awaiting runner startup.
/// A read-only source event never grants authority; it can only narrow it.
pub(super) async fn fence_invalid_pending(
    app: &App,
    owner: Option<&str>,
    source_session: Option<&str>,
) -> ApiResult<()> {
    // Keyset pages: an unowned, session-scoped scan is not bounded by the
    // per-owner caps, and every pending task must be rechecked.
    let mut after = String::new();
    loop {
        let tasks = pending_page(app, owner, source_session, &after)?;
        let Some(last) = tasks.last() else {
            return Ok(());
        };
        after = last.id.clone();
        let full = tasks.len() >= PAGE as usize;
        fence_page(app, tasks).await?;
        if !full {
            return Ok(());
        }
    }
}
const PAGE: u32 = 100;
fn pending_page(
    app: &App,
    owner: Option<&str>,
    source_session: Option<&str>,
    after: &str,
) -> ApiResult<Vec<Task>> {
    let conn = app.db.lock();
    let mut q = conn.prepare("SELECT data FROM pots_tasks WHERE json_extract(data,'$.status') IN ('starting','queued') AND (?1 IS NULL OR owner_user=?1) AND (?2 IS NULL OR json_extract(data,'$.targetSessionId')=?2) AND id>?3 ORDER BY id LIMIT ?4")?;
    let rows = q
        .query_map(rusqlite::params![owner, source_session, after, PAGE], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|_| ApiError::internal()))
        .collect()
}
async fn fence_page(app: &App, tasks: Vec<Task>) -> ApiResult<()> {
    for task in tasks {
        let Some(e) = &task.execution else {
            continue;
        };
        if authorize_dispatch(
            &app.db.lock(),
            &task.owner_user,
            &task.id,
            &e.dispatch_id,
            now_ms(),
        )
        .is_err()
        {
            // Takeover-style fence stops only an as-yet-undelivered instruction.
            // Already delivered work continues under its original authorization.
            let fenced = task.clone();
            if let Ok(answer) = command(
                app,
                &fenced,
                PotsOperation::Control {
                    action: PotsControl::TakeOver,
                },
            )
            .await
                && answer["state"] == "cancelled"
            {
                progress(
                    app,
                    &task,
                    TaskStatus::Interrupted,
                    None,
                    Some(AUTH_CHANGED),
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pirc_protocol::{ModeId, NodeHttpResponse, NodeRole, RegisteredWorkspace};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn setup() -> (AppState, tempfile::TempDir, Task) {
        let (app, dir) = super::super::api_tests::fixture();
        let task = {
            let conn = app.db.lock();
            let source = conn
                .create_session("work:repo", "node://work/source", "work", "source", "alice")
                .unwrap();
            let r = create_responsibility(&conn, "alice", serde_json::from_value(json!({
                "idempotencyKey":"watch", "purpose":"Watch input", "scopes":[{"workspaceId":"work:repo","access":"progress"}],
                "budgets":{"observations":10,"dispatches":2,"concurrency":1}
            })).unwrap(), now_ms()).unwrap();
            let r = control_responsibility(
                &conn,
                "alice",
                &r.id,
                ResponsibilityControl {
                    expected_revision: r.revision,
                    expected_generation: r.generation,
                    action: ResponsibilityAction::Activate,
                },
                now_ms(),
            )
            .unwrap();
            control_responsibility(
                &conn,
                "alice",
                &r.id,
                ResponsibilityControl {
                    expected_revision: r.revision,
                    expected_generation: r.generation,
                    action: ResponsibilityAction::ResumeCoordination,
                },
                now_ms(),
            )
            .unwrap();
            let suggestion = ingest_progress(
                &conn,
                "alice",
                "work:repo",
                &source.id,
                0,
                "question",
                i64::MAX,
                now_ms(),
            )
            .unwrap()
            .remove(0);
            accept_tracking(
                &conn,
                "alice",
                &suggestion.id,
                AcceptInput {
                    expected_revision: suggestion.revision,
                    command_id: "track".into(),
                },
                now_ms(),
            )
            .unwrap()
        };
        app.nodes.set_test_node(
            crate::nodes::ConnectedNode {
                id: "work".into(),
                role: NodeRole::Node,
                modes: vec![ModeId::new("directory").unwrap()],
                workspaces: vec![RegisteredWorkspace {
                    id: "repo".into(),
                    display_name: "Repo".into(),
                    mode: ModeId::new("directory").unwrap(),
                    roles: None,
                    repo: None,
                    checkpoint_private: false,
                }],
                added: Default::default(),
                connected_at: 0,
                last_seen_at: 0,
            },
            |_| {
                Ok(NodeHttpResponse {
                    status: 200,
                    body: Some(json!({})),
                })
            },
        );
        (app, dir, task)
    }
    fn input(task: &Task) -> StartInput {
        StartInput {
            expected_revision: task.revision,
            expected_generation: task.control_generation,
            command_id: "start".into(),
            instruction: "Write a concise project status report. Do not answer source approvals."
                .into(),
        }
    }
    fn answer(state: &str) -> ApiResult<NodeHttpResponse> {
        Ok(NodeHttpResponse {
            status: 200,
            body: Some(json!({"sessionId":"pots_remote","state":state})),
        })
    }
    #[tokio::test]
    async fn start_binds_before_send_and_retries_never_repeat_io() {
        let (app, _dir, task) = setup();
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let weak = Arc::downgrade(&app);
        app.nodes.set_test_pots(move |request| {
            let app = weak.upgrade().unwrap();
            calls.fetch_add(1, Ordering::SeqCst);
            match request.operation {
                PotsOperation::Prepare {
                    workspace_id,
                    content,
                    ..
                } => {
                    assert_eq!(workspace_id, "repo");
                    assert!(content.starts_with("Write"));
                    answer("prepared")
                }
                PotsOperation::Start => {
                    let bound =
                        get_task_for_control(&app.db.lock(), "alice", &request.binding_id).unwrap();
                    assert!(bound.execution_session_id.is_some());
                    answer("delivered")
                }
                _ => panic!("unexpected command"),
            }
        });
        let first = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        assert_eq!(first.status, TaskStatus::Queued);
        let second = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        assert_eq!(first.execution_session_id, second.execution_session_id);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(app.db.lock().list_sessions().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn lost_start_ack_retains_slot_and_never_resends() {
        let (app, _dir, task) = setup();
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        app.nodes.set_test_pots(move |request| {
            calls.fetch_add(1, Ordering::SeqCst);
            match request.operation {
                PotsOperation::Prepare { .. } => answer("prepared"),
                PotsOperation::Start => Err(ApiError::new(504, "node_timeout", "secret upstream")),
                _ => panic!("unexpected"),
            }
        });
        let started = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        assert_eq!(started.status, TaskStatus::Starting);
        assert_eq!(started.failure.as_deref(), Some(UNCERTAIN));
        start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn restart_before_prepare_creates_tombstone_not_new_execution() {
        let (app, _dir, task) = setup();
        let (reserved, _) =
            reserve_start_task(&app.db.lock(), "alice", &task.id, input(&task), now_ms()).unwrap();
        app.nodes.set_test_pots(|request| match request.operation {
            PotsOperation::Status => Ok(NodeHttpResponse {
                status: 404,
                body: None,
            }),
            PotsOperation::Control {
                action: PotsControl::Stop,
            } => Ok(NodeHttpResponse {
                status: 200,
                body: Some(json!({"sessionId":null,"state":"stopped"})),
            }),
            _ => panic!("recovery must never dispatch"),
        });
        reconcile(&app, reserved).await.unwrap();
        let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
        assert_eq!(task.status, TaskStatus::Interrupted);
        assert!(task.execution_session_id.is_none());
        assert_eq!(app.db.lock().list_sessions().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn stop_ack_is_required_and_only_owned_dispatch_is_addressed() {
        let (app, _dir, task) = setup();
        app.nodes.set_test_pots(|r| {
            answer(if matches!(r.operation, PotsOperation::Prepare { .. }) {
                "prepared"
            } else {
                "delivered"
            })
        });
        let task = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        let dispatch_id = execution(&task).unwrap().dispatch_id.clone();
        app.nodes.set_test_pots(move |r| {
            assert_eq!(r.dispatch_id, dispatch_id);
            assert!(matches!(
                r.operation,
                PotsOperation::Control {
                    action: PotsControl::Stop
                }
            ));
            Err(ApiError::new(503, "node_offline", "offline"))
        });
        let stopped = control_task_route(
            &app,
            "alice",
            &task.id,
            TaskControl {
                expected_revision: task.revision,
                expected_generation: task.control_generation,
                action: TaskAction::Stop,
            },
        )
        .await
        .unwrap();
        assert_eq!(stopped.status, TaskStatus::Stopping);
        app.nodes.set_test_pots(|r| match r.operation {
            PotsOperation::Status => answer("delivered"),
            PotsOperation::Control {
                action: PotsControl::Stop,
            } => answer("stopped"),
            _ => panic!("no Start"),
        });
        reconcile(&app, stopped).await.unwrap();
        assert_eq!(
            get_task_for_control(&app.db.lock(), "alice", &task.id)
                .unwrap()
                .status,
            TaskStatus::Stopped
        );
        assert!(
            app.db
                .lock()
                .claim_session(&task.target_session_id, "alice", false)
                .is_ok()
        );
    }
    #[tokio::test]
    async fn source_revocation_between_prepare_and_start_fences_without_send() {
        let (app, _dir, task) = setup();
        let weak = Arc::downgrade(&app);
        app.nodes.set_test_pots(move |r| {
            assert!(matches!(r.operation, PotsOperation::Prepare { .. }));
            let app = weak.upgrade().unwrap();
            app.db
                .lock()
                .mark_checkpoint_workspace_private("work:repo")
                .unwrap();
            answer("prepared")
        });
        let started = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        assert_eq!(started.status, TaskStatus::Starting);
        assert_eq!(started.failure.as_deref(), Some(UNCERTAIN));
    }
    #[tokio::test]
    async fn responsibility_change_fences_pending_send_without_advancing_task_generation() {
        let (app, _dir, task) = setup();
        let (reserved, _) =
            reserve_start_task(&app.db.lock(), "alice", &task.id, input(&task), now_ms()).unwrap();
        let responsibility = get_responsibility(
            &app.db.lock(),
            "alice",
            &execution(&reserved).unwrap().responsibility_id,
        )
        .unwrap();
        control_responsibility(
            &app.db.lock(),
            "alice",
            &responsibility.id,
            ResponsibilityControl {
                expected_revision: responsibility.revision,
                expected_generation: responsibility.generation,
                action: ResponsibilityAction::PauseCoordination,
            },
            now_ms(),
        )
        .unwrap();
        let expected_generation = reserved.control_generation;
        app.nodes.set_test_pots(move |request| {
            assert_eq!(request.generation, expected_generation as u64);
            assert!(matches!(
                request.operation,
                PotsOperation::Control {
                    action: PotsControl::TakeOver
                }
            ));
            Ok(NodeHttpResponse {
                status: 200,
                body: Some(json!({"sessionId":null,"state":"cancelled"})),
            })
        });
        fence_invalid_pending(&app, Some("alice"), None)
            .await
            .unwrap();
        let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
        assert_eq!(task.status, TaskStatus::Interrupted);
        assert_eq!(task.control_generation, expected_generation);
    }
    #[tokio::test]
    async fn revocation_fence_pages_past_one_hundred_pending_tasks() {
        let (app, _dir, task) = setup();
        let (reserved, _) =
            reserve_start_task(&app.db.lock(), "alice", &task.id, input(&task), now_ms()).unwrap();
        {
            // Pending rows beyond any single page; their links do not authorize.
            let conn = app.db.lock();
            let mut clone = reserved.clone();
            for n in 0..150 {
                let suggestion = format!("ps-extra-{n:03}");
                conn.execute(
                    "INSERT INTO pots_suggestions(id,owner_user,responsibility_id,condition_key,occurrence_key,revision,data) SELECT ?1,owner_user,responsibility_id,condition_key,?1,revision,data FROM pots_suggestions WHERE id=?2",
                    rusqlite::params![suggestion, reserved.origin_suggestion_id],
                )
                .unwrap();
                clone.id = format!("pt-extra-{n:03}");
                clone.origin_suggestion_id = suggestion.clone();
                conn.execute(
                    "INSERT INTO pots_tasks(id,owner_user,origin_suggestion_id,revision,generation,data) VALUES(?1,'alice',?2,1,1,?3)",
                    rusqlite::params![clone.id, suggestion, serde_json::to_string(&clone).unwrap()],
                )
                .unwrap();
            }
        }
        let fenced = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let seen = fenced.clone();
        app.nodes.set_test_pots(move |request| {
            assert!(matches!(
                request.operation,
                PotsOperation::Control {
                    action: PotsControl::TakeOver
                }
            ));
            seen.lock().unwrap().insert(request.binding_id);
            answer("delivered")
        });
        fence_invalid_pending(&app, None, Some(&reserved.target_session_id))
            .await
            .unwrap();
        assert_eq!(fenced.lock().unwrap().len(), 150);
    }
    #[tokio::test]
    async fn restart_prepared_or_uncertain_stops_before_releasing_slot_without_redispatch() {
        for state in ["prepared", "uncertain"] {
            let (app, _dir, task) = setup();
            let (reserved, _) =
                reserve_start_task(&app.db.lock(), "alice", &task.id, input(&task), now_ms())
                    .unwrap();
            app.nodes
                .set_test_pots(move |request| match request.operation {
                    PotsOperation::Status => answer(state),
                    PotsOperation::Control {
                        action: PotsControl::Stop,
                    } => answer("stopped"),
                    _ => panic!("recovery must never prepare/start"),
                });
            reconcile(&app, reserved).await.unwrap();
            let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
            assert_eq!(task.status, TaskStatus::Interrupted);
            assert!(task.execution_session_id.is_some());
        }
    }
    #[tokio::test]
    async fn revoked_source_control_ack_hides_outcome_and_failure() {
        let (app, _dir, task) = setup();
        app.nodes.set_test_pots(|r| {
            answer(if matches!(r.operation, PotsOperation::Prepare { .. }) {
                "prepared"
            } else {
                "delivered"
            })
        });
        let task = start_task_route(&app, "alice", &task.id, input(&task))
            .await
            .unwrap();
        let task = progress(
            &app,
            &task,
            TaskStatus::Completed,
            Some("PRIVATE_RESULT"),
            None,
        )
        .unwrap();
        app.db
            .lock()
            .mark_checkpoint_workspace_private("work:repo")
            .unwrap();
        let task = control_task_route(
            &app,
            "alice",
            &task.id,
            TaskControl {
                expected_revision: task.revision,
                expected_generation: task.control_generation,
                action: TaskAction::Stop,
            },
        )
        .await
        .unwrap();
        assert!(task.outcome.is_none());
        assert!(task.failure.is_none());
        assert!(get_task(&app.db.lock(), "alice", &task.id).is_err());
    }
    async fn delivered(app: &AppState, task: &Task) -> Task {
        app.nodes.set_test_pots(|r| {
            answer(if matches!(r.operation, PotsOperation::Prepare { .. }) {
                "prepared"
            } else {
                "delivered"
            })
        });
        start_task_route(app, "alice", &task.id, input(task))
            .await
            .unwrap()
    }
    fn controls(app: &AppState, reply: &'static str) -> Arc<Mutex<Vec<PotsControl>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        app.nodes.set_test_pots(move |r| match r.operation {
            PotsOperation::Control { action } => {
                log.lock().unwrap().push(action);
                answer(match action {
                    PotsControl::Stop => "stopped",
                    _ => reply,
                })
            }
            PotsOperation::Status => answer(reply),
            _ => panic!("controls never prepare/start"),
        });
        seen
    }
    #[tokio::test]
    async fn takeover_releases_the_conversation_but_pause_only_fences() {
        let (app, _dir, task) = setup();
        let task = delivered(&app, &task).await;
        let seen = controls(&app, "delivered");
        let paused = control_task_route(
            &app,
            "alice",
            &task.id,
            TaskControl {
                expected_revision: task.revision,
                expected_generation: task.control_generation,
                action: TaskAction::PauseCoordination,
            },
        )
        .await
        .unwrap();
        let seen_after_pause = seen.lock().unwrap().clone();
        assert_eq!(seen_after_pause, [PotsControl::TakeOver]);
        let seen = controls(&app, "released");
        control_task_route(
            &app,
            "alice",
            &task.id,
            TaskControl {
                expected_revision: paused.revision,
                expected_generation: paused.control_generation,
                action: TaskAction::TakeOver,
            },
        )
        .await
        .unwrap();
        assert_eq!(*seen.lock().unwrap(), [PotsControl::Release]);
        // A released execution is still observed until its run is over.
        let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
        assert_eq!(task.status, TaskStatus::Queued);
    }
    #[tokio::test]
    async fn terminal_task_hands_its_conversation_back_once() {
        let (app, _dir, task) = setup();
        let task = delivered(&app, &task).await;
        let task = progress(&app, &task, TaskStatus::Completed, Some("done"), None).unwrap();
        let seen = controls(&app, "released");
        release(&app, &task).await.unwrap();
        assert_eq!(*seen.lock().unwrap(), [PotsControl::Release]);
        let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
        assert!(task.execution_released);
        release(&app, &task).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn terminal_task_with_unknown_send_is_stopped_not_handed_over() {
        let (app, _dir, task) = setup();
        let task = delivered(&app, &task).await;
        let task = progress(&app, &task, TaskStatus::Failed, None, None).unwrap();
        let seen = controls(&app, "uncertain");
        release(&app, &task).await.unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [PotsControl::Release, PotsControl::Stop]
        );
        assert!(
            get_task_for_control(&app.db.lock(), "alice", &task.id)
                .unwrap()
                .execution_released
        );
    }
    #[tokio::test]
    async fn offline_release_stays_pending_for_the_sweep() {
        let (app, _dir, task) = setup();
        let task = delivered(&app, &task).await;
        let task = progress(&app, &task, TaskStatus::Completed, None, None).unwrap();
        app.nodes
            .set_test_pots(|_| Err(ApiError::new(503, "node_offline", "offline")));
        assert!(release(&app, &task).await.is_err());
        let task = get_task_for_control(&app.db.lock(), "alice", &task.id).unwrap();
        assert!(!task.execution_released);
        let pending = |app: &AppState| -> i64 {
            app.db
                .lock()
                .query_row(
                    &format!("SELECT count(*) FROM pots_tasks WHERE {PENDING_EXECUTION}"),
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(pending(&app), 1);
        controls(&app, "released");
        release(&app, &task).await.unwrap();
        assert_eq!(pending(&app), 0);
    }
    #[test]
    fn snapshot_requires_exact_marker_and_never_attributes_later_user_results() {
        let marker = json!({"role":"custom","customType":"pots-dispatch","details":{"dispatchId":"pd","bindingId":"pt"}});
        let s = json!({"history":[marker.clone(),{"role":"assistant","content":"deliverable"}],"run":{"status":"succeeded"},"interactions":[]});
        assert!(
            matches!(snapshot_progress(&s,"pd","pt"),Progress::Over {answer,..} if answer=="deliverable")
        );
        assert_eq!(snapshot_progress(&s, "foreign", "pt"), Progress::Dropped);
        let later = json!({"history":[marker,{"role":"user","content":"different task"},{"role":"assistant","content":"private followup"}],"run":{"status":"succeeded"}});
        assert_eq!(snapshot_progress(&later, "pd", "pt"), Progress::Dropped);
        let internal = json!({"history":[{"role":"custom","customType":"pots-dispatch","details":{"dispatchId":"pd","bindingId":"pt"}},{"role":"custom","customType":"background-task-finished","content":"done"},{"role":"assistant","content":"deliverable"}],"run":{"status":"succeeded"}});
        assert!(
            matches!(snapshot_progress(&internal,"pd","pt"),Progress::Over {status,..} if status=="succeeded")
        );
        let mut aborted = internal;
        aborted["history"][2]["stopReason"] = json!("aborted");
        assert!(
            matches!(snapshot_progress(&aborted,"pd","pt"),Progress::Over {status,..} if status=="cancelled")
        );
    }
}
