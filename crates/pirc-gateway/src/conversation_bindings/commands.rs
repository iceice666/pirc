//! Admission preconditions, not an acknowledgement of installed Node policy.
//! Captured identities survive retries; receipts never dispatch work again.
use super::Binding;
use crate::{
    db::{Command, Session, Store, atomic},
    error::{ApiError, ApiResult},
    util::payload_hash,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

fn changed(current: &Binding) -> ApiError {
    ApiError::new(
        409,
        "stale_environment",
        "The conversation environment changed; refresh it before starting this action",
    )
    .with_details(json!({"binding":current}))
}
pub fn receive(
    conn: &Connection,
    captured: &Session,
    user: &str,
    id: &str,
    payload: &Value,
    expected: Option<&Binding>,
) -> ApiResult<(Command, bool)> {
    atomic(conn, |tx| {
        let current = tx.claim_session(&captured.id, user, false)?;
        let (command, duplicate) =
            tx.receive_command(id, &captured.id, &payload_hash(payload), payload)?;
        if duplicate {
            let origin: Option<String> = tx
                .query_row(
                    "SELECT binding_json FROM command_environments WHERE command_id=?",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            if let (Some(origin), Some(expected)) = (origin, expected) {
                let origin: Binding =
                    serde_json::from_str(&origin).map_err(|_| ApiError::internal())?;
                if payload["type"] != "stop" && origin != *expected {
                    return Err(ApiError::new(
                        409,
                        "conflict",
                        "commandId was already used in a different conversation environment",
                    ));
                }
            }
            return Ok((command, true));
        }
        if current.binding != captured.binding {
            return Err(changed(&current.binding));
        }
        if payload["type"] != "stop" {
            match expected {
                Some(expected) if expected == &current.binding => {}
                Some(_) => return Err(changed(&current.binding)),
                None if current.binding.execution.generation == 1
                    && current.binding.membership.revision == 1 => {}
                None => {
                    return Err(ApiError::new(
                        409,
                        "environment_required",
                        "Refresh or update this client before starting work in a changed conversation environment",
                    ));
                }
            }
        }
        tx.execute(
            "INSERT INTO command_environments VALUES(?,?)",
            params![
                id,
                serde_json::to_string(&current.binding).map_err(|_| ApiError::internal())?
            ],
        )?;
        Ok((command, false))
    })
}

#[cfg(test)]
mod tests;
