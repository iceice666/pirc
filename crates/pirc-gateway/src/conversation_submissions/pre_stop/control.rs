//! Distinct from the Node command lease: this grants only pending-input Stop.
use super::*;
const DURATION_MS: i64 = 30_000;
const SCOPE: &str = "pending_first_send_stop";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Held {
    client_id: String,
    generation: i64,
}
impl Held {
    pub(super) fn validate(&self) -> ApiResult<()> {
        if !bounded(&self.client_id, 200) || self.generation <= 0 {
            Err(ApiError::invalid_input())
        } else {
            Ok(())
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acquire {
    client_id: String,
    #[serde(default)]
    force: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    client_id: String,
    generation: i64,
    expires_at: i64,
}
fn read(db: &Connection, owner: &str, op: &str) -> ApiResult<Option<Lease>> {
    Ok(db.query_row("SELECT client_id,generation,expires_at FROM conversation_submission_stop_controls WHERE owner_user=?1 AND operation_id=?2",params![owner,op],|r|Ok(Lease{client_id:r.get(0)?,generation:r.get(1)?,expires_at:r.get(2)?})).optional()?)
}
pub(super) fn require_held(db: &Connection, owner: &str, op: &str, input: &Held) -> ApiResult<()> {
    if read(db, owner, op)?.is_some_and(|l| {
        l.client_id == input.client_id
            && l.generation == input.generation
            && l.expires_at > now_ms()
    }) {
        Ok(())
    } else {
        Err(ApiError::new(
            409,
            "control_lost",
            "Acquire current pending-input Stop control first",
        ))
    }
}
pub(super) fn expire(db: &Connection, owner: &str, op: &str) -> ApiResult<()> {
    db.execute("UPDATE conversation_submission_stop_controls SET expires_at=0 WHERE owner_user=?1 AND operation_id=?2",params![owner,op])?;
    Ok(())
}
fn acquire(app: &AppState, identity: &Identity, op: &str, input: &Acquire) -> ApiResult<Lease> {
    if !bounded(&input.client_id, 200) {
        return Err(ApiError::invalid_input());
    }
    let mut db = app.db.lock();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = owned(app, &tx, identity, op)?;
    require_unmapped(&tx, &row)?;
    let previous = read(&tx, &identity.user, op)?;
    let stamp = now_ms();
    if previous
        .as_ref()
        .is_some_and(|p| p.expires_at > stamp && p.client_id != input.client_id)
        && !input.force
    {
        return Err(ApiError::new(
            409,
            "control_held",
            "Another client holds pending-input Stop control",
        ));
    }
    let generation = match previous {
        Some(p) if p.expires_at > stamp && p.client_id == input.client_id => p.generation,
        Some(p) => p.generation.checked_add(1).ok_or_else(ApiError::internal)?,
        None => 1,
    };
    let lease = Lease {
        client_id: input.client_id.clone(),
        generation,
        expires_at: stamp.saturating_add(DURATION_MS),
    };
    tx.execute("INSERT INTO conversation_submission_stop_controls VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner_user,operation_id) DO UPDATE SET client_id=excluded.client_id,generation=excluded.generation,expires_at=excluded.expires_at",params![identity.user,op,lease.client_id,lease.generation,lease.expires_at])?;
    tx.commit()?;
    Ok(lease)
}
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/conversation-submissions/{id}/stop-control",
            get(status),
        )
        .route(
            "/api/conversation-submissions/{id}/stop-control/acquire",
            post(take),
        )
        .route(
            "/api/conversation-submissions/{id}/stop-control/release",
            post(release),
        )
}
async fn take(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(op): Path<String>,
    ReqBody(body): ReqBody,
) -> ApiResult<axum::Json<Value>> {
    if !valid_id(&op) {
        return Err(ApiError::invalid_input());
    }
    let input: Acquire = body.parse()?;
    Ok(axum::Json(
        json!({"scope":SCOPE,"lease":acquire(&app,&identity,&op,&input)?}),
    ))
}
async fn status(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(op): Path<String>,
) -> ApiResult<axum::Json<Value>> {
    if !valid_id(&op) {
        return Err(ApiError::invalid_input());
    }
    let db = app.db.lock();
    let row = owned(&app, &db, &identity, &op)?;
    Ok(axum::Json(
        json!({"scope":SCOPE,"available":require_unmapped(&db,&row).is_ok(),"lease":read(&db,&identity.user,&op)?}),
    ))
}
async fn release(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(op): Path<String>,
    ReqBody(body): ReqBody,
) -> ApiResult<axum::Json<Value>> {
    if !valid_id(&op) {
        return Err(ApiError::invalid_input());
    }
    let input: Held = body.parse()?;
    input.validate()?;
    let mut db = app.db.lock();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    owned(&app, &tx, &identity, &op)?;
    require_held(&tx, &identity.user, &op, &input)?;
    expire(&tx, &identity.user, &op)?;
    tx.commit()?;
    Ok(axum::Json(json!({"scope":SCOPE,"lease":null})))
}
