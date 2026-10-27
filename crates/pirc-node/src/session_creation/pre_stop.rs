//! A durable pre-admission Stop independent of allocation. This endpoint never
//! creates storage or aborts a runner. Once initial command intake has started,
//! callers must use the ordinary leased Stop path instead of claiming that a
//! pre-admission fence stopped work that might already be executing.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stop {
    operation_id: String,
    workspace_id: String,
    submission_hash: String,
    session_id: Option<String>,
    confirmed: bool,
}
fn read(db: &Connection, owner: &str, op: &str) -> ApiResult<Option<Stop>> {
    let row: Option<(String, String)> = db.query_row(
        "SELECT workspace_id,submission_hash FROM creation_pre_stops WHERE owner_user=?1 AND operation_id=?2",
        params![owner,op], |r|Ok((r.get(0)?,r.get(1)?)),
    ).optional()?;
    let Some((workspace_id, submission_hash)) = row else {
        return Ok(None);
    };
    let creation = super::read(db, owner, op)?;
    if creation
        .as_ref()
        .is_some_and(|c| c.workspace_id != workspace_id || c.submission_hash != submission_hash)
    {
        return Err(ApiError::conflict("Stopped creation identity changed"));
    }
    Ok(Some(Stop {
        operation_id: op.into(),
        workspace_id,
        submission_hash,
        session_id: creation.map(|c| c.session_id),
        confirmed: true,
    }))
}
fn require_same(row: &Stop, input: &Input) -> ApiResult<()> {
    if row.workspace_id != input.workspace_id || row.submission_hash != input.submission_hash {
        return Err(ApiError::conflict(
            "Stop identity belongs to another submission",
        ));
    }
    Ok(())
}
/// Allocation is still allowed: explicit continuation can prepare a blank
/// conversation after Stop. Its first-message identity must stay fenced.
pub(super) fn require_binding(db: &Connection, owner: &str, input: &Input) -> ApiResult<()> {
    if let Some(row) = read(db, owner, &input.operation_id)? {
        require_same(&row, input)?;
    }
    Ok(())
}
fn initial_intake(db: &Connection, owner: &str, op: &str) -> ApiResult<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM creation_initial_admissions WHERE owner_user=?1 AND operation_id=?2 AND command_id IS NOT NULL AND stop_confirmed=0)",
        params![owner,op], |r|r.get(0),
    )?)
}
/// Called while holding the allocation/admission write transaction. The Stop
/// either precedes command intake or refuses to impersonate an ordinary Stop.
pub(super) fn mirror(db: &Connection, owner: &str, creation: &Creation) -> ApiResult<()> {
    let Some(stop) = read(db, owner, &creation.operation_id)? else {
        return Ok(());
    };
    if stop.workspace_id != creation.workspace_id
        || stop.submission_hash != creation.submission_hash
    {
        return Err(ApiError::conflict("Stopped creation identity changed"));
    }
    if initial_intake(db, owner, &creation.operation_id)? {
        return Err(ApiError::new(
            409,
            "initial_admission_exists",
            "Initial admission already started; use the leased session Stop",
        ));
    }
    db.execute(
        "INSERT INTO creation_initial_admissions(owner_user,operation_id,session_id,stop_requested,stop_confirmed,created_at,updated_at) VALUES(?1,?2,?3,1,1,?4,?4) ON CONFLICT(owner_user,operation_id) DO UPDATE SET stop_requested=1,stop_confirmed=1,updated_at=excluded.updated_at",
        params![owner,creation.operation_id,creation.session_id,now_ms()],
    )?;
    Ok(())
}
fn fence(db: &mut Connection, owner: &str, input: &Input) -> ApiResult<Stop> {
    input.validate()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(stop) = read(&tx, owner, &input.operation_id)? {
        require_same(&stop, input)?;
        tx.commit()?;
        return Ok(stop);
    }
    if let Some(cancelled) = cancellation::read(&tx, owner, &input.operation_id)? {
        // Cancellation remains stronger; this API cannot rebind its identity.
        cancellation::require_same(&cancelled, input)?;
    }
    let creation = super::read(&tx, owner, &input.operation_id)?;
    if let Some(row) = &creation {
        matches(row, input)?;
    }
    crate::checkpoints::continuation::require_workspace_owner(&tx, &input.workspace_id, owner)?;
    if initial_intake(&tx, owner, &input.operation_id)? {
        return Err(ApiError::new(
            409,
            "initial_admission_exists",
            "Initial admission already started; use the leased session Stop",
        ));
    }
    if let Some(row) = &creation {
        let session_owner: Option<Option<String>> = tx
            .query_row(
                "SELECT owner_user FROM sessions WHERE id=?1",
                [&row.session_id],
                |r| r.get(0),
            )
            .optional()?;
        if session_owner.flatten().is_some_and(|s| s != owner)
            || tx
                .session_deletion(&row.session_id)?
                .is_some_and(|s| s.owner_user != owner)
        {
            return Err(ApiError::forbidden("Conversation belongs to another user"));
        }
    }
    tx.execute(
        "INSERT INTO creation_pre_stops VALUES(?1,?2,?3,?4,?5)",
        params![
            owner,
            input.operation_id,
            input.workspace_id,
            input.submission_hash,
            now_ms()
        ],
    )?;
    if let Some(creation) = &creation {
        mirror(&tx, owner, creation)?;
    }
    let stop = read(&tx, owner, &input.operation_id)?.ok_or_else(ApiError::internal)?;
    tx.commit()?;
    Ok(stop)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopInput {
    workspace_id: String,
    submission_hash: String,
}
pub(crate) async fn stop(node: Node, request: Request) -> ApiResult<Response> {
    let op = request
        .param("id")
        .filter(|s| valid_id(s))
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    let body: StopInput = request.parse_body()?;
    let input = Input {
        operation_id: op,
        workspace_id: body.workspace_id,
        submission_hash: body.submission_hash,
    };
    let stopped = fence(&mut node.db.lock(), &request.user, &input)?;
    Ok(Response::json(json!({"stop":stopped})))
}
pub(crate) async fn status(node: Node, request: Request) -> ApiResult<Response> {
    let op = request
        .param("id")
        .filter(|s| valid_id(s))
        .ok_or_else(ApiError::invalid_input)?;
    let stopped = read(&node.db.lock(), &request.user, op)?
        .ok_or_else(|| ApiError::not_found("Creation Stop not found"))?;
    Ok(Response::json(json!({"stop":stopped})))
}
#[cfg(test)]
mod tests;
