//! Backend-only pots dispatches. The ledger, never message text/details, is
//! provenance. A durable send claim precedes RPC: a crash can lose delivery,
//! but may never duplicate it. No pending work is replayed on startup.
use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::sync::{Arc, Mutex, Weak};

use pirc_protocol::{NodeHttpResponse, PotsControl, PotsOperation, PotsRequest};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::error::{ApiError, ApiResult};
use crate::runner::Delivery;
use crate::services::Node;
use crate::store::Store;
use crate::util::{now_ms, sha256_hex};

#[derive(Default)]
pub(crate) struct Pots(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);

impl Pots {
    fn lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

#[derive(Debug)]
struct Dispatch {
    binding: String,
    generation: u64,
    workspace: Option<String>,
    content: Option<String>,
    session: Option<String>,
    state: String,
    fenced: bool,
    expires_at: Option<i64>,
}

impl Dispatch {
    fn status(&self) -> Value {
        // Sending cannot be retried, including after a crash before RPC ack.
        let state = if self.state == "sending" {
            "uncertain"
        } else {
            &self.state
        };
        json!({ "sessionId": self.session, "state": state })
    }
}

/// A prepared execution must remain empty until its one trusted dispatch has
/// crossed RPC. Otherwise an ordinary prompt could make deliver queue work
/// behind a user run and a later takeover would not fence that queued message.
pub(crate) fn require_generic_input(db: &Connection, session_id: &str) -> ApiResult<()> {
    let reserved: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pots_dispatches WHERE session_id=?1 AND state IN ('prepared','sending','uncertain'))",
        [session_id], |r| r.get(0),
    )?;
    if reserved {
        return Err(ApiError::new(
            409,
            "pots_dispatch_reserved",
            "This execution is reserved for its pending pots dispatch",
        ));
    }
    Ok(())
}

fn identity(request: &PotsRequest) -> String {
    format!(
        "pots_{}",
        sha256_hex(
            serde_json::to_string(&[&request.user, &request.dispatch_id,])
                .expect("strings serialize")
        )
    )
}

fn validate(request: &PotsRequest) -> ApiResult<()> {
    if request.user.is_empty()
        || request.user.len() > 320
        || [&request.dispatch_id, &request.binding_id]
            .iter()
            .any(|s| s.is_empty() || s.len() > 200)
        || request.generation > i64::MAX as u64
    {
        return Err(ApiError::invalid_input());
    }
    if let PotsOperation::Prepare {
        workspace_id,
        content,
        expires_at,
    } = &request.operation
        && (workspace_id.is_empty()
            || workspace_id.len() > 256
            || content.trim().is_empty()
            || content.len() > 20_000
            || *expires_at <= 0)
    {
        return Err(ApiError::invalid_input());
    }
    Ok(())
}

fn read(db: &Connection, request: &PotsRequest) -> ApiResult<Option<Dispatch>> {
    Ok(db
        .query_row(
            "SELECT binding_id,generation,workspace_id,content,session_id,state,fenced,expires_at \
         FROM pots_dispatches WHERE owner=?1 AND dispatch_id=?2",
            params![request.user, request.dispatch_id],
            |r| {
                Ok(Dispatch {
                    binding: r.get(0)?,
                    generation: r.get(1)?,
                    workspace: r.get(2)?,
                    content: r.get(3)?,
                    session: r.get(4)?,
                    state: r.get(5)?,
                    fenced: r.get(6)?,
                    expires_at: r.get(7)?,
                })
            },
        )
        .optional()?)
}

fn bound(dispatch: &Dispatch, request: &PotsRequest) -> ApiResult<()> {
    if dispatch.binding != request.binding_id {
        return Err(ApiError::conflict("Dispatch belongs to another binding"));
    }
    Ok(())
}

fn current(dispatch: &Dispatch, request: &PotsRequest) -> ApiResult<()> {
    bound(dispatch, request)?;
    if dispatch.generation != request.generation {
        return Err(ApiError::conflict("Dispatch generation is stale"));
    }
    Ok(())
}

fn require(db: &Connection, request: &PotsRequest) -> ApiResult<Dispatch> {
    let dispatch = read(db, request)?.ok_or_else(|| ApiError::not_found("Dispatch not found"))?;
    bound(&dispatch, request)?;
    Ok(dispatch)
}

fn session(db: &Connection, request: &PotsRequest, dispatch: &Dispatch) -> ApiResult<String> {
    let id = dispatch
        .session
        .as_ref()
        .ok_or_else(|| ApiError::conflict("Dispatch has no session"))?;
    if *id != identity(request) {
        return Err(ApiError::conflict("Dispatch session binding changed"));
    }
    // A deletion fence may block sends, but must never block stopping an
    // otherwise correctly bound execution. Callers starting delivery are
    // fenced again by RunnerManager::deliver_checked.
    let row = db.claim_session(id, &request.user, true)?;
    if Some(row.workspace_id.as_str()) != dispatch.workspace.as_deref() {
        return Err(ApiError::conflict("Dispatch workspace binding changed"));
    }
    Ok(id.clone())
}

fn prepare(
    node: &Node,
    request: &PotsRequest,
    workspace: &str,
    content: &str,
    expires_at: i64,
) -> ApiResult<Value> {
    let mut db = node.db.lock();
    let tx = db.transaction()?;
    if let Some(old) = read(&tx, request)? {
        bound(&old, request)?;
        if old.fenced {
            return Ok(old.status());
        }
        current(&old, request)?;
        if old.workspace.as_deref() != Some(workspace)
            || old.content.as_deref() != Some(content)
            || old.expires_at != Some(expires_at)
        {
            return Err(ApiError::conflict(
                "Dispatch instruction or workspace changed",
            ));
        }
        session(&tx, request, &old)?;
        return Ok(old.status());
    }
    if expires_at <= now_ms() {
        return Err(ApiError::conflict("Dispatch evidence expired"));
    }
    crate::checkpoints::continuation::require_workspace_owner(&tx, workspace, &request.user)?;
    node.workspace_mode(&tx.get_workspace(workspace)?)?;
    let id = identity(request);
    let storage = node.config.sessions_dir.join(&id);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&storage)
        .map_err(|_| ApiError::internal())?;
    // Never adopt an existing ordinary session, even at the expected identity.
    tx.execute("INSERT INTO sessions(id,workspace_id,private_session_path,name,name_source,owner_user,created_at,updated_at) VALUES(?1,?2,?3,'Pots execution','auto',?4,?5,?5)",
        params![id, workspace, storage.to_string_lossy(), request.user, now_ms()])?;
    tx.execute("INSERT INTO pots_dispatches(owner,dispatch_id,binding_id,generation,workspace_id,content,session_id,state,fenced,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'prepared',0,?8)",
        params![request.user, request.dispatch_id, request.binding_id, request.generation, workspace, content, id, expires_at])?;
    let result = require(&tx, request)?.status();
    tx.commit()?;
    Ok(result)
}

/// Claim exactly once after startup, immediately before the delivery boundary.
/// A takeover can fence a start while its sandbox/runner is still starting.
fn claim_send(db: &Connection, request: &PotsRequest) -> ApiResult<Option<Dispatch>> {
    let dispatch = require(db, request)?;
    if dispatch.fenced {
        return Ok(None);
    }
    current(&dispatch, request)?;
    if dispatch.state == "prepared" && dispatch.expires_at.is_none_or(|at| at <= now_ms()) {
        db.execute("UPDATE pots_dispatches SET state='cancelled',fenced=1 WHERE owner=?1 AND dispatch_id=?2 AND state='prepared'", params![request.user, request.dispatch_id])?;
        return Ok(None);
    }
    if dispatch.state == "prepared" {
        let claimed = db.execute("UPDATE pots_dispatches SET state='sending' WHERE owner=?1 AND dispatch_id=?2 AND state='prepared' AND fenced=0 AND generation=?3 AND binding_id=?4",
            params![request.user, request.dispatch_id, request.generation, request.binding_id])?;
        return Ok((claimed == 1).then_some(dispatch));
    }
    Ok(None)
}

fn fence(db: &Connection, request: &PotsRequest) -> ApiResult<Dispatch> {
    if let Some(old) = read(db, request)? {
        bound(&old, request)?;
        if request.generation < old.generation && old.state == "stopped" {
            return Ok(old);
        }
        if request.generation < old.generation {
            return Err(ApiError::conflict("Dispatch generation is stale"));
        }
        db.execute("UPDATE pots_dispatches SET generation=?3,fenced=1,state=CASE WHEN state='prepared' THEN 'cancelled' ELSE state END WHERE owner=?1 AND dispatch_id=?2",
            params![request.user, request.dispatch_id, request.generation])?;
    } else {
        db.execute("INSERT INTO pots_dispatches(owner,dispatch_id,binding_id,generation,state,fenced) VALUES(?1,?2,?3,?4,'cancelled',1)",
            params![request.user, request.dispatch_id, request.binding_id, request.generation])?;
    }
    require(db, request)
}

async fn execute(node: &Node, request: &PotsRequest) -> ApiResult<Value> {
    validate(request)?;
    if !node.config.allowed_users.contains(&request.user) {
        return Err(ApiError::forbidden("User is not allowed on this node"));
    }
    let lock = node.pots.lock(&identity(request));
    match &request.operation {
        PotsOperation::Prepare {
            workspace_id,
            content,
            expires_at,
        } => {
            let _guard = lock.lock().await;
            prepare(node, request, workspace_id, content, *expires_at)
        }
        PotsOperation::Status => {
            let db = node.db.lock();
            let dispatch = require(&db, request)?;
            Ok(dispatch.status())
        }
        PotsOperation::Start => {
            let _guard = lock.lock().await;
            let id = {
                let db = node.db.lock();
                let dispatch = require(&db, request)?;
                if dispatch.fenced {
                    return Ok(dispatch.status());
                }
                current(&dispatch, request)?;
                if dispatch.state != "prepared" {
                    return start_status(&dispatch);
                }
                session(&db, request, &dispatch)?
            };
            let prepared = require(&node.db.lock(), request)?;
            let delivery = Delivery {
                custom_type: "pots-dispatch".into(),
                content: prepared.content.ok_or_else(ApiError::internal)?,
                details: Some(
                    serde_json::from_value(json!({
                        "dispatchId": request.dispatch_id, "bindingId": request.binding_id,
                        "generation": request.generation,
                    }))
                    .expect("object"),
                ),
                role: None,
                model: None,
                thinking: None,
            };
            let delivered = node
                .runners
                .deliver_checked(&id, &delivery, || {
                    Ok(claim_send(&node.db.lock(), request)?.is_some())
                })
                .await;
            let db = node.db.lock();
            db.execute("UPDATE pots_dispatches SET state=?3 WHERE owner=?1 AND dispatch_id=?2 AND state='sending'",
                params![request.user, request.dispatch_id, if delivered.is_ok() { "delivered" } else { "uncertain" }])?;
            let dispatch = require(&db, request)?;
            if dispatch.state == "prepared" {
                delivered?;
            }
            start_status(&dispatch)
        }
        PotsOperation::Control { action } => {
            // Fence first, WITHOUT the dispatch mutex: startup can take time.
            let dispatch = fence(&node.db.lock(), request)?;
            if dispatch.state == "stopped" {
                return Ok(dispatch.status());
            }
            if *action == PotsControl::TakeOver {
                return Ok(dispatch.status());
            }
            let _guard = lock.lock().await;
            let id = {
                let db = node.db.lock();
                let latest = require(&db, request)?;
                current(&latest, request)?;
                if latest.session.is_some() {
                    Some(session(&db, request, &latest)?)
                } else {
                    None
                }
            };
            if let Some(id) = id {
                node.runners
                    .stop_session_checked(&id, || {
                        let db = node.db.lock();
                        let latest = require(&db, request)?;
                        current(&latest, request)?;
                        session(&db, request, &latest).map(|_| ())
                    })
                    .await?;
            }
            let db = node.db.lock();
            // Do not let an older Stop report success over a newer generation.
            current(&require(&db, request)?, request)?;
            db.execute(
                "UPDATE pots_dispatches SET state='stopped' WHERE owner=?1 AND dispatch_id=?2",
                params![request.user, request.dispatch_id],
            )?;
            Ok(require(&db, request)?.status())
        }
    }
}

fn start_status(dispatch: &Dispatch) -> ApiResult<Value> {
    if matches!(dispatch.state.as_str(), "sending" | "uncertain") {
        return Err(ApiError::new(
            409,
            "dispatch_uncertain",
            "Dispatch outcome is uncertain; it will not be sent again",
        )
        .with_details(dispatch.status()));
    }
    Ok(dispatch.status())
}

pub(crate) async fn handle(node: &Node, request: PotsRequest) -> NodeHttpResponse {
    match execute(node, &request).await {
        Ok(body) => NodeHttpResponse {
            status: 200,
            body: Some(body),
        },
        Err(error) => NodeHttpResponse {
            status: error.status,
            body: Some(error.body()),
        },
    }
}

#[cfg(test)]
#[path = "pots_tests.rs"]
mod tests;
