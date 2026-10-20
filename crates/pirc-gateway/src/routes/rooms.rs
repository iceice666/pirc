//! The rooms API (plans/rewrite/01-rooms.md). Rooms are the household's:
//! every allowed user (and their devices) reads and writes every room;
//! reads, unread counts and "waiting for you" are per user.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderValue, Uri, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Handled, created, urlencoding_component};
use crate::app::{AppState, ReqBody, query_map};
use crate::auth::Identity;
use crate::db::rooms::{
    DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE, RoomInputStore, RoomPatch, RoomStore, Upload,
};
use crate::error::{ApiError, ApiResult};
use crate::http::{Body, no_content, ok};
use crate::util::{hex, new_id, now_ms, random_bytes, sha256_hex};

/// A message's text, in UTF-16 units (as a session prompt).
const MESSAGE_TEXT_MAX: usize = 1_000_000;
/// Attachments per message (as a session prompt's uploads).
const MESSAGE_ATTACHMENTS_MAX: usize = 16;
/// A room's `sourceScope`, serialized.
const SOURCE_SCOPE_MAX_BYTES: usize = 16 * 1024;
/// Ids in paths (`room_<uuid>`, `msg_<uuid>`, `upload_<uuid>`, `general`).
const ID_MAX: usize = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{id}", get(get_room).patch(update_room))
        .route("/api/rooms/{id}/move", post(move_room))
        .route(
            "/api/rooms/{id}/messages",
            get(list_messages).post(send_message),
        )
        .route("/api/rooms/{id}/messages/{mid}/pin", post(pin_message))
        .route("/api/rooms/{id}/read", post(read_room))
        .route("/api/rooms/{id}/typing", post(typing))
        .route("/api/rooms/{id}/uploads", post(upload))
        .route("/api/rooms/{id}/uploads/{uid}", get(download))
}

/// Path parameters of the room routes, for the gateway's length check.
pub const PARAM_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/rooms/{id}"),
    ("PATCH", "/api/rooms/{id}"),
    ("POST", "/api/rooms/{id}/move"),
    ("GET", "/api/rooms/{id}/messages"),
    ("POST", "/api/rooms/{id}/messages"),
    ("POST", "/api/rooms/{id}/messages/{mid}/pin"),
    ("POST", "/api/rooms/{id}/read"),
    ("POST", "/api/rooms/{id}/typing"),
    ("POST", "/api/rooms/{id}/uploads"),
    ("GET", "/api/rooms/{id}/uploads/{uid}"),
];

pub(super) fn id(text: &str) -> ApiResult<&str> {
    if text.is_empty() || text.len() > ID_MAX {
        return Err(ApiError::invalid_input());
    }
    Ok(text)
}

/// One query parameter: absent, or given once.
pub(super) fn single(uri: &Uri, name: &str) -> ApiResult<Option<String>> {
    match query_map(uri).remove(name).as_deref() {
        None => Ok(None),
        Some([value]) => Ok(Some(value.clone())),
        Some(_) => Err(ApiError::invalid_input()),
    }
}

/// A positive integer query parameter.
pub(super) fn positive(uri: &Uri, name: &str) -> ApiResult<Option<i64>> {
    single(uri, name)?
        .map(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|value| *value >= 1)
                .ok_or_else(ApiError::invalid_input)
        })
        .transpose()
}

async fn list_rooms(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    uri: Uri,
) -> Handled {
    let archived = match single(&uri, "archived")?.as_deref() {
        None | Some("0") => false,
        Some("1") => true,
        Some(_) => return Err(ApiError::invalid_input().into()),
    };
    let rooms = app.db.lock().list_rooms(&identity.user, archived)?;
    // Who is asking: clients tell their own messages and typing apart.
    Ok(ok(json!({ "rooms": rooms, "user": identity.user })))
}

#[derive(Deserialize)]
struct CreateRoom {
    name: String,
}

async fn create_room(State(app): State<AppState>, ReqBody(body): ReqBody) -> Handled {
    let CreateRoom { name } = body.parse()?;
    let room = app.db.lock().create_room(&name)?;
    app.room_changed(&room);
    Ok(created(json!({ "room": room })))
}

/// A room by its URL, archived or not, with its pinned messages.
async fn get_room(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
) -> Handled {
    let conn = app.db.lock();
    let room = conn.room_view(id(&room_id)?, &identity.user)?;
    let pinned = conn.pinned_messages(&room_id)?;
    Ok(ok(json!({ "room": room, "pinned": pinned })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRoom {
    name: Option<String>,
    archived: Option<bool>,
    /// Absent: unchanged; `null`: cleared.
    #[serde(default, deserialize_with = "present")]
    source_scope: Option<Value>,
}

/// `Some(value)` for a present key, `null` included.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

async fn update_room(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let update: UpdateRoom = body.parse()?;
    if update.name.is_none() && update.archived.is_none() && update.source_scope.is_none() {
        return Err(ApiError::invalid_input().into());
    }
    if let Some(scope) = &update.source_scope
        && (!(scope.is_object() || scope.is_null())
            || scope.to_string().len() > SOURCE_SCOPE_MAX_BYTES)
    {
        return Err(ApiError::invalid_input().into());
    }
    let (room, view) = {
        let conn = app.db.lock();
        let room = conn.update_room(
            id(&room_id)?,
            &RoomPatch {
                name: update.name,
                archived: update.archived,
                source_scope: update.source_scope,
            },
        )?;
        (room, conn.room_view(&room_id, &identity.user)?)
    };
    if room.archived_at.is_none() {
        // What waited while it was archived.
        crate::brain::Brain::nudge(&app);
    }
    app.room_changed(&room);
    Ok(ok(json!({ "room": view })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveRoom {
    to_room_id: String,
}

async fn move_room(
    State(app): State<AppState>,
    Path(room_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let MoveRoom { to_room_id } = body.parse()?;
    let moved = app.db.lock().move_room(id(&room_id)?, id(&to_room_id)?)?;
    app.room_message(&moved.from_line);
    app.room_message(&moved.to_line);
    app.room_changed(&moved.from);
    app.room_changed(&moved.to);
    Ok(ok(json!(moved)))
}

async fn list_messages(
    State(app): State<AppState>,
    Path(room_id): Path<String>,
    uri: Uri,
) -> Handled {
    let before = positive(&uri, "before")?;
    let limit = positive(&uri, "limit")?.map_or(DEFAULT_MESSAGE_PAGE, |limit| limit as usize);
    if limit > MAX_MESSAGE_PAGE {
        return Err(ApiError::invalid_input().into());
    }
    let messages = app.db.lock().list_messages(id(&room_id)?, before, limit)?;
    // Whether older messages remain: the page starts after the first.
    let more = messages.first().is_some_and(|first| first.seq > 1);
    Ok(ok(json!({ "messages": messages, "hasMore": more })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessage {
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
    /// "Send now" (Cmd+Enter): the brain takes it without the typing
    /// debounce (plan 02).
    #[serde(default)]
    immediate: bool,
}

/// Stored and shown at once, on every device; the brain gets it later as
/// part of the user's pending input.
async fn send_message(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let send: SendMessage = body.parse()?;
    let text = send.text.trim_end_matches(pirc_config::js_space);
    let length = text.encode_utf16().count();
    if length > MESSAGE_TEXT_MAX
        || send.attachments.len() > MESSAGE_ATTACHMENTS_MAX
        || (text.trim_matches(pirc_config::js_space).is_empty() && send.attachments.is_empty())
        || send.attachments.iter().any(|upload| id(upload).is_err())
    {
        return Err(ApiError::invalid_input().into());
    }
    let (message, room) = {
        let conn = app.db.lock();
        let message = conn.send_user_message(
            id(&room_id)?,
            &identity.user,
            text,
            &send.attachments,
            send.immediate,
        )?;
        (message, conn.room_view(&room_id, &identity.user)?)
    };
    app.typing().clear(&room_id, &identity.user);
    crate::brain::Brain::nudge(&app);
    app.room_message(&message);
    app.room_changed(&room.room);
    app.room_read(&identity.user, &room);
    Ok(created(json!({ "message": message })))
}

#[derive(Deserialize)]
struct Pin {
    pinned: Option<bool>,
}

async fn pin_message(
    State(app): State<AppState>,
    Path((room_id, message_id)): Path<(String, String)>,
    ReqBody(body): ReqBody,
) -> Handled {
    let pinned = match &body {
        Body::None => true,
        _ => body.parse::<Pin>()?.pinned.unwrap_or(true),
    };
    let message = app
        .db
        .lock()
        .pin_message(id(&room_id)?, id(&message_id)?, pinned)?;
    app.room_message_updated(&message);
    Ok(ok(json!({ "message": message })))
}

#[derive(Deserialize)]
struct Read {
    seq: i64,
}

async fn read_room(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
    ReqBody(body): ReqBody,
) -> Handled {
    let Read { seq } = body.parse()?;
    if seq < 0 {
        return Err(ApiError::invalid_input().into());
    }
    let (moved, view) = {
        let conn = app.db.lock();
        let moved = conn.mark_read(id(&room_id)?, &identity.user, seq)?;
        (moved, conn.room_view(&room_id, &identity.user)?)
    };
    if moved {
        app.room_read(&identity.user, &view);
    }
    Ok(ok(json!({ "room": view })))
}

/// A keystroke signal; clients send at most one every 3 seconds. Never
/// stored.
async fn typing(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
) -> Handled {
    let room = app.db.lock().get_room(id(&room_id)?)?;
    if room.archived_at.is_some() {
        return Err(ApiError::new(409, "conflict", "This room is archived").into());
    }
    let device = identity.device_id.as_deref().unwrap_or("web");
    app.room_typing(&room.id, &identity.user, device);
    Ok(no_content())
}

/// The image type of `bytes` by its signature (the node's `sniff_image`).
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn bad_request(message: &str) -> ApiError {
    ApiError::new(400, "bad_request", message)
}

/// The kind, type and name of an upload, by the session uploads' rules:
/// an image is sniffed (and its declared type must agree); anything else
/// needs a file name and keeps its declared type.
fn classify(
    bytes: &[u8],
    declared: &str,
    filename: Option<&str>,
) -> ApiResult<(&'static str, String, Option<String>)> {
    if let Some(sniffed) = sniff_image(bytes) {
        if !declared.is_empty() && declared != "application/octet-stream" && declared != sniffed {
            return Err(bad_request(
                "Declared Content-Type does not match image content",
            ));
        }
        return Ok(("image", sniffed.to_owned(), None));
    }
    let filename =
        filename.ok_or_else(|| bad_request("filename is required for non-image uploads"))?;
    let base = filename
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or_default()
        .trim_matches(pirc_config::js_space);
    if base.is_empty() || base.chars().any(char::is_control) {
        return Err(bad_request("filename is invalid"));
    }
    let mime = if declared.is_empty() {
        "application/octet-stream".to_owned()
    } else {
        declared.to_owned()
    };
    Ok(("file", mime, Some(base.to_owned())))
}

async fn upload(
    State(app): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(room_id): Path<String>,
    uri: Uri,
    ReqBody(body): ReqBody,
) -> Handled {
    let room = app.db.lock().get_room(id(&room_id)?)?;
    if room.archived_at.is_some() {
        return Err(ApiError::new(409, "conflict", "This room is archived").into());
    }
    let Body::Raw {
        bytes,
        content_type,
    } = body
    else {
        return Err(ApiError::new(400, "invalid_input", "Upload body must be raw bytes").into());
    };
    if bytes.is_empty() || bytes.len() > app.config.upload_max_bytes {
        return Err(
            ApiError::new(413, "payload_too_large", "Upload exceeds configured limit").into(),
        );
    }
    let filename = single(&uri, "filename")?.filter(|name| !name.is_empty());
    if filename
        .as_ref()
        .is_some_and(|name| name.encode_utf16().count() > 255)
    {
        return Err(ApiError::invalid_input().into());
    }
    let declared = content_type
        .as_deref()
        .map(|value| value.split(';').next().unwrap_or_default().to_owned())
        .unwrap_or_default();
    let (kind, mime_type, filename) = classify(&bytes, &declared, filename.as_deref())?;
    let upload = Upload {
        id: new_id("upload"),
        room_id: room.id,
        user: identity.user.clone(),
        kind: kind.to_owned(),
        filename,
        mime_type,
        byte_size: bytes.len() as i64,
        sha256: sha256_hex(&bytes),
        storage_name: format!("room-{}.bin", hex(&random_bytes::<24>())),
        message_id: None,
        created_at: now_ms(),
    };
    let file = app.config.uploads_dir.join(&upload.storage_name);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut out| out.write_all(&bytes))
        .map_err(|error| {
            crate::log::error(&format!("writing {}: {error}", file.display()));
            ApiError::internal()
        })?;
    if let Err(error) = app.db.lock().create_upload(&upload) {
        let _ = std::fs::remove_file(&file);
        return Err(error.into());
    }
    Ok(created(json!({ "upload": upload })))
}

/// An upload's bytes. Images are shown inline; anything else is a download,
/// never rendered by the browser.
async fn download(
    State(app): State<AppState>,
    Path((room_id, upload_id)): Path<(String, String)>,
) -> Handled {
    let upload = app.db.lock().get_upload(id(&room_id)?, id(&upload_id)?)?;
    let file = app.config.uploads_dir.join(&upload.storage_name);
    let bytes = std::fs::read(&file).map_err(|error| {
        crate::log::error(&format!("reading {}: {error}", file.display()));
        ApiError::not_found("Upload not found")
    })?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    let (content_type, disposition) = if upload.kind == "image" {
        (upload.mime_type.clone(), "inline".to_owned())
    } else {
        let name = upload.filename.as_deref().unwrap_or("file");
        (
            "application/octet-stream".to_owned(),
            format!(
                "attachment; filename*=UTF-8''{}",
                urlencoding_component(name)
            ),
        )
    };
    let header_value = |text: &str| {
        HeaderValue::from_str(text).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
    };
    headers.insert(header::CONTENT_TYPE, header_value(&content_type));
    headers.insert(header::CONTENT_DISPOSITION, header_value(&disposition));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploads_follow_the_session_rules() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0];
        assert_eq!(
            classify(&png, "", None).unwrap(),
            ("image", "image/png".to_owned(), None)
        );
        assert_eq!(
            classify(&png, "image/jpeg", None).unwrap_err().code,
            "bad_request"
        );
        assert_eq!(
            classify(b"text", "text/plain", None).unwrap_err().code,
            "bad_request"
        );
        assert_eq!(
            classify(b"text", "", Some("dir/ notes.txt ")).unwrap(),
            (
                "file",
                "application/octet-stream".to_owned(),
                Some("notes.txt".to_owned())
            )
        );
        assert!(classify(b"text", "", Some("//")).is_err());
    }
}
