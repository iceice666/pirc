//! Owner-scoped metadata for saved Node attachments. The Node's private session
//! IDs and storage names never enter the public content reference.
use crate::{
    app::AppState,
    auth::Identity,
    db::Store,
    error::{ApiError, ApiResult},
};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use pirc_protocol::HttpMethod;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Origin {
    node_id: Option<String>,
    workspace_id: Option<String>,
    session_id: Option<String>,
    mode_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    version: u8,
    kind: String,
    id: String,
    mime_type: String,
    byte_size: u64,
    sha256: String,
    filename: Option<String>,
    provenance: String,
    scope: String,
    origin: Origin,
}

fn public(
    db: &rusqlite::Connection,
    node: &str,
    user: &str,
    id: &str,
    raw: Value,
) -> ApiResult<Value> {
    let r: Reference = serde_json::from_value(raw).map_err(|_| ApiError::internal())?;
    if r.version != 1
        || r.kind != "saved_attachment"
        || r.id != id
        || !["recorded", "legacy"].contains(&r.provenance.as_str())
        || !["workspace", "conversation", "legacy_owner"].contains(&r.scope.as_str())
        || r.origin.node_id.as_deref().is_some_and(|n| n != node)
    {
        return Err(ApiError::internal());
    }
    let source_session = if let Some(private) = r.origin.session_id {
        db.resolve_remote_session(node, &private)?.filter(|id| {
            db.get_session(id)
                .is_ok_and(|s| s.owner_user.as_deref() == Some(user))
        })
    } else {
        None
    };
    Ok(
        json!({"version":r.version,"kind":r.kind,"id":r.id,"mimeType":r.mime_type,"byteSize":r.byte_size,"sha256":r.sha256,"filename":r.filename,"provenance":r.provenance,"scope":r.scope,
        "origin":{"nodeId":r.origin.node_id,"workspaceId":r.origin.workspace_id.map(|w|format!("{node}:{w}")),"sessionId":source_session,"modeId":r.origin.mode_id}}),
    )
}

pub async fn get(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path((session, id)): Path<(String, String)>,
) -> crate::routes::Handled {
    use axum::response::IntoResponse;
    let claimed = app.claim(&identity, &session)?;
    let result = app
        .relay(
            &claimed.node_id,
            &identity,
            HttpMethod::Get,
            format!(
                "/api/sessions/{}/uploads/{}/reference",
                crate::routes::urlencoding_component(&claimed.pi_session_id),
                crate::routes::urlencoding_component(&id)
            ),
            None,
        )
        .await?;
    if result.status != 200 {
        return Ok(crate::app::forward(result));
    }
    let current = app.claim(&identity, &session)?;
    if current.node_id != claimed.node_id
        || current.pi_session_id != claimed.pi_session_id
        || current.session.binding != claimed.session.binding
    {
        return Err(ApiError::new(
            409,
            "stale_environment",
            "The conversation environment changed; refresh it before opening this attachment",
        )
        .into());
    }
    let raw = result
        .body
        .and_then(|mut v| v.get_mut("reference").map(Value::take))
        .ok_or_else(ApiError::internal)?;
    let reference = public(&app.db.lock(), &claimed.node_id, &identity.user, &id, raw)?;
    if reference["origin"]["workspaceId"]
        .as_str()
        .is_some_and(|workspace| workspace != current.session.workspace_id)
    {
        return Err(ApiError::new(409,"stale_environment","The attachment's source workspace does not match this conversation's current environment").into());
    }
    Ok(Json(json!({"reference":reference})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    fn raw(id: &str, private: &str) -> Value {
        json!({"version":1,"kind":"saved_attachment","id":id,"mimeType":"text/plain","byteSize":4,"sha256":"a".repeat(64),"filename":"notes.txt","provenance":"recorded","scope":"workspace","origin":{"nodeId":"node","workspaceId":"repo","sessionId":private,"modeId":"directory"}})
    }
    #[test]
    fn public_reference_never_exposes_private_or_other_users_session_identity() {
        let db = Db::memory();
        let db = db.lock();
        db.sync_remote_workspaces(
            "node",
            &[(
                "repo".into(),
                "Repo".into(),
                pirc_protocol::ModeId::new("directory").unwrap(),
            )],
        )
        .unwrap();
        let session = db
            .create_session(
                "node:repo",
                "node://node/private",
                "node",
                "private",
                "alice",
            )
            .unwrap();
        let reference = public(&db, "node", "alice", "file", raw("file", "private")).unwrap();
        assert_eq!(reference["origin"]["sessionId"], session.id);
        assert_eq!(reference["origin"]["workspaceId"], "node:repo");
        assert!(!reference.to_string().contains("private"));
        assert!(public(&db,"node","bob","file",raw("file","private")).unwrap()["origin"]["sessionId"].is_null());
        assert!(public(&db,"node","alice","file",raw("file","gone")).unwrap()["origin"]["sessionId"].is_null());
        assert!(public(&db, "other-node", "alice", "file", raw("file", "private")).is_err());
        assert!(public(&db, "node", "alice", "different", raw("file", "private")).is_err());
        let mut private = raw("file", "private");
        private["storageName"] = json!("secret.bin");
        assert!(public(&db, "node", "alice", "file", private).is_err());
    }
}
