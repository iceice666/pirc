//! Frozen cooperative write ranges for known approved host commands. These
//! are not kernel containment: arbitrary host code can access other paths too.
use crate::{
    error::{ApiError, ApiResult},
    write_broker::paths_overlap,
};
use rusqlite::{Connection, params};
use std::path::Path;

pub(crate) struct Writer<'a> {
    pub session: &'a str,
    pub epoch: i64,
    pub incarnation: &'a str,
    pub active_runs: Vec<String>,
}
fn pending() -> ApiError {
    ApiError::new(
        409,
        "host_write_pending",
        "An approved host command still holds write access, or its outcome is unresolved; reconcile its session before writing",
    )
}
const PENDING: &str = "h.state IN ('launching','running','unconfirmed')";

/// Caller holds the admission DB lock until its write lease or host reservation
/// is recorded. A current live owner may reuse its own ranges; a later runner,
/// restart or uncertain observation cannot inherit those old claims.
pub(crate) fn require_available(
    db: &Connection,
    path: &Path,
    writer: Option<Writer<'_>>,
) -> ApiResult<()> {
    let mut statement=db.prepare(&format!("SELECT h.session_id,h.runner_epoch,h.incarnation,h.state,r.paths_json,h.id FROM host_command_runs h LEFT JOIN host_command_resources r ON r.run_id=h.id WHERE {PENDING}"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let stored: Option<String> = row.get(4)?;
        let Some(stored) = stored else {
            return Err(pending());
        };
        let paths: Vec<String> = serde_json::from_str(&stored).map_err(|_| pending())?;
        if paths.is_empty() || paths.iter().any(|p| !Path::new(p).is_absolute()) {
            return Err(pending());
        }
        if !paths.iter().any(|p| paths_overlap(Path::new(p), path)) {
            continue;
        }
        let same = if let Some(writer) = &writer {
            row.get::<_, String>(0)? == writer.session
                && row.get::<_, i64>(1)? == writer.epoch
                && row.get::<_, String>(2)? == writer.incarnation
                && row.get::<_, String>(3)? != "unconfirmed"
                && writer.active_runs.contains(&row.get::<_, String>(5)?)
        } else {
            false
        };
        if !same {
            return Err(pending());
        }
    }
    Ok(())
}
pub(crate) fn record(db: &Connection, id: &str, paths: &[String]) -> ApiResult<()> {
    if paths.is_empty() || paths.iter().any(|path| !Path::new(path).is_absolute()) {
        return Err(ApiError::internal());
    }
    db.execute(
        "INSERT INTO host_command_resources(run_id,paths_json) VALUES(?1,?2)",
        params![
            id,
            serde_json::to_string(paths).map_err(|_| ApiError::internal())?
        ],
    )?;
    Ok(())
}
pub(crate) fn holders(db: &Connection) -> ApiResult<Vec<String>> {
    let mut statement=db.prepare(&format!("SELECT DISTINCT h.session_id FROM host_command_runs h WHERE {PENDING} ORDER BY h.session_id"))?;
    Ok(statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}
