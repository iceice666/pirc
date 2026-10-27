//! Durable sandbox launch evidence, not a complete environment revocation proof.
//! Reservation commits before spawn; only a failed spawn can be `not_started`.
//! Missing observations remain unresolved across Node restart and session deletion.
use crate::{
    error::{ApiError, ApiResult},
    sandbox::processes::{Identity, Snapshot, State},
    services::Node,
    store::Store,
    util::{now_ms, prefix_uuid},
};
use futures_util::{StreamExt, stream};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug)]
pub(crate) struct Launch {
    id: String,
    pub session: String,
    epoch: i64,
    incarnation: String,
}
#[derive(Clone, Default, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub launches: u64,
    pub terminated: u64,
    pub not_started: u64,
    pub unresolved: u64,
    pub legacy_untracked: u64,
}

pub(crate) fn reserve(
    db: &Connection,
    session: &str,
    workspace: &str,
    epoch: i64,
    incarnation: &str,
) -> ApiResult<Launch> {
    db.require_session_available(session)?;
    crate::execution_fences::require_open(db, session)?;
    let current = db.get_session(session)?;
    if current.runner_epoch != epoch || current.workspace_id != workspace {
        return Err(ApiError::conflict("Sandbox launch environment changed"));
    }
    let launch = Launch {
        id: prefix_uuid("launch_"),
        session: session.into(),
        epoch,
        incarnation: incarnation.into(),
    };
    let now = now_ms();
    db.execute(
        "INSERT INTO sandbox_launches VALUES(?1,?2,?3,?4,?5,'launching',NULL,?6,?6)",
        params![launch.id, session, workspace, epoch, incarnation, now],
    )?;
    Ok(launch)
}
fn saved(db: &Connection, launch: &Launch) -> ApiResult<(String, Option<String>)> {
    db.query_row("SELECT state,identity_json FROM sandbox_launches WHERE launch_id=?1 AND session_id=?2 AND runner_epoch=?3 AND incarnation=?4",
        params![launch.id,launch.session,launch.epoch,launch.incarnation], |r| Ok((r.get(0)?,r.get(1)?)))
        .optional()?.ok_or_else(ApiError::internal)
}
pub(crate) fn not_started(db: &Connection, launch: &Launch) -> ApiResult<()> {
    let (state, identity) = saved(db, launch)?;
    if state == "not_started" {
        return Ok(());
    }
    if state != "launching" || identity.is_some() {
        return Err(ApiError::internal());
    }
    db.execute(
        "UPDATE sandbox_launches SET state='not_started',updated_at=?2 WHERE launch_id=?1",
        params![launch.id, now_ms()],
    )?;
    Ok(())
}
pub(crate) fn observe(db: &Connection, launch: &Launch, snapshot: &Snapshot) -> ApiResult<()> {
    let (state, identity) = saved(db, launch)?;
    let next = snapshot
        .identity
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| ApiError::internal())?;
    if identity.is_some() && next.is_some() && identity != next {
        return Err(ApiError::conflict("Sandbox kernel identity changed"));
    }
    if matches!(
        state.as_str(),
        "terminated" | "not_started" | "legacy_untracked"
    ) {
        return Ok(());
    }
    let has_observed_identity = next.is_some();
    let next = identity.or(next);
    // Termination without a captured identity is not kernel evidence.
    let state = match (snapshot.state, has_observed_identity) {
        (State::Terminated, true) => "terminated",
        (State::Running, true) => "running",
        _ => "unconfirmed",
    };
    db.execute(
        "UPDATE sandbox_launches SET state=?2,identity_json=?3,updated_at=?4 WHERE launch_id=?1",
        params![launch.id, state, next, now_ms()],
    )?;
    Ok(())
}
pub(crate) fn summary(db: &Connection, session: &str) -> ApiResult<Summary> {
    Ok(db.query_row("SELECT count(*),coalesce(sum(state='terminated'),0),coalesce(sum(state='not_started'),0),coalesce(sum(state NOT IN ('terminated','not_started')),0),coalesce(sum(state='legacy_untracked'),0) FROM sandbox_launches WHERE session_id=?1",[session], |r| Ok(Summary {
        launches:r.get(0)?,terminated:r.get(1)?,not_started:r.get(2)?,unresolved:r.get(3)?,legacy_untracked:r.get(4)?,
    }))?)
}

/// Reconciliation is performed only within an accepted, durable transition fence.
/// Batch old launches so a very large history does not monopolize a drain. Missing
/// identities are deliberately left unresolved, never converted to successful exit.
fn pending(db: &Connection, session: &str) -> ApiResult<Vec<(Launch, Identity)>> {
    let fenced: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM execution_fences WHERE session_id=?1 AND state!='deleted')",
        [session],
        |r| r.get(0),
    )?;
    if !fenced {
        return Err(ApiError::conflict(
            "Sandbox reconciliation requires a transition fence",
        ));
    }
    let mut statement = db.prepare("SELECT launch_id,runner_epoch,incarnation,identity_json FROM sandbox_launches WHERE session_id=?1 AND state IN ('running','unconfirmed','launching') AND identity_json IS NOT NULL ORDER BY updated_at,rowid LIMIT 64")?;
    let rows = statement.query_map([session], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, epoch, incarnation, identity) = row?;
        let identity = serde_json::from_str(&identity).map_err(|_| ApiError::internal())?;
        out.push((
            Launch {
                id,
                session: session.into(),
                epoch,
                incarnation,
            },
            identity,
        ));
    }
    Ok(out)
}

pub(crate) async fn retire_saved(node: &Node, session: &str) -> ApiResult<()> {
    let rows = pending(&node.db.lock(), session)?;
    let mut work = stream::iter(rows)
        .map(|(launch, identity)| async move {
            let state = crate::sandbox::linux::processes::retire_saved(&identity).await;
            (
                launch,
                Snapshot {
                    state,
                    identity: Some(identity),
                },
            )
        })
        .buffer_unordered(4);
    while let Some((launch, snapshot)) = work.next().await {
        observe(&node.db.lock(), &launch, &snapshot)?;
    }
    Ok(())
}
