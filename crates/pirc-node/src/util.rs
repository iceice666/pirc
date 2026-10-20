//! Small helpers shared by the node's modules (`apps/gateway/src/util.ts`).
//! The same as the gateway's `util.rs`; copied rather than shared, as the
//! two executables share no crate for them.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Milliseconds since the Unix epoch (`Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// `n` bytes from the operating system's random source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes
}

/// A random (version 4) UUID, lowercase (`crypto.randomUUID()`).
pub fn uuid() -> String {
    let mut bytes = random_bytes::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `<prefix>_<uuid>` (`id(prefix)`): sessions, runs, interactions, uploads,
/// RPC ids.
pub fn prefix_uuid(prefix: &str) -> String {
    format!("{prefix}_{}", uuid())
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

pub fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(data.as_ref()))
}

/// The value with object keys sorted, so equal payloads hash equally, and
/// integral numbers written as integers (`JSON.stringify(1.0)` is `1`).
fn stable(value: &Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => number
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15)
            .map_or_else(|| value.clone(), |f| Value::from(f as i64)),
        Value::Array(items) => items.iter().map(stable).collect(),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, item)| (key.clone(), stable(item)))
                    .collect::<Map<_, _>>(),
            )
        }
        _ => value.clone(),
    }
}

/// SHA-256 of the payload's JSON with sorted keys: a command's identity
/// (`payloadHash`; byte order instead of `localeCompare`, as the gateway).
pub fn payload_hash(value: &Value) -> String {
    sha256_hex(stable(value).to_string())
}

/// Parse stored JSON, or `fallback` when it does not parse (`safeJson`).
pub fn safe_json(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

/// `String.prototype.slice(0, max)`: at most `max` UTF-16 code units, never
/// splitting a surrogate pair (TS would leave half of one).
pub fn head16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// `String.prototype.trim`: JS whitespace, which includes the BOM.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `chatWorkspaceDir`: the directory the node allocates for a workspace of
/// a `per-session` mode, `<state>/chat/<workspace id>` (0700, created if
/// needed, canonical). The `chat` name is kept: stored workspaces point there.
pub fn managed_workspace_dir(
    config: &pirc_config::NodeConfig,
    workspace_id: &str,
) -> crate::error::ApiResult<std::path::PathBuf> {
    let dir = config.state_dir.join("chat").join(workspace_id);
    make_private_dir(&dir)?;
    dir.canonicalize().map_err(|error| {
        crate::log::error(&format!("resolving {}: {error}", dir.display()));
        crate::error::ApiError::internal()
    })
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
fn make_private_dir(dir: &std::path::Path) -> crate::error::ApiResult<()> {
    use std::os::unix::fs::DirBuilderExt;

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|error| {
            crate::log::error(&format!("creating {}: {error}", dir.display()));
            crate::error::ApiError::internal()
        })
}

/// `path.basename`: the last non-empty `/`-separated part.
fn basename(text: &str) -> &str {
    text.split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or_default()
}

/// `sessionRoot`: where the session's agent, terminals and panels work:
/// the workspace, or for a `per-session` mode
/// `<workspace>/sessions/<basename(session id)>` (created 0700 on every call).
pub fn session_root(
    workspace: &crate::store::Workspace,
    session_id: &str,
    mode: &pirc_protocol::mode::Mode,
) -> crate::error::ApiResult<std::path::PathBuf> {
    let root = std::path::PathBuf::from(&workspace.canonical_path);
    if mode.workdir != pirc_protocol::mode::Workdir::PerSession {
        return Ok(root);
    }
    let dir = root.join("sessions").join(basename(session_id));
    make_private_dir(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn session_roots_follow_the_mode_workdir() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = crate::store::Workspace {
            id: "p".into(),
            host_id: "n".into(),
            display_name: "P".into(),
            canonical_path: dir.path().to_string_lossy().into_owned(),
            defaults: Map::new(),
            mode: pirc_protocol::mode::default_work().id,
        };
        let mut mode = pirc_protocol::mode::default_work();
        assert_eq!(session_root(&workspace, "s", &mode).unwrap(), dir.path());
        mode.workdir = pirc_protocol::mode::Workdir::PerSession;
        let root = session_root(&workspace, "a/session_1/", &mode).unwrap();
        assert_eq!(root, dir.path().join("sessions/session_1"));
        assert!(root.is_dir());
        assert_eq!(js_trim("\u{feff} x \n"), "x");
    }

    #[test]
    fn ids() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_ne!(uuid(), id);
        assert!(prefix_uuid("session").starts_with("session_"));
    }

    #[test]
    fn payload_hashes_ignore_key_order() {
        assert_eq!(
            payload_hash(&json!({ "a": 1, "b": { "c": 2, "d": [1, { "e": 1, "f": 2 }] } })),
            payload_hash(&json!({ "b": { "d": [1, { "f": 2, "e": 1 }], "c": 2 }, "a": 1 }))
        );
        assert_eq!(
            payload_hash(&json!({ "a": 1.0 })),
            payload_hash(&json!({ "a": 1 }))
        );
        assert_ne!(
            payload_hash(&json!({ "a": 1 })),
            payload_hash(&json!({ "a": 2 }))
        );
    }

    #[test]
    fn utf16_heads() {
        assert_eq!(head16("abc", 2), "ab");
        assert_eq!(head16("a😀b", 2), "a");
        assert_eq!(head16("a😀b", 3), "a😀");
        assert_eq!(head16("", 5), "");
    }
}
