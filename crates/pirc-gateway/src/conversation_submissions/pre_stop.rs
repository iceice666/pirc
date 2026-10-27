//! A Stop before Node mapping has a separate, Stop-only control scope. Its
//! durable job may retry that same fence, never a prompt or a general Agent Stop.
mod control;
use super::*;
use futures_util::{StreamExt, stream};
use pirc_protocol::HttpMethod;
use std::{sync::Arc, time::Duration};

#[derive(Clone)]
struct Job {
    owner: String,
    op: String,
    target: acceptance::Target,
}
const COLUMNS: &str =
    "owner_user,operation_id,node_id,local_workspace_id,node_operation_id,submission_hash";
fn job(r: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        owner: r.get(0)?,
        op: r.get(1)?,
        target: acceptance::Target {
            node: r.get(2)?,
            workspace: r.get(3)?,
            creation: r.get(4)?,
            hash: r.get(5)?,
        },
    })
}
fn read(db: &Connection, owner: &str, op: &str) -> ApiResult<Option<Job>> {
    Ok(db.query_row(&format!("SELECT {COLUMNS} FROM conversation_submission_pending_stops WHERE owner_user=?1 AND operation_id=?2"),params![owner,op],job).optional()?)
}
pub(super) fn pending(db: &Connection, owner: &str, op: &str) -> ApiResult<bool> {
    Ok(read(db, owner, op)?.is_some())
}
fn owned(app: &AppState, db: &Connection, identity: &Identity, op: &str) -> ApiResult<Preparation> {
    let row = lookup(db, &identity.user, op)?;
    acceptance::require_caller(app, db, identity)?;
    if !row.accepted || row.state == Phase::Cancelled {
        return Err(acceptance::pending_error());
    }
    let session = db.claim_session(&row.session_id, &identity.user, false)?;
    let target = acceptance::target(db, &identity.user, op)?;
    if session.workspace_id != row.workspace_id
        || session.node_id.as_deref() != Some(target.node.as_str())
    {
        return Err(ApiError::new(
            409,
            "submission_target_changed",
            "The original conversation binding changed",
        ));
    }
    Ok(row)
}
fn require_unmapped(db: &Connection, row: &Preparation) -> ApiResult<()> {
    let session = db.get_session(&row.session_id)?;
    let dispatched:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM conversation_submission_dispatches WHERE owner_user=?1 AND operation_id=?2)",params![session.owner_user,row.operation_id],|r|r.get(0))?;
    if row.node_mapped || session.pi_session_id.is_some() || dispatched {
        return Err(ApiError::new(
            409,
            "session_control_required",
            "The conversation has progressed; reconcile and use its Node control and Stop",
        ));
    }
    Ok(())
}
fn queue(
    app: &AppState,
    identity: &Identity,
    op: &str,
    held: &control::Held,
) -> ApiResult<Preparation> {
    held.validate()?;
    let mut db = app.db.lock();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = owned(app, &tx, identity, op)?;
    // A duplicate is only a receipt lookup. An expired/stale lease cannot
    // create or retarget another Stop, but must not obscure an accepted one.
    let already_stopped:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM conversation_submission_dispatches WHERE owner_user=?1 AND operation_id=?2 AND input_hash IS NULL AND stop_confirmed=1)",params![identity.user,op],|r|r.get(0))?;
    if pending(&tx, &identity.user, op)? || already_stopped {
        tx.commit()?;
        return Ok(row);
    }
    require_unmapped(&tx, &row)?;
    control::require_held(&tx, &identity.user, op, held)?;
    let target = acceptance::target(&tx, &identity.user, op)?;
    dispatch::note_stop(&tx, &row.session_id, &identity.user)?;
    tx.execute("INSERT INTO conversation_submission_pending_stops(owner_user,operation_id,node_id,node_operation_id,local_workspace_id,submission_hash,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![identity.user,op,target.node,target.creation,target.workspace,target.hash,now_ms()])?;
    control::expire(&tx, &identity.user, op)?;
    let result = lookup(&tx, &identity.user, op)?;
    tx.commit()?;
    Ok(result)
}
fn invalid_receipt() -> ApiError {
    ApiError::new(
        502,
        "invalid_stop_receipt",
        "Node did not confirm the original creation Stop",
    )
}
fn complete(app: &AppState, j: &Job, proof: &Value) -> ApiResult<()> {
    if proof["operationId"] != j.target.creation
        || proof["workspaceId"] != j.target.workspace
        || proof["submissionHash"] != j.target.hash
        || proof["confirmed"] != true
        || !proof
            .get("sessionId")
            .is_some_and(|id| id.is_null() || id.as_str().is_some_and(valid_id))
    {
        return Err(invalid_receipt());
    }
    let changed = {
        let mut db = app.db.lock();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read(&tx, &j.owner, &j.op)?.is_none() {
            tx.commit()?;
            return Ok(());
        }
        let row = lookup(&tx, &j.owner, &j.op)?;
        let target = acceptance::target(&tx, &j.owner, &j.op)?;
        if row.state == Phase::Cancelled
            || target.node != j.target.node
            || target.creation != j.target.creation
            || target.workspace != j.target.workspace
            || target.hash != j.target.hash
        {
            return Err(invalid_receipt());
        }
        let session = tx.claim_session(&row.session_id, &j.owner, false)?;
        let expected:Option<String>=tx.query_row("SELECT node_session_id FROM conversation_submission_acceptances WHERE owner_user=?1 AND operation_id=?2",params![j.owner,j.op],|r|r.get(0))?;
        if session.workspace_id != row.workspace_id
            || session.node_id.as_deref() != Some(j.target.node.as_str())
            || session.pi_session_id != expected
            || expected
                .as_ref()
                .is_some_and(|id| proof["sessionId"] != *id)
        {
            return Err(invalid_receipt());
        }
        // A nullable receipt is valid only while mapping remains unknown. If a
        // late mapping won, wait for a fresh proof that includes that exact ID.
        let changed=tx.execute("UPDATE conversation_submission_dispatches SET state='stopped',outcome='not_admitted',stop_confirmed=1,last_error_code=NULL,updated_at=?3 WHERE owner_user=?1 AND operation_id=?2 AND input_hash IS NULL AND stop_requested=1 AND admitted_at IS NULL AND state IN ('stopping','stopped')",params![j.owner,j.op,now_ms()])?;
        if changed != 1 {
            return Err(invalid_receipt());
        }
        tx.execute("DELETE FROM conversation_submission_pending_stops WHERE owner_user=?1 AND operation_id=?2",params![j.owner,j.op])?;
        tx.commit()?;
        changed > 0
    };
    if changed {
        app.sessions_changed(Some(&j.owner));
    }
    Ok(())
}
fn failure(app: &AppState, j: &Job, code: &str) -> ApiResult<()> {
    app.db.lock().execute("UPDATE conversation_submission_dispatches SET last_error_code=?3,updated_at=?4 WHERE owner_user=?1 AND operation_id=?2 AND input_hash IS NULL AND stop_requested=1 AND stop_confirmed=0 AND state='stopping'",params![j.owner,j.op,code,now_ms()])?;
    Ok(())
}
fn identity(j: &Job) -> Identity {
    Identity {
        user: j.owner.clone(),
        device_id: None,
        management_authorized: false,
    }
}
async fn query(app: &AppState, j: &Job) -> ApiResult<()> {
    let response = app
        .relay(
            &j.target.node,
            &identity(j),
            HttpMethod::Get,
            format!("/api/session-creations/{}/stop", j.target.creation),
            None,
        )
        .await?;
    if response.status >= 400 {
        return Err(ApiError::new(
            503,
            "creation_stop_unavailable",
            "The original Stop has not been confirmed",
        ));
    }
    complete(
        app,
        j,
        response
            .body
            .as_ref()
            .and_then(|b| b.get("stop"))
            .unwrap_or(&Value::Null),
    )
}
/// Receipt checks send GET only; the background job alone retries an authorized
/// Stop. A query cannot acquire control, dispatch input or create a Node session.
pub(super) async fn reconcile(app: &AppState, owner: &str, op: &str) -> ApiResult<Preparation> {
    let job = read(&app.db.lock(), owner, op)?;
    if let Some(j) = job
        && let Err(error) = query(app, &j).await
    {
        failure(app, &j, error.code)?;
    }
    lookup(&app.db.lock(), owner, op)
}
async fn attempt(app: &AppState, j: Job) -> ApiResult<()> {
    if app.db.lock().execute("UPDATE conversation_submission_pending_stops SET last_attempt_at=?3 WHERE owner_user=?1 AND operation_id=?2",params![j.owner,j.op,now_ms()])?==0 {return Ok(());}
    let result = async {
        let caps = app
            .relay(
                &j.target.node,
                &identity(&j),
                HttpMethod::Get,
                "/api/session-creations/capabilities".into(),
                None,
            )
            .await?;
        if caps.status >= 400
            || !caps
                .body
                .as_ref()
                .is_some_and(|b| b["version"] == 1 && b["canStopBeforeAllocation"] == true)
        {
            return Err(ApiError::new(
                409,
                "creation_stop_unsupported",
                "Node does not support pre-allocation Stop",
            ));
        }
        // Already committed intent, not fresh authority: this can only fence the
        // original unadmitted input, even if the initiating device is gone.
        let response = app
            .relay(
                &j.target.node,
                &identity(&j),
                HttpMethod::Post,
                format!("/api/session-creations/{}/stop", j.target.creation),
                Some(json!({"workspaceId":j.target.workspace,"submissionHash":j.target.hash})),
            )
            .await?;
        if response.status >= 400 {
            return Err(ApiError::new(
                503,
                "creation_stop_unavailable",
                "Node has not confirmed the original pre-admission Stop",
            ));
        }
        complete(
            app,
            &j,
            response
                .body
                .as_ref()
                .and_then(|b| b.get("stop"))
                .unwrap_or(&Value::Null),
        )
    }
    .await;
    if let Err(error) = result {
        failure(app, &j, error.code)?;
    }
    Ok(())
}
async fn sweep(app: &AppState) -> ApiResult<()> {
    let jobs = {
        let db = app.db.lock();
        db.prepare(&format!("SELECT {COLUMNS} FROM conversation_submission_pending_stops ORDER BY last_attempt_at,created_at LIMIT 32"))?.query_map([],job)?.collect::<Result<Vec<_>,_>>()?
    };
    for result in stream::iter(jobs.into_iter().map(|j| attempt(app, j)))
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
    {
        result?;
    }
    Ok(())
}
pub(super) fn start(app: &AppState) {
    let weak = Arc::downgrade(app);
    tokio::spawn(async move {
        loop {
            let Some(app) = weak.upgrade() else {
                return;
            };
            if sweep(&app).await.is_err() {
                crate::log::warn("First-send Stop remains pending; it will retry");
            }
            drop(app);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}
pub(super) fn routes() -> Router<AppState> {
    control::routes().route("/api/conversation-submissions/{id}/stop", post(stop))
}
async fn stop(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(op): Path<String>,
    ReqBody(body): ReqBody,
) -> ApiResult<(axum::http::StatusCode, axum::Json<Value>)> {
    if !valid_id(&op) {
        return Err(ApiError::invalid_input());
    }
    let held: control::Held = body.parse()?;
    let row = queue(&app, &identity, &op, &held)?;
    app.sessions_changed(Some(&identity.user));
    Ok((
        if row
            .message_admission
            .as_ref()
            .is_some_and(|m| m.stop_confirmed)
        {
            axum::http::StatusCode::OK
        } else {
            axum::http::StatusCode::ACCEPTED
        },
        axum::Json(json!({"preparation":row})),
    ))
}
#[cfg(test)]
mod tests;
