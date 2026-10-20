//! Who the brain is (plans/rewrite/02-brain-host.md): `SOUL.md` (its
//! persona) and `CHAT.md` (house rules for talking) in `$PIRC_CONFIG_DIR`,
//! at most 8000 characters each, with whether each can be written (a Nix
//! store path, a symlink or permissions may forbid it); and `brain.json`,
//! its settings until plan 03's preferences take them over. Everything is
//! read again before each turn, so a change applies to the next one.
//!
//! The rules are the chat node's (`assistant_prompts.rs`, removed in plan
//! 00); reading a prompt is `pirc_agent::config::read_assistant_prompt`.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::unistd::{AccessFlags, access};
use pirc_agent::context::PromptSection;
use serde::Serialize;
use serde_json::Value;

use crate::db::rooms::Room;
use crate::error::{ApiError, ApiResult};
use crate::util::{hex, random_bytes};

pub const PROMPT_MAX_CHARS: usize = 8000;
/// The typing debounce when `brain.json` does not set one (decision #16).
pub const DEFAULT_DEBOUNCE_MS: i64 = 3_000;
/// The longest debounce `brain.json` may set.
const MAX_DEBOUNCE_MS: i64 = 60_000;
const SETTINGS_FILE: &str = "brain.json";

/// The brain without a `SOUL.md`.
const HOST_IDENTITY: &str = "You are pirc, the household's assistant. You talk with the people of the household in chat rooms, where several of them may be present.
Answer directly and plainly; say what you did and what you could not do.";

/// Which prompt file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptName {
    Soul,
    Chat,
}

impl PromptName {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "soul" => Some(Self::Soul),
            "chat" => Some(Self::Chat),
            _ => None,
        }
    }

    fn file(self) -> &'static str {
        match self {
            Self::Soul => "SOUL.md",
            Self::Chat => "CHAT.md",
        }
    }
}

/// A prompt as the settings page shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainPrompt {
    pub text: String,
    pub writable: bool,
    /// `nix-store`, `symlink` or `permission`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub path: String,
    pub max_chars: usize,
}

/// Why the prompt cannot be written, if it cannot: a Nix store target, a
/// symlink, then write access to the directory and the file.
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

pub fn inspect(config_dir: &Path, name: PromptName) -> BrainPrompt {
    let file = config_dir.join(name.file());
    let mut reason = read_only_reason(config_dir, &file, name);
    let text = match pirc_agent::config::read_assistant_prompt(&file.to_string_lossy()) {
        Ok(text) => text,
        Err(_) => {
            reason = reason.or(Some("permission"));
            String::new()
        }
    };
    BrainPrompt {
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

/// Empty text removes the file; a read-only prompt is 409 `read_only`.
pub fn write(config_dir: &Path, name: PromptName, text: &str) -> ApiResult<BrainPrompt> {
    let value = text
        .replace("\r\n", "\n")
        .trim_matches(pirc_config::js_space)
        .to_owned();
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

/// The brain's system prompt for a turn in `room`: its persona, the room it
/// speaks in, then the house rules.
pub fn sections(config_dir: &Path, room: &Room) -> Vec<PromptSection> {
    let soul = inspect(config_dir, PromptName::Soul);
    let mut sections = vec![if soul.text.is_empty() {
        PromptSection::new("soul", "Persona", "built-in", HOST_IDENTITY)
    } else {
        PromptSection::new("soul", "Persona", &soul.path, soul.text)
    }];
    sections.push(PromptSection::new(
        "room",
        "Room",
        "built-in",
        format!(
            "You are speaking in the room #{}. Each message from people starts with who said it (`name: text`); messages that arrive together are one batch, so answer them together. You have no files, shell or computer of your own: the tools you are given are all you can use.",
            room.name
        ),
    ));
    let rules = inspect(config_dir, PromptName::Chat);
    if !rules.text.is_empty() {
        sections.push(PromptSection::new(
            "chat-md",
            "House rules",
            &rules.path,
            rules.text,
        ));
    }
    sections
}

/// `brain.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    /// How long after the last keystroke or message a batch waits.
    pub debounce_ms: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            debounce_ms: DEFAULT_DEBOUNCE_MS,
        }
    }
}

/// `{"debounceSeconds": 3}`; a missing or unreadable file, or a value out
/// of range, keeps the default (a bad file is logged).
pub fn settings(config_dir: &Path) -> Settings {
    let file = config_dir.join(SETTINGS_FILE);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Settings::default();
        }
        Err(error) => {
            crate::log::warn(&format!("cannot read {}: {error}", file.display()));
            return Settings::default();
        }
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            crate::log::warn(&format!("{} is not valid JSON: {error}", file.display()));
            return Settings::default();
        }
    };
    let mut settings = Settings::default();
    if let Some(seconds) = value.get("debounceSeconds").and_then(Value::as_f64) {
        let ms = (seconds * 1000.0).round();
        if (0.0..=MAX_DEBOUNCE_MS as f64).contains(&ms) {
            settings.debounce_ms = ms as i64;
        }
    }
    settings
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

    fn room(name: &str) -> Room {
        Room {
            id: "r".into(),
            name: name.into(),
            kind: "topic".into(),
            created_at: 0,
            archived_at: None,
            last_activity_at: 0,
            source_scope: None,
            moved_to_room_id: None,
            moved_from_room_id: None,
            last_seq: 0,
        }
    }

    #[test]
    fn the_prompt_follows_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let ids = |sections: &[PromptSection]| {
            sections
                .iter()
                .map(|section| section.id.clone())
                .collect::<Vec<_>>()
        };
        let plain = sections(dir.path(), &room("plants"));
        assert_eq!(ids(&plain), ["soul", "room"]);
        assert_eq!(plain[0].text, HOST_IDENTITY);
        assert!(plain[1].text.contains("#plants"));
        write(dir.path(), PromptName::Soul, "You are Mo.").unwrap();
        write(dir.path(), PromptName::Chat, "No emoji.").unwrap();
        let custom = sections(dir.path(), &room("plants"));
        assert_eq!(ids(&custom), ["soul", "room", "chat-md"]);
        assert_eq!(
            (custom[0].text.as_str(), custom[2].text.as_str()),
            ("You are Mo.", "No emoji.")
        );
    }

    #[test]
    fn reads_the_debounce_setting() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(settings(dir.path()).debounce_ms, DEFAULT_DEBOUNCE_MS);
        let file = dir.path().join(SETTINGS_FILE);
        for (text, expected) in [
            (r#"{"debounceSeconds": 1.5}"#, 1_500),
            (r#"{"debounceSeconds": 0}"#, 0),
            (r#"{"debounceSeconds": 61}"#, DEFAULT_DEBOUNCE_MS),
            (r#"{"debounceSeconds": "2"}"#, DEFAULT_DEBOUNCE_MS),
            ("not json", DEFAULT_DEBOUNCE_MS),
        ] {
            std::fs::write(&file, text).unwrap();
            assert_eq!(settings(dir.path()).debounce_ms, expected, "{text}");
        }
    }
}
