//! The assistant's editable prompts on the chat node
//! (`apps/gateway/src/assistant-prompts.ts`): `SOUL.md` and `CHAT.md` in
//! the config directory, at most 8000 characters, with whether each can be
//! written (a Nix store path, a symlink or permissions may forbid it). The
//! routes (`GET /api/assistant/prompts`, `PUT /api/assistant/prompts/:name`)
//! exist on the chat node only. Owner: **core**; reading a prompt is
//! `pirc_agent::config::read_assistant_prompt`.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::unistd::{AccessFlags, access};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::util::{hex, random_bytes};

pub const PROMPT_MAX_CHARS: usize = 8000;

/// `PromptName`: which prompt file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptName {
    Soul,
    Chat,
}

impl PromptName {
    fn file(self) -> &'static str {
        match self {
            Self::Soul => "SOUL.md",
            Self::Chat => "CHAT.md",
        }
    }
}

/// `AssistantPrompt`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPrompt {
    pub text: String,
    pub writable: bool,
    /// `nix-store`, `symlink` or `permission`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub path: String,
    pub max_chars: usize,
}

/// Why the prompt cannot be written, if it cannot (`inspectAssistantPrompt`'s
/// checks, in its order: a Nix store target, a symlink, then write access
/// to the directory and the file).
fn read_only_reason(config_dir: &Path, file: &Path, name: PromptName) -> Option<&'static str> {
    let resolved = match file.canonicalize() {
        Ok(resolved) => resolved,
        Err(_) => match config_dir.canonicalize() {
            Ok(dir) => dir.join(name.file()),
            Err(_) => return Some("permission"),
        },
    };
    let mut reason = None;
    if resolved == Path::new("/nix/store") || resolved.starts_with("/nix/store/") {
        reason = Some("nix-store");
    }
    let entry = match std::fs::symlink_metadata(file) {
        Ok(entry) => Some(entry),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return reason.or(Some("permission")),
    };
    if reason.is_none() && entry.as_ref().is_some_and(|entry| entry.is_symlink()) {
        reason = Some("symlink");
    }
    if reason.is_none() {
        let writable = access(config_dir, AccessFlags::W_OK).is_ok()
            && entry
                .as_ref()
                .is_none_or(|entry| entry.is_file() && access(file, AccessFlags::W_OK).is_ok());
        if !writable {
            reason = Some("permission");
        }
    }
    reason
}

/// `inspectAssistantPrompt(configDir, name)`.
pub fn inspect(config_dir: &Path, name: PromptName) -> AssistantPrompt {
    let file = config_dir.join(name.file());
    let mut reason = read_only_reason(config_dir, &file, name);
    let text = match pirc_agent::config::read_assistant_prompt(&file.to_string_lossy()) {
        Ok(text) => text,
        Err(_) => {
            reason = reason.or(Some("permission"));
            String::new()
        }
    };
    AssistantPrompt {
        text,
        writable: reason.is_none(),
        reason,
        path: file.to_string_lossy().into_owned(),
        max_chars: PROMPT_MAX_CHARS,
    }
}

fn io_failure(path: &Path, error: std::io::Error) -> ApiError {
    crate::log::error(&format!("writing {}: {error}", path.display()));
    ApiError::internal()
}

/// `writeAssistantPrompt(configDir, name, text)`: empty text removes the
/// file; a read-only prompt is 409 `read_only`.
pub fn write(config_dir: &Path, name: PromptName, text: &str) -> ApiResult<AssistantPrompt> {
    let value = crate::chat::js_trim(&text.replace("\r\n", "\n")).to_owned();
    if value.encode_utf16().count() > PROMPT_MAX_CHARS {
        return Err(ApiError::new(
            413,
            "payload_too_large",
            format!("Prompts are limited to {PROMPT_MAX_CHARS} characters"),
        ));
    }
    let current = inspect(config_dir, name);
    if let Some(reason) = current.reason {
        return Err(ApiError::new(
            409,
            "read_only",
            format!("Prompt is read-only ({reason})"),
        ));
    }
    let file = PathBuf::from(&current.path);
    let mut temp = file.clone().into_os_string();
    temp.push(format!(".{}.tmp", hex(&random_bytes::<8>())));
    let temp = PathBuf::from(temp);
    let result = replace(config_dir, name, &file, &temp, &value);
    let _ = std::fs::remove_file(&temp);
    result?;
    Ok(inspect(config_dir, name))
}

fn replace(
    config_dir: &Path,
    name: PromptName,
    file: &Path,
    temp: &Path,
    value: &str,
) -> ApiResult<()> {
    if value.is_empty() {
        return match std::fs::remove_file(file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(io_failure(file, error))
            }
            _ => Ok(()),
        };
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temp)
        .and_then(|mut out| out.write_all(format!("{value}\n").as_bytes()))
        .map_err(|error| io_failure(temp, error))?;
    // Recheck right before replacing: never knowingly replace a managed symlink.
    if !inspect(config_dir, name).writable {
        return Err(ApiError::new(409, "read_only", "Prompt became read-only"));
    }
    std::fs::rename(temp, file).map_err(|error| io_failure(file, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_and_writes() {
        let dir = tempfile::tempdir().unwrap();
        let prompt = inspect(dir.path(), PromptName::Soul);
        assert_eq!(
            (prompt.text.as_str(), prompt.writable, prompt.reason),
            ("", true, None)
        );
        let written = write(dir.path(), PromptName::Soul, " Be kind.\r\n ").unwrap();
        assert_eq!(written.text, "Be kind.");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("SOUL.md")).unwrap(),
            "Be kind.\n"
        );
        let error = write(dir.path(), PromptName::Chat, &"x".repeat(8001)).unwrap_err();
        assert_eq!(error.status, 413);
        std::os::unix::fs::symlink(dir.path().join("SOUL.md"), dir.path().join("CHAT.md")).unwrap();
        let linked = inspect(dir.path(), PromptName::Chat);
        assert_eq!((linked.writable, linked.reason), (false, Some("symlink")));
        assert_eq!(linked.text, "Be kind.");
        assert_eq!(
            write(dir.path(), PromptName::Chat, "x")
                .unwrap_err()
                .message,
            "Prompt is read-only (symlink)"
        );
        assert_eq!(write(dir.path(), PromptName::Soul, "").unwrap().text, "");
        assert!(!dir.path().join("SOUL.md").exists());
        assert_eq!(
            serde_json::to_value(inspect(dir.path(), PromptName::Soul)).unwrap()["maxChars"],
            8000
        );
    }
}
