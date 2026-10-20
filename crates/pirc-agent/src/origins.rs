//! Where what an agent knows came from (`currentOrigins`), and the user's
//! own words in its conversation (`findQuote`): the code that decides the
//! origin of a memory or a request, so the model never does. The chat
//! assistant used them; the brain's memory does now
//! (plans/rewrite/03-memory.md).

use icu_normalizer::ComposingNormalizerBorrowed;
use pirc_protocol::Message;

use crate::features::memory::serialize::{entry_origin, started_capabilities, user_text};
use crate::session_store::{EntryData, SessionEntry};
use crate::tools::js;

/// `words`: compare words, not typography: width, case, spacing and
/// surrounding quote marks.
pub fn quote_words(value: &str) -> String {
    let folded = ComposingNormalizerBorrowed::new_nfkc()
        .normalize(value)
        .to_lowercase();
    let mut spaced = String::with_capacity(folded.len());
    let mut space = false;
    for c in folded.chars() {
        if js::is_space(c) {
            if !space {
                spaced.push(' ');
            }
            space = true;
        } else {
            spaced.push(c);
            space = false;
        }
    }
    let quote = |c: char| "\"'“”‘’「」『』".contains(c);
    js::trim(js::trim(&spaced).trim_matches(quote)).to_owned()
}

/// `findQuote`: the newest message the human typed in this chat (`role:
/// 'user'`; features, delegations and teammates only add custom messages)
/// that contains `quote`.
pub fn find_quote(branch: &[SessionEntry], quote: &str) -> Option<String> {
    let wanted = quote_words(quote);
    if js::len16(&wanted) < 2 {
        return None;
    }
    branch.iter().rev().find_map(|entry| match &entry.data {
        EntryData::Message(Message::User { content, .. })
            if quote_words(&user_text(content)).contains(&wanted) =>
        {
            Some(entry.id.clone())
        }
        _ => None,
    })
}

/// The newest of the user's last `messages` messages in this chat that
/// contains `quote` (as [`find_quote`]): words they said a while ago are
/// not taken as asking for work now.
pub fn find_recent_quote(branch: &[SessionEntry], quote: &str, messages: usize) -> Option<String> {
    let wanted = quote_words(quote);
    if js::len16(&wanted) < 2 {
        return None;
    }
    branch
        .iter()
        .rev()
        .filter_map(|entry| match &entry.data {
            EntryData::Message(Message::User { content, .. }) => Some((entry, content)),
            _ => None,
        })
        .take(messages)
        .find_map(|(entry, content)| {
            quote_words(&user_text(content))
                .contains(&wanted)
                .then(|| entry.id.clone())
        })
}

/// `currentOrigins`: where what the agent knows right now came from:
/// itself (`assistant`), plus every tool result and custom message since
/// the user's last message (a page fetched with `bash` taints a note
/// written from it: such a result is `tool:bash:network`). Results of the
/// tools in `skip` (the ones that write memory) do not count.
pub fn current_origins(branch: &[SessionEntry], running: &[String], skip: &[&str]) -> Vec<String> {
    let mut origins = vec!["assistant".to_owned()];
    let mut add = |origin: String| {
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    };
    for entry in branch.iter().rev() {
        let EntryData::Message(message) = &entry.data else {
            continue;
        };
        match message {
            Message::User { .. } => break,
            Message::ToolResult { tool_name, .. } if skip.contains(&tool_name.as_str()) => {
                continue;
            }
            _ => {}
        }
        // A ptc result carries what its operations returned: judge by those.
        if let Some(started) = started_capabilities(message) {
            for name in &started {
                if !skip.contains(&name.as_str()) {
                    add(format!("tool:{name}"));
                }
            }
            // No operation ran, but hook output may still have been appended.
            if started.is_empty() {
                add(entry_origin(branch, message));
            }
            continue;
        }
        if matches!(message, Message::ToolResult { .. } | Message::Custom { .. }) {
            add(entry_origin(branch, message));
        }
    }
    for name in running {
        if !skip.contains(&name.as_str()) {
            add(format!("tool:{name}"));
        }
    }
    origins.sort_by(|a, b| js::compare16(a, b));
    origins
}
