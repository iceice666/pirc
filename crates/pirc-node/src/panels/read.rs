//! `POST /api/workspaces/:id/read` (plans/rewrite/08-nodes.md): the
//! gateway's brain looks into a workspace without a worker. Only the
//! gateway reaches it (it relays no such browser route). It starts no
//! runner, shows no canonical path, reads inside the workspace only (as the
//! Files panel does, symlinks followed and escapes refused, never `.git`),
//! runs git in the read-only sandbox (as the Git panel does), and answers
//! at most [`MAX_BYTES`] of JSON.
//!
//! `{op}`: `list {path?}`, `read {path, offset?}`, `grep {pattern, path?}`,
//! `git_log {n?}` or `git_status`.

use std::path::{Path, PathBuf};

use pirc_protocol::mode::Workdir;
use regex_lite::RegexBuilder;
use serde_json::{Map, Value, json};

use super::inspect;
use crate::error::{ApiError, ApiResult};
use crate::router::{Request, Response};
use crate::services::Node;
use crate::store::Store as _;

/// The most one answer carries.
pub const MAX_BYTES: usize = 64 * 1024;
const GREP_FILES: usize = 5_000;
const GREP_FILE_BYTES: u64 = 1024 * 1024;
const GREP_MATCHES: usize = 200;
const LINE_CHARS: usize = 300;
/// Directories a search never enters.
const SKIPPED: [&str; 5] = ["node_modules", "target", "dist", "build", "result"];

pub async fn read(node: Node, request: Request) -> ApiResult<Response> {
    let workspace = node
        .db
        .lock()
        .get_workspace(request.param("id").unwrap_or_default())?;
    if workspace.host_id != node.config.node_id {
        return Err(ApiError::not_found("Workspace not found"));
    }
    let mode = node.workspace_mode(&workspace)?;
    if mode.workdir != Workdir::Workspace {
        return Err(ApiError::bad_request(
            "A per-session workspace has nothing of its own to read",
        ));
    }
    let root = PathBuf::from(&workspace.canonical_path);
    let body = request
        .json()
        .as_object()
        .ok_or_else(ApiError::invalid_input)?;
    let text = |key: &str, max: usize| -> ApiResult<Option<String>> {
        match body.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if text.chars().count() <= max => Ok(Some(text.clone())),
            Some(_) => Err(ApiError::invalid_input()),
        }
    };
    let path = text("path", 4096)?.unwrap_or_default();
    if path
        .split('/')
        .any(|part| part == ".git" || part.eq_ignore_ascii_case(".git"))
    {
        return Err(ApiError::forbidden(
            "The repository's own files are not read",
        ));
    }
    let number = |key: &str, default: u64, max: u64| -> ApiResult<u64> {
        match body.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(value) => value
                .as_u64()
                .filter(|n| *n <= max)
                .ok_or_else(ApiError::invalid_input),
        }
    };
    let env = super::child_env(&node);
    let answer = match body.get("op").and_then(Value::as_str) {
        Some("list") => inspect::list_directory(&root, &path)?,
        Some("read") => {
            if path.is_empty() {
                return Err(ApiError::invalid_input());
            }
            read_file(&root, &path, number("offset", 0, u64::MAX >> 1)?)?
        }
        Some("grep") => {
            let pattern = text("pattern", 500)?
                .filter(|pattern| !pattern.is_empty())
                .ok_or_else(ApiError::invalid_input)?;
            let root = root.clone();
            tokio::task::spawn_blocking(move || grep(&root, &path, &pattern))
                .await
                .map_err(|_| ApiError::internal())??
        }
        Some("git_log") => {
            let n = number("n", 20, 50)?.max(1);
            inspect::git_log(&*node.sandbox, &root, &env, 0, n).await?
        }
        Some("git_status") => inspect::git_status(&*node.sandbox, &root, &env).await?,
        _ => return Err(ApiError::invalid_input()),
    };
    Ok(Response::json(cap(answer)))
}

/// A text file's bytes from `offset`, at most what fits in one answer.
fn read_file(root: &Path, relative: &str, offset: u64) -> ApiResult<Value> {
    let file = inspect::resolve_inside(root, relative)?;
    let metadata = std::fs::metadata(&file).map_err(|_| ApiError::not_found("Path not found"))?;
    if !metadata.is_file() {
        return Err(ApiError::bad_request("Not a file"));
    }
    let size = metadata.len();
    let want = (MAX_BYTES - 1024) as u64;
    let bytes = {
        use std::io::{Read, Seek, SeekFrom};
        let mut handle = std::fs::File::open(&file).map_err(|_| ApiError::internal())?;
        handle
            .seek(SeekFrom::Start(offset.min(size)))
            .map_err(|_| ApiError::internal())?;
        let mut bytes = Vec::new();
        handle
            .take(want)
            .read_to_end(&mut bytes)
            .map_err(|_| ApiError::internal())?;
        bytes
    };
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Ok(json!({ "path": relative, "size": size, "binary": true }));
    }
    // Whole characters only: the next read starts where this one ended.
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_owned(),
        Err(error) if error.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned()
        }
        Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
    };
    let end = offset.min(size) + text.len() as u64;
    let mut out = Map::new();
    out.insert("path".into(), json!(relative));
    out.insert("size".into(), json!(size));
    out.insert("offset".into(), json!(offset.min(size)));
    out.insert("content".into(), json!(text));
    if end < size {
        out.insert("nextOffset".into(), json!(end));
    }
    Ok(Value::Object(out))
}

/// Lines matching `pattern` (a regular expression, case-insensitive) in the
/// workspace's text files under `relative`, hidden directories and build
/// output skipped, symlinks not followed.
fn grep(root: &Path, relative: &str, pattern: &str) -> ApiResult<Value> {
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| ApiError::bad_request(format!("Invalid pattern: {error}")))?;
    let real_root = std::fs::canonicalize(root).map_err(|_| ApiError::internal())?;
    let start = inspect::resolve_inside(root, if relative.is_empty() { "." } else { relative })?;
    let mut matches = Vec::new();
    let mut files = 0;
    let mut bytes = 0;
    let mut truncated = false;
    let mut stack = vec![start];
    'walk: while let Some(path) = stack.pop() {
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            let Ok(entries) = std::fs::read_dir(&path) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    !name.starts_with('.') && !SKIPPED.contains(&name.as_str())
                })
                .map(|entry| entry.path())
                .collect();
            children.sort();
            children.reverse();
            stack.extend(children);
            continue;
        }
        if !metadata.is_file() || metadata.len() > GREP_FILE_BYTES {
            continue;
        }
        files += 1;
        if files > GREP_FILES {
            truncated = true;
            break;
        }
        let Ok(content) = std::fs::read(&path) else {
            continue;
        };
        if content[..content.len().min(8000)].contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&content);
        let shown = path
            .strip_prefix(&real_root)
            .map_or_else(|_| path.display().to_string(), |p| p.display().to_string());
        for (index, line) in text.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            let line: String = line.trim().chars().take(LINE_CHARS).collect();
            bytes += line.len() + shown.len() + 32;
            if matches.len() >= GREP_MATCHES || bytes > MAX_BYTES - 2048 {
                truncated = true;
                break 'walk;
            }
            matches.push(json!({ "path": shown, "line": index + 1, "text": line }));
        }
    }
    Ok(json!({ "matches": matches, "truncated": truncated }))
}

/// `value` within [`MAX_BYTES`]: the longest list in it loses items from
/// its end (and the answer says `truncated`) until it fits.
pub fn cap(mut value: Value) -> Value {
    let size = |value: &Value| value.to_string().len();
    while size(&value) > MAX_BYTES {
        let Value::Object(map) = &mut value else {
            return json!({ "truncated": true });
        };
        let longest = map
            .iter()
            .filter_map(|(key, item)| item.as_array().map(|items| (key.clone(), items.len())))
            .filter(|(_, len)| *len > 0)
            .max_by_key(|(_, len)| *len);
        let Some((key, len)) = longest else {
            return json!({ "truncated": true });
        };
        if let Some(Value::Array(items)) = map.get_mut(&key) {
            items.truncate(len - len.div_ceil(8).max(1));
        }
        map.insert("truncated".into(), json!(true));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_greps_and_caps_inside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn main() {}\n// TODO: tests\n").unwrap();
        std::fs::write(root.join("node_modules/x/a.js"), "TODO").unwrap();
        std::fs::write(root.join(".hidden/a"), "TODO").unwrap();
        std::fs::write(root.join("big.txt"), "é".repeat(40_000)).unwrap();
        let found = grep(root, "", "todo").unwrap();
        assert_eq!(
            found,
            json!({ "matches": [{ "path": "src/a.rs", "line": 2, "text": "// TODO: tests" }],
                "truncated": false })
        );
        assert!(grep(root, "", "(").is_err());
        // In pieces of whole characters.
        let first = read_file(root, "big.txt", 0).unwrap();
        let next = first["nextOffset"].as_u64().unwrap();
        assert!(next < 80_000 && next.is_multiple_of(2));
        let second = read_file(root, "big.txt", next).unwrap();
        assert!(second.get("nextOffset").is_none());
        assert_eq!(
            first["content"].as_str().unwrap().len() + second["content"].as_str().unwrap().len(),
            80_000
        );
        assert!(read_file(root, "../outside", 0).is_err());
        let capped = cap(json!({ "entries": vec!["x".repeat(100); 2000], "path": "" }));
        assert!(capped.to_string().len() <= MAX_BYTES);
        assert_eq!(capped["truncated"], true);
    }
}
