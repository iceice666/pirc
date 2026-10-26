//! Owner/operation cancellation, including a request that beats allocation.
use super::*;
use crate::app::Deletions;
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Cancellation {
    operation_id: String,
    workspace_id: String,
    submission_hash: String,
    session_id: Option<String>,
    pub(super) complete: bool,
    last_error_code: Option<String>,
}
pub(super) fn read(db: &Connection, owner: &str, op: &str) -> ApiResult<Option<Cancellation>> {
    Ok(db.query_row("SELECT operation_id,workspace_id,submission_hash,session_id,complete,last_error_code FROM creation_cancellations WHERE owner_user=?1 AND operation_id=?2",params![owner,op],|r|Ok(Cancellation{operation_id:r.get(0)?,workspace_id:r.get(1)?,submission_hash:r.get(2)?,session_id:r.get(3)?,complete:r.get(4)?,last_error_code:r.get(5)?})).optional()?)
}
fn require_same(row: &Cancellation, input: &Input) -> ApiResult<()> {
    if row.workspace_id != input.workspace_id || row.submission_hash != input.submission_hash {
        return Err(ApiError::conflict(
            "Cancellation identity belongs to another submission",
        ));
    }
    Ok(())
}
pub(super) fn require_live(db: &Connection, owner: &str, input: &Input) -> ApiResult<()> {
    if let Some(row) = read(db, owner, &input.operation_id)? {
        require_same(&row, input)?;
        return Err(ApiError::new(
            409,
            "creation_cancelled",
            "The original creation was cancelled and cannot be replayed",
        ));
    }
    Ok(())
}
fn fence(db: &mut Connection, owner: &str, input: &Input) -> ApiResult<Cancellation> {
    input.validate()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(row) = read(&tx, owner, &input.operation_id)? {
        require_same(&row, input)?;
        tx.commit()?;
        return Ok(row);
    }
    let creation = super::read(&tx, owner, &input.operation_id)?;
    if let Some(row) = &creation {
        matches(row, input)?;
    }
    crate::checkpoints::continuation::require_workspace_owner(&tx, &input.workspace_id, owner)?;
    let session = creation.as_ref().map(|r| r.session_id.as_str());
    let stamp = now_ms();
    tx.execute("INSERT INTO creation_cancellations(owner_user,operation_id,workspace_id,submission_hash,session_id,complete,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",params![owner,input.operation_id,input.workspace_id,input.submission_hash,session,creation.is_none(),stamp])?;
    if let Some(session) = session {
        if tx
            .session_deletion(session)?
            .is_some_and(|d| d.owner_user != owner)
        {
            return Err(ApiError::forbidden("Conversation belongs to another user"));
        }
        // Also fence memory/tools immediately, even if allocation died before
        // publishing its session row. The identifier is Node-generated.
        tx.execute(
            "INSERT OR IGNORE INTO session_deletions VALUES(?1,?2,'deleting',?3)",
            params![session, owner, stamp],
        )?;
    }
    let row = read(&tx, owner, &input.operation_id)?.ok_or_else(ApiError::internal)?;
    tx.commit()?;
    Ok(row)
}
fn finish_reserved(node: &Node, owner: &str, op: &str) -> ApiResult<()> {
    let mut db = node.db.lock();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let original = super::read(&tx, owner, op)?.ok_or_else(ApiError::internal)?;
    if original.state != State::Reserved {
        return Err(ApiError::internal());
    }
    let path = node.config.sessions_dir.join(&original.session_id);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            // An interrupted allocation can leave only an empty directory.
            // Never recursively erase files a different writer added to it.
            std::fs::remove_dir(&path).map_err(|_| {
                ApiError::new(
                    409,
                    "creation_cleanup_blocked",
                    "Reserved storage contains unexpected data or cannot be removed",
                )
            })?;
            std::fs::File::open(&node.config.sessions_dir)
                .and_then(|f| f.sync_all())
                .map_err(|_| ApiError::internal())?;
        }
        _ => {
            return Err(ApiError::new(
                409,
                "creation_cleanup_blocked",
                "Reserved storage is not a trusted empty directory",
            ));
        }
    }
    tx.finish_session_deletion(&original.session_id)?;
    tx.commit()?;
    Ok(())
}
async fn finish(
    node: Node,
    owner: String,
    op: String,
    deletions: Arc<Deletions>,
) -> ApiResult<Cancellation> {
    let original = {
        let db = node.db.lock();
        super::read(&db, &owner, &op)?
    };
    let result = match original {
        Some(row) if row.state == State::Reserved => finish_reserved(&node, &owner, &op),
        Some(row) => {
            crate::app::delete_owned_session(
                node.clone(),
                row.session_id,
                owner.clone(),
                deletions,
                false,
            )
            .await
        }
        None => Ok(()),
    };
    let db = node.db.lock();
    match result {
        Ok(()) => {
            db.execute("UPDATE creation_cancellations SET complete=1,last_error_code=NULL,updated_at=?3 WHERE owner_user=?1 AND operation_id=?2",params![owner,op,now_ms()])?;
        }
        Err(error) => {
            db.execute("UPDATE creation_cancellations SET last_error_code=?3,updated_at=?4 WHERE owner_user=?1 AND operation_id=?2",params![owner,op,error.code,now_ms()])?;
        }
    }
    read(&db, &owner, &op)?.ok_or_else(ApiError::internal)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelInput {
    workspace_id: String,
    submission_hash: String,
}
pub(crate) async fn cancel(
    node: Node,
    request: Request,
    deletions: Arc<Deletions>,
) -> ApiResult<Response> {
    let op = request
        .param("id")
        .filter(|id| valid_id(id))
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    let body: CancelInput = request.parse_body()?;
    let input = Input {
        operation_id: op.clone(),
        workspace_id: body.workspace_id,
        submission_hash: body.submission_hash,
    };
    let row = fence(&mut node.db.lock(), &request.user, &input)?;
    let row = if row.complete {
        row
    } else {
        // Once the fence commits, client disconnect must not drop cleanup.
        tokio::spawn(finish(node, request.user, op, deletions))
            .await
            .map_err(|_| ApiError::internal())??
    };
    Ok(Response::json(json!({"cancellation":row})))
}
pub(crate) async fn status(node: Node, request: Request) -> ApiResult<Response> {
    let op = request
        .param("id")
        .filter(|id| valid_id(id))
        .ok_or_else(ApiError::invalid_input)?;
    let row = read(&node.db.lock(), &request.user, op)?
        .ok_or_else(|| ApiError::not_found("Cancellation not found"))?;
    Ok(Response::json(json!({"cancellation":row})))
}
#[cfg(test)]
mod tests;
