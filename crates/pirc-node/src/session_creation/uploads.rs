//! Durable attachment transfer, scoped to the original creation/owner and body.
//! This stores a file, not a message or execution grant. Gateway adoption stays
//! gated until acceptance, control authority and admission reconciliation exist.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path as FsPath, PathBuf};

use super::*;
use crate::router::Body;
use crate::store::UploadRow;
use crate::util::{hex, payload_hash, random_bytes, sha256_hex};

#[derive(Debug)]
struct Record {
    hash: String,
    ready: bool,
    upload_id: String,
    upload: Option<UploadRow>,
}
struct TransferInput {
    submission_hash: String,
    name: String,
    mime: String,
    size: u64,
    digest: String,
}
fn storage_error() -> ApiError {
    ApiError::new(
        503,
        "attachment_storage_unavailable",
        "Attachment storage is unavailable; keep the original submission and reconcile the same transfer",
    )
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl TransferInput {
    fn parse(request: &Request, content_type: &str) -> ApiResult<Self> {
        let mut query = serde_json::Map::new();
        for (key, value) in &request.query {
            if ![
                "submissionHash",
                "sha256",
                "byteSize",
                "filename",
                "mimeType",
            ]
            .contains(&key.as_str())
                || query.insert(key.clone(), json!(value)).is_some()
            {
                return Err(ApiError::invalid_input());
            }
        }
        let value = |key: &str| {
            query
                .get(key)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(ApiError::invalid_input)
        };
        // JSON files must bypass the router's JSON parser. New Gateway peers
        // transport raw octets and bind their real MIME in the immutable query.
        let mime = match query.get("mimeType") {
            Some(mime) if content_type == "application/octet-stream" => {
                mime.as_str().ok_or_else(ApiError::invalid_input)?
            }
            Some(_) => return Err(ApiError::invalid_input()),
            None => content_type,
        };
        let input = Self {
            submission_hash: value("submissionHash")?.into(),
            name: value("filename")?.into(),
            mime: mime.into(),
            size: value("byteSize")?
                .parse()
                .map_err(|_| ApiError::invalid_input())?,
            digest: value("sha256")?.into(),
        };
        let mime = input.mime.split_once('/');
        if !valid_hash(&input.submission_hash)
            || !valid_hash(&input.digest)
            || input.name.encode_utf16().count() > 255
            || crate::chat::js_trim(&input.name).is_empty()
            || input.name.contains(['\0', '/', '\\'])
            || input.mime.len() > 127
            || !mime.is_some_and(|(a, b)| {
                !a.is_empty()
                    && !b.is_empty()
                    && a.bytes()
                        .chain(b.bytes())
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
            })
        {
            return Err(ApiError::invalid_input());
        }
        Ok(input)
    }
    fn hash(&self) -> String {
        payload_hash(
            &json!({"submissionHash":self.submission_hash,"name":self.name,"mimeType":self.mime,"byteSize":self.size,"sha256":self.digest}),
        )
    }
}
fn read(
    db: &Connection,
    owner: &str,
    operation: &str,
    attachment: &str,
) -> ApiResult<Option<Record>> {
    Ok(db.query_row("SELECT request_hash,state,upload_json,upload_id FROM creation_uploads WHERE owner_user=?1 AND operation_id=?2 AND attachment_id=?3",params![owner,operation,attachment],|r|{
        let raw:Option<String>=r.get(2)?;
        let upload=raw.map(|raw|serde_json::from_str(&raw)).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?;
        let state:String=r.get(1)?;
        Ok(Record{hash:r.get(0)?,ready:state=="ready",upload_id:r.get(3)?,upload})
    }).optional()?)
}
fn parent(db: &Connection, owner: &str, operation: &str) -> ApiResult<Creation> {
    let creation = super::read(db, owner, operation)?
        .ok_or_else(|| ApiError::not_found("Conversation creation not found"))?;
    current(db, owner, creation)
}
fn matches(record: &Record, input: &TransferInput) -> ApiResult<()> {
    if record.hash != input.hash() {
        return Err(ApiError::conflict(
            "Attachment transfer identity belongs to different content or metadata",
        ));
    }
    Ok(())
}
fn reserve(
    db: &mut Connection,
    owner: &str,
    operation: &str,
    attachment: &str,
    input: &TransferInput,
    bytes: &[u8],
) -> ApiResult<Record> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let creation = parent(&tx, owner, operation)?;
    if creation.submission_hash != input.submission_hash {
        return Err(ApiError::conflict("Submission identity changed"));
    }
    if matches!(creation.state, State::Deleting | State::Deleted) {
        return Err(ApiError::conflict(
            "Conversation was deleted; the transfer cannot be replayed",
        ));
    }
    if creation.state != State::Ready {
        return Err(ApiError::conflict("Conversation storage is not ready"));
    }
    if let Some(record) = read(&tx, owner, operation, attachment)? {
        matches(&record, input)?;
        if record.upload.is_none() {
            return Err(ApiError::conflict("Attachment transfer was deleted"));
        }
        tx.commit()?;
        return Ok(record);
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM creation_uploads WHERE owner_user=?1 AND operation_id=?2",
        params![owner, operation],
        |r| r.get(0),
    )?;
    if count >= 16 {
        return Err(ApiError::bad_request(
            "At most 16 attachments are allowed for a first submission",
        ));
    }
    let (mime_type, kind, filename) =
        crate::app::classify_upload(bytes, &input.mime, Some(crate::chat::js_trim(&input.name)))?;
    let upload = UploadRow {
        id: prefix_uuid("upload"),
        owner_user: owner.into(),
        mime_type,
        byte_size: input.size as i64,
        storage_name: format!("{}.bin", hex(&random_bytes::<24>())),
        sha256: input.digest.clone(),
        kind,
        filename,
        workspace_id: Some(creation.workspace_id),
        session_id: Some(creation.session_id.clone()),
    };
    tx.execute("INSERT INTO creation_uploads(owner_user,operation_id,attachment_id,session_id,upload_id,request_hash,upload_json,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'reserved',?8)",params![owner,operation,attachment,creation.session_id,upload.id,input.hash(),serde_json::to_string(&upload).map_err(|_|ApiError::internal())?,now_ms()])?;
    tx.commit()?;
    Ok(Record {
        hash: input.hash(),
        ready: false,
        upload_id: upload.id.clone(),
        upload: Some(upload),
    })
}
fn root(path: &FsPath) -> ApiResult<PathBuf> {
    let root = path.canonicalize().map_err(|_| storage_error())?;
    let metadata = fs::symlink_metadata(&root).map_err(|_| storage_error())?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o022 != 0 {
        return Err(storage_error());
    }
    Ok(root)
}
fn verified_file(path: &FsPath, upload: &UploadRow) -> ApiResult<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| storage_error())?;
    let meta = file.metadata().map_err(|_| storage_error())?;
    if !meta.is_file()
        || meta.len() != upload.byte_size as u64
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err(storage_error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(upload.byte_size as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error())?;
    if bytes.len() as i64 != upload.byte_size || sha256_hex(&bytes) != upload.sha256 {
        return Err(storage_error());
    }
    file.sync_all().map_err(|_| storage_error())?;
    Ok(())
}
fn write_file(root: &FsPath, record: &Record, bytes: &[u8]) -> ApiResult<()> {
    let upload = record
        .upload
        .as_ref()
        .ok_or_else(|| ApiError::conflict("Attachment transfer was deleted"))?;
    if !crate::app::storage_name(&upload.storage_name) {
        return Err(storage_error());
    }
    let target = root.join(&upload.storage_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            verified_file(&target, upload)?;
            File::open(root)
                .and_then(|f| f.sync_all())
                .map_err(|_| storage_error())?;
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    if record.ready {
        return Err(storage_error());
    }
    let partial = root.join(format!("{}.part", upload.storage_name));
    let mut out = match OpenOptions::new()
        .read(true)
        .append(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&partial)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => OpenOptions::new()
            .read(true)
            .append(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&partial)
            .map_err(|_| storage_error())?,
        Err(_) => return Err(storage_error()),
    };
    let meta = out.metadata().map_err(|_| storage_error())?;
    if !meta.is_file() || meta.len() > bytes.len() as u64 || meta.permissions().mode() & 0o077 != 0
    {
        return Err(storage_error());
    }
    let mut prefix = Vec::new();
    (&mut out)
        .take(bytes.len() as u64 + 1)
        .read_to_end(&mut prefix)
        .map_err(|_| storage_error())?;
    // A crash can leave a valid prefix. Resume by appending only; unexpected
    // user/foreign bytes are never truncated or overwritten.
    if !bytes.starts_with(&prefix) {
        return Err(storage_error());
    }
    out.write_all(&bytes[prefix.len()..])
        .and_then(|()| out.sync_all())
        .map_err(|_| storage_error())?;
    verified_file(&partial, upload)?;
    match fs::hard_link(&partial, &target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => verified_file(&target, upload)?,
        Err(_) => return Err(storage_error()),
    }
    File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|_| storage_error())?;
    fs::remove_file(partial).map_err(|_| storage_error())?;
    File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|_| storage_error())?;
    Ok(())
}
fn initialize(
    db: &mut Connection,
    owner: &str,
    operation: &str,
    attachment: &str,
    input: &TransferInput,
    bytes: &[u8],
    uploads: &FsPath,
) -> ApiResult<Record> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let creation = parent(&tx, owner, operation)?;
    if creation.state != State::Ready {
        return Err(ApiError::conflict(
            "Conversation is unavailable; transfer is fenced",
        ));
    }
    let mut record = read(&tx, owner, operation, attachment)?
        .ok_or_else(|| ApiError::not_found("Attachment transfer not found"))?;
    matches(&record, input)?;
    let upload = record
        .upload
        .as_ref()
        .ok_or_else(|| ApiError::conflict("Attachment transfer was deleted"))?;
    if record.ready && tx.get_upload(&upload.id).map_err(|_| storage_error())? != *upload {
        return Err(storage_error());
    }
    let root = root(uploads)?;
    write_file(&root, &record, bytes)?;
    if !record.ready {
        tx.create_upload(upload)?;
        tx.execute("UPDATE creation_uploads SET state='ready' WHERE owner_user=?1 AND operation_id=?2 AND attachment_id=?3",params![owner,operation,attachment])?;
        record.ready = true;
    }
    tx.commit()?;
    Ok(record)
}
fn response(creation: &Creation, attachment: &str, record: &Record) -> Response {
    let state = match creation.state {
        State::Deleting => "deleting",
        State::Deleted => "deleted",
        _ if record.upload.is_none() => "deleted",
        _ if record.ready => "ready",
        _ => "reserved",
    };
    let public_upload=record.upload.as_ref().filter(|_|!matches!(creation.state,State::Deleting|State::Deleted)).map_or_else(||json!({"id":record.upload_id}),|upload|json!({"id":upload.id,"mimeType":upload.mime_type,"byteSize":upload.byte_size,"sha256":upload.sha256,"kind":upload.kind,"filename":upload.filename}));
    Response::json(
        json!({"creationAttachment":{"operationId":creation.operation_id,"attachmentId":attachment,"sessionId":creation.session_id,"state":state,"upload":public_upload}}),
    )
}

fn verify_ready(node: &Node, db: &Connection, record: &Record) -> ApiResult<()> {
    let upload = record.upload.as_ref().ok_or_else(storage_error)?;
    if db.get_upload(&upload.id).map_err(|_| storage_error())? != *upload {
        return Err(storage_error());
    }
    verified_file(
        &root(&node.config.uploads_dir)?.join(&upload.storage_name),
        upload,
    )
}

pub(crate) async fn transfer(node: Node, request: Request) -> ApiResult<Response> {
    let operation = request
        .param("id")
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    let attachment = request
        .param("attachment")
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    if !valid_id(&operation) || !valid_id(&attachment) {
        return Err(ApiError::invalid_input());
    }
    let Body::Raw {
        bytes,
        content_type,
    } = &request.body
    else {
        return Err(ApiError::bad_request("Upload body must be raw bytes"));
    };
    let input = TransferInput::parse(&request, content_type)?;
    if bytes.is_empty() || bytes.len() > node.config.upload_max_bytes {
        return Err(ApiError::new(
            413,
            "payload_too_large",
            "Upload exceeds configured limit",
        ));
    }
    if input.size != bytes.len() as u64 || input.digest != sha256_hex(bytes) {
        return Err(ApiError::conflict(
            "Attachment bytes do not match the manifest",
        ));
    }
    let owner = request.user.clone();
    let bytes = bytes.clone();
    tokio::task::spawn_blocking(move || {
        let mut db = node.db.lock();
        let creation = parent(&db, &owner, &operation)?;
        if let Some(record) = read(&db, &owner, &operation, &attachment)? {
            matches(&record, &input)?;
            if matches!(creation.state, State::Deleting | State::Deleted) {
                return Ok(response(&creation, &attachment, &record));
            }
            if record.ready {
                verify_ready(&node, &db, &record)?;
                return Ok(response(&creation, &attachment, &record));
            }
        }
        if creation.state != State::Ready {
            return Err(ApiError::conflict(
                "Conversation is not available for attachment transfer",
            ));
        }
        node.workspace_mode(&db.get_workspace(&creation.workspace_id)?)?;
        let storage = node.config.sessions_dir.join(&creation.session_id);
        let meta = fs::symlink_metadata(storage).map_err(|_| storage_error())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(storage_error());
        }
        reserve(&mut db, &owner, &operation, &attachment, &input, &bytes)?;
        let record = initialize(
            &mut db,
            &owner,
            &operation,
            &attachment,
            &input,
            &bytes,
            &node.config.uploads_dir,
        )?;
        Ok(response(
            &parent(&db, &owner, &operation)?,
            &attachment,
            &record,
        ))
    })
    .await
    .map_err(|_| ApiError::internal())?
}
pub(crate) async fn status(node: Node, request: Request) -> ApiResult<Response> {
    let operation = request
        .param("id")
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    let attachment = request
        .param("attachment")
        .ok_or_else(ApiError::invalid_input)?
        .to_owned();
    if !valid_id(&operation) || !valid_id(&attachment) {
        return Err(ApiError::invalid_input());
    }
    tokio::task::spawn_blocking(move || {
        let db = node.db.lock();
        let creation = parent(&db, &request.user, &operation)?;
        let record = read(&db, &request.user, &operation, &attachment)?
            .ok_or_else(|| ApiError::not_found("Attachment transfer not found"))?;
        if creation.state == State::Ready && record.ready {
            verify_ready(&node, &db, &record)?;
        }
        Ok(response(&creation, &attachment, &record))
    })
    .await
    .map_err(|_| ApiError::internal())?
}
/// The deletion fence is committed before this is called. Includes reserved
/// files absent from the ordinary upload table, and leaves identity tombstones.
pub(crate) fn remove_session_files(node: &Node, session: &str) -> ApiResult<()> {
    let mut db = node.db.lock();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx.session_deletion(session)?.is_none() {
        return Err(ApiError::conflict(
            "Attachment cleanup requires a deletion fence",
        ));
    }
    let uploads = tx
        .prepare("SELECT upload_json FROM creation_uploads WHERE session_id=?1")?
        .query_map([session], |r| r.get::<_, Option<String>>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !uploads.is_empty() {
        let root = root(&node.config.uploads_dir)?;
        for raw in uploads {
            let upload: UploadRow = serde_json::from_str(&raw).map_err(|_| storage_error())?;
            if !crate::app::storage_name(&upload.storage_name)
                || upload.session_id.as_deref() != Some(session)
            {
                return Err(storage_error());
            }
            for name in [
                &upload.storage_name,
                &format!("{}.part", upload.storage_name),
            ] {
                let path = root.join(name);
                match fs::symlink_metadata(&path) {
                    Ok(meta) if meta.is_file() => {
                        fs::remove_file(path).map_err(|_| storage_error())?
                    }
                    Ok(_) => return Err(storage_error()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(storage_error()),
                }
            }
            tx.execute(
                "DELETE FROM uploads WHERE id=?1 AND session_id=?2",
                params![upload.id, session],
            )?;
        }
        File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| storage_error())?;
        tx.execute(
            "UPDATE creation_uploads SET upload_json=NULL,state='deleted' WHERE session_id=?1",
            [session],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
