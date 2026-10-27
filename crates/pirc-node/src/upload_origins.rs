//! Saved upload origins and their existing access rules. A source workspace is
//! not re-derived from a conversation's current location and is not a live mount.
use crate::{
    error::{ApiError, ApiResult},
    services::Node,
    store::{Store, UploadRow},
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::{fs::File, io::Read, path::Path};

struct Origin {
    scope: String,
    node_id: Option<String>,
    mode_id: Option<String>,
    upload: UploadRow,
}
struct StoredOrigin {
    version: i64,
    scope: String,
    node_id: Option<String>,
    mode_id: Option<String>,
    upload_json: String,
}
fn origin(db: &Connection, id: &str) -> ApiResult<Option<Origin>> {
    let row = db.query_row(
        "SELECT version,scope,node_id,mode_id,upload_json FROM upload_origins WHERE upload_id=?",
        [id], |r| Ok(StoredOrigin {version:r.get(0)?,scope:r.get(1)?,node_id:r.get(2)?,mode_id:r.get(3)?,upload_json:r.get(4)?}),
    ).optional()?;
    row.map(|row| {
        if row.version != 1 {
            return Err(unavailable());
        }
        Ok(Origin {
            scope: row.scope,
            node_id: row.node_id,
            mode_id: row.mode_id,
            upload: serde_json::from_str(&row.upload_json).map_err(|_| unavailable())?,
        })
    })
    .transpose()
}
fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "attachment_storage_unavailable",
        "The saved attachment could not be verified; its content was not substituted",
    )
}

/// Shared by Agent attachment consumption and the authenticated metadata route.
/// The old owner/workspace exception and first-send session restriction remain.
pub fn authorize(db: &Connection, session_id: &str, user: &str, id: &str) -> ApiResult<UploadRow> {
    let session = db.claim_session(session_id, user, false)?;
    db.get_workspace(&session.workspace_id)?;
    let upload = db.get_upload(id)?;
    if upload.owner_user != user {
        return Err(ApiError::forbidden("Upload belongs to another user"));
    }
    if upload
        .workspace_id
        .as_ref()
        .is_some_and(|w| *w != session.workspace_id)
    {
        return Err(ApiError::forbidden("Upload belongs to another workspace"));
    }
    if let Some(origin) = origin(db, id)? {
        if origin.upload != upload {
            return Err(unavailable());
        }
        if origin.scope == "conversation" && upload.session_id.as_deref() != Some(session_id) {
            return Err(ApiError::forbidden(
                "First-send attachment belongs to another conversation",
            ));
        }
    }
    // Retain the additional legacy check, including pre-migration first sends.
    let other: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM creation_uploads WHERE upload_id=?1 AND session_id!=?2)",
        rusqlite::params![id, session_id],
        |r| r.get(0),
    )?;
    if other {
        return Err(ApiError::forbidden(
            "First-send attachment belongs to another conversation",
        ));
    }
    Ok(upload)
}

pub fn reference(db: &Connection, session: &str, user: &str, id: &str) -> ApiResult<Value> {
    let upload = authorize(db, session, user, id)?;
    let origin = origin(db, id)?;
    let (provenance, scope, node, mode) = match &origin {
        Some(origin) => (
            "recorded",
            origin.scope.as_str(),
            origin.node_id.as_deref(),
            origin.mode_id.as_deref(),
        ),
        None => (
            "legacy",
            if upload.workspace_id.is_some() {
                "workspace"
            } else {
                "legacy_owner"
            },
            None,
            None,
        ),
    };
    let first_send: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM creation_uploads WHERE upload_id=?)",
        [id],
        |r| r.get(0),
    )?;
    let scope = if first_send { "conversation" } else { scope };
    Ok(json!({"version":1,"kind":"saved_attachment","id":id,
        "mimeType":upload.mime_type,"byteSize":upload.byte_size,"sha256":upload.sha256,"filename":upload.filename,
        "provenance":provenance,"scope":scope,
        "origin":{"nodeId":node,"workspaceId":upload.workspace_id,"sessionId":upload.session_id,"modeId":mode}}))
}

pub async fn get_reference(
    node: Node,
    request: crate::router::Request,
) -> ApiResult<crate::router::Response> {
    let value = reference(
        &node.db.lock(),
        request.param("id").unwrap_or_default(),
        &request.user,
        request.param("uploadId").unwrap_or_default(),
    )?;
    Ok(crate::router::Response::json(json!({"reference":value})))
}

/// Read an immutable saved object through the storage directory, never a live
/// workspace path. A replaced file/symlink or changed bytes cannot impersonate it.
pub fn read_verified(root: &Path, upload: &UploadRow) -> ApiResult<Vec<u8>> {
    use rustix::fs::{CWD, Mode, OFlags, openat};
    let name = &upload.storage_name;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
        || upload.byte_size < 0
    {
        return Err(unavailable());
    }
    let dir = openat(
        CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| unavailable())?;
    let fd = openat(
        &dir,
        name.as_str(),
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| unavailable())?;
    let file = File::from(fd);
    let metadata = file.metadata().map_err(|_| unavailable())?;
    let size = upload.byte_size as u64;
    if !metadata.is_file() || metadata.len() != size {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    file.take(size.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 != size || crate::util::sha256_hex(&bytes) != upload.sha256 {
        return Err(unavailable());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
