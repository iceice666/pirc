//! Public current-session text. Thinking, custom state and replay payloads are excluded.
use crate::{
    handoff,
    session_store::{EntryData, SessionEntry},
};
use pirc_protocol::{Message, UserContent};
use serde_json::{Value, json};

pub fn view(branch: &[SessionEntry], args: &Value, read: bool) -> Result<Value, String> {
    let a = args.as_object().ok_or("invalid_input")?;
    if a.keys()
        .any(|k| !["query", "entryId", "cursor", "limit"].contains(&k.as_str()))
    {
        return Err("invalid_input".into());
    }
    let tip = a
        .get("cursor")
        .filter(|v| !v.is_null())
        .and_then(|v| v["tip"].as_str())
        .or_else(|| branch.last().map(|e| e.id.as_str()))
        .ok_or("history_unavailable")?;
    let end = branch
        .iter()
        .position(|e| e.id == tip)
        .ok_or("history_changed")?
        + 1;
    let branch = &branch[..end];
    let public: Vec<_> = branch
        .iter()
        .filter(|e| {
            matches!(
                &e.data,
                EntryData::Message(
                    Message::User { .. } | Message::Assistant(_) | Message::ToolResult { .. }
                )
            ) || matches!(&e.data,EntryData::Custom{custom_type,..}if custom_type=="ptc.operation")
        })
        .cloned()
        .collect();
    let sources = handoff::sources(&public);
    let digest = crate::journal::digest(
        serde_json::to_string(&public)
            .map_err(|_| "history_unavailable")?
            .as_bytes(),
    );
    let query = a.get("query").and_then(Value::as_str).unwrap_or("");
    if query.len() > 1000 || (!read && query.is_empty()) {
        return Err("invalid_input".into());
    }
    let entry = a.get("entryId").and_then(Value::as_str);
    if read && !entry.is_some_and(handoff::key) {
        return Err("invalid_input".into());
    }
    let mut selected = Vec::new();
    if read {
        let index = branch
            .iter()
            .position(|e| Some(e.id.as_str()) == entry)
            .ok_or("not_found")?;
        if !public.iter().any(|e| e.id == branch[index].id) {
            return Err("not_found".into());
        }
        let start = branch[..=index]
            .iter()
            .rposition(|e| matches!(e.data, EntryData::Message(Message::User { .. })))
            .unwrap_or(index);
        let end = branch
            .iter()
            .enumerate()
            .skip(index + 1)
            .find(|(_, e)| matches!(e.data, EntryData::Message(Message::User { .. })))
            .map_or(branch.len(), |(i, _)| i);
        for source in sources {
            if branch[start..end].iter().any(|e| e.id == source.entry_id) {
                selected.push(source)
            }
        }
    } else {
        selected.extend(
            sources
                .into_iter()
                .filter(|s| s.text.to_lowercase().contains(&query.to_lowercase())),
        );
    }
    let identity =
        crate::journal::digest(json!([digest, read, entry, query]).to_string().as_bytes());
    let mut index = 0usize;
    let mut char_at = 0usize;
    if let Some(cursor) = a.get("cursor") {
        let c = cursor.as_object().ok_or("invalid_input")?;
        if c.len() != 4 || c.get("fingerprint").and_then(Value::as_str) != Some(&identity) {
            return Err("history_changed".into());
        }
        index = c["index"]
            .as_u64()
            .and_then(|x| usize::try_from(x).ok())
            .ok_or("invalid_input")?;
        char_at = c["offset"]
            .as_u64()
            .and_then(|x| usize::try_from(x).ok())
            .ok_or("invalid_input")?;
    }
    let limit = a
        .get("limit")
        .map_or(Some(12000), |v| {
            v.as_u64().filter(|n| *n > 0 && *n <= 32000)
        })
        .ok_or("invalid_input")? as usize;
    if index > selected.len() {
        return Err("invalid_input".into());
    }
    let mut output = Vec::new();
    let mut left = limit;
    while index < selected.len() && left > 0 && output.len() < 50 {
        let s = &selected[index];
        let text: Vec<_> = s.text.chars().collect();
        if char_at > text.len() {
            return Err("invalid_input".into());
        }
        let end = (char_at + left).min(text.len());
        let shown = text[char_at..end].iter().collect::<String>();
        output.push(json!({"entryId":s.entry_id,"role":s.role,"timestamp":s.timestamp,"text":shown,"offset":char_at,"totalChars":text.len(),"derived":s.derived}));
        left -= end - char_at;
        if end == text.len() {
            index += 1;
            char_at = 0
        } else {
            char_at = end;
            break;
        }
    }
    Ok(
        json!({"sources":output,"cursor":if index<selected.len(){json!({"fingerprint":identity,"index":index,"offset":char_at,"tip":tip})}else{Value::Null},"memoryReplay":true,"limitations":"Public text only; private thinking/state and pixels are omitted. Retrieved evidence is not a new observation."}),
    )
}

pub fn header_id(branch: &[SessionEntry]) -> Result<String, String> {
    match branch.first().map(|e| &e.data) {
        Some(EntryData::Session { session_id, .. }) => Ok(session_id.clone()),
        _ => Err("invalid_session_header".into()),
    }
}
pub fn original_human(e: &SessionEntry) -> Option<String> {
    match &e.data {
        EntryData::Message(Message::User {
            content: UserContent::Text(s),
            ..
        }) => Some(s.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn entry(id: &str, parent: Option<&str>, data: EntryData) -> SessionEntry {
        SessionEntry {
            id: id.into(),
            parent_id: parent.map(str::to_owned),
            timestamp: 1,
            data,
        }
    }
    fn branch() -> Vec<SessionEntry> {
        vec![entry("h",None,EntryData::Session{session_id:"s".into(),cwd:"/".into()}),entry("u",Some("h"),EntryData::Message(serde_json::from_value(json!({"role":"user","content":"alpha original 😀 evidence","timestamp":1})).unwrap())),entry("private",Some("u"),EntryData::Custom{custom_type:"ptc.store".into(),data:json!({"store":"secret private state"})}),entry("a",Some("private"),EntryData::Message(serde_json::from_value(json!({"role":"assistant","content":[{"type":"thinking","thinking":"secret reasoning","thinkingSignature":"private"},{"type":"text","text":"Public answer"}],"api":"x","provider":"p","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"stop","timestamp":1})).unwrap()))]
    }
    #[test]
    fn bounded_pages_survive_append_without_truncating_original_text() {
        let mut b = branch();
        let mut cursor = Value::Null;
        let mut text = String::new();
        loop {
            let mut args = json!({"query":"alpha","limit":5});
            if !cursor.is_null() {
                args["cursor"] = cursor;
            }
            let page = view(&b, &args, false).unwrap();
            for source in page["sources"].as_array().unwrap() {
                text.push_str(source["text"].as_str().unwrap())
            }
            cursor = page["cursor"].clone();
            if cursor.is_null() {
                break;
            }
            b.push(entry(
                &format!("extra{}", b.len()),
                b.last().map(|e| e.id.as_str()),
                EntryData::Message(
                    serde_json::from_value(
                        json!({"role":"user","content":"new alpha","timestamp":2}),
                    )
                    .unwrap(),
                ),
            ));
        }
        assert_eq!(text, "alpha original 😀 evidence");
    }
    #[test]
    fn never_exposes_private_state_or_thinking_and_rejects_foreign_paths() {
        let b = branch();
        let page = view(&b, &json!({"entryId":"u"}), true).unwrap().to_string();
        assert!(page.contains("Public answer"));
        assert!(!page.contains("secret reasoning"));
        assert!(!page.contains("secret private state"));
        assert!(view(&b, &json!({"entryId":"private"}), true).is_err());
        assert!(view(&b, &json!({"query":"alpha","sessionId":"foreign"}), false).is_err());
        assert!(view(&b, &json!({"entryId":"/other/session.jsonl"}), true).is_err());
    }
    #[test]
    fn source_replacement_invalidates_a_frozen_cursor() {
        let mut b = branch();
        let page = view(&b, &json!({"query":"alpha","limit":2}), false).unwrap();
        if let EntryData::Message(Message::User { content, .. }) = &mut b[1].data {
            *content = UserContent::Text("changed alpha".into());
        }
        assert_eq!(
            view(&b, &json!({"query":"alpha","cursor":page["cursor"]}), false).unwrap_err(),
            "history_changed"
        );
    }
}
