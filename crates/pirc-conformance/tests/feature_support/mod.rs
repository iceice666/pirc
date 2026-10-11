//! Shared by the M5 feature transcripts (`agent_goal*`, `agent_recap`,
//! `agent_gateway_tools*`, `agent_sandbox*`, `agent_browser*`): masking of
//! values only these features generate, and the usual turn helpers.

#![allow(dead_code)]

use std::collections::HashMap;

use pirc_conformance::{AgentRun, ModelReply, Recorder};
use serde_json::{Value, json};

const TIMINGS: [&str; 3] = ["activeMs", "durationMs", "waitedMs"];

/// Masks what the features generate per run, before [`Recorder`] sees it:
/// 12-digit hex ids (goal ids, `randomBytes(6)` envelopes) become
/// `<hex12:N>`, epoch milliseconds inside text `<epoch-ms>`, and today's
/// UTC date (`{{today}}` in tool descriptions) becomes `<today>`.
pub struct Masker {
    ids: HashMap<String, String>,
    today: String,
}

impl Default for Masker {
    fn default() -> Self {
        Self::new()
    }
}

impl Masker {
    pub fn new() -> Self {
        Self {
            ids: HashMap::new(),
            today: today(),
        }
    }

    pub fn mask(&mut self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(&text)),
            Value::Array(items) => items.into_iter().map(|item| self.mask(item)).collect(),
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, item)| {
                        // A `ptc` execution's timings.
                        if TIMINGS.contains(&key.as_str()) && item.is_number() {
                            return (key, json!("<ms>"));
                        }
                        (key, self.mask(item))
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    fn text(&mut self, text: &str) -> String {
        let bytes = text.as_bytes();
        let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
        // Neither a longer hex run nor part of a UUID or other dashed id.
        let edge =
            |b: Option<&u8>| b.is_none_or(|b| !hex(*b) && *b != b'-' && !b.is_ascii_alphanumeric());
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        while at < bytes.len() {
            if at + 12 <= bytes.len()
                && bytes[at..at + 12].iter().all(|b| hex(*b))
                && edge(if at == 0 { None } else { bytes.get(at - 1) })
                && edge(bytes.get(at + 12))
            {
                let id = &text[at..at + 12];
                let count = self.ids.len() + 1;
                let shown = self
                    .ids
                    .entry(id.to_owned())
                    .or_insert_with(|| format!("<hex12:{count}>"))
                    .clone();
                out.push_str(&shown);
                at += 12;
                continue;
            }
            // `ptc` attachment handles (keyed per execution).
            if text[at..].starts_with("att_")
                && at + 68 <= bytes.len()
                && bytes[at + 4..at + 68].iter().all(|b| hex(*b))
            {
                out.push_str("att_<handle>");
                at += 68;
                continue;
            }
            // Epoch milliseconds inside text (JSON a script returned).
            if at + 13 <= bytes.len()
                && bytes[at..at + 13].iter().all(u8::is_ascii_digit)
                && (at == 0 || !bytes[at - 1].is_ascii_digit())
                && bytes.get(at + 13).is_none_or(|b| !b.is_ascii_digit())
                && text[at..at + 13]
                    .parse::<u64>()
                    .is_ok_and(|ms| (1_500_000_000_000..=2_500_000_000_000).contains(&ms))
            {
                out.push_str("<epoch-ms>");
                at += 13;
                continue;
            }
            if text[at..].starts_with(&self.today)
                && bytes.get(at + self.today.len()) != Some(&b'T')
            {
                out.push_str("<today>");
                at += self.today.len();
                continue;
            }
            let c = text[at..].chars().next().unwrap();
            out.push(c);
            at += c.len_utf8();
        }
        out
    }

    pub fn note(&mut self, r: &mut Recorder, step: &str, value: Value) {
        let value = self.mask(value);
        r.note(step, value);
    }

    /// [`Recorder::turn`], masked.
    pub fn turn(&mut self, r: &mut Recorder, step: &str, agent: &AgentRun, events: Vec<Value>) {
        let events = self.mask(json!(events));
        r.note(&format!("{step}: events"), events);
        let requests = agent.take_requests();
        let requests = match self.mask(json!(requests)) {
            Value::Array(items) => items,
            _ => Vec::new(),
        };
        r.requests(&format!("{step}: model requests"), requests);
    }

    pub fn session(&mut self, r: &mut Recorder, agent: &AgentRun) {
        let entries = self.mask(json!(agent.session_entries()));
        r.note("session file", entries);
    }
}

/// Today's date in UTC (`new Date().toISOString().slice(0, 10)`).
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let days = (secs / 86_400) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn tools(calls: &[(&str, &str, Value)]) -> ModelReply {
    ModelReply::Tools(
        calls
            .iter()
            .map(|(id, name, args)| ((*id).to_owned(), (*name).to_owned(), args.clone()))
            .collect(),
    )
}

/// A `ptc` call running `code`.
pub fn ptc(id: &str, code: &str) -> ModelReply {
    ModelReply::tool(id, "ptc", json!({ "code": code }))
}

/// A `ptc` call of one capability through `tools.call`, as the TS tests'
/// `ptcCall` does: the script returns the result's text or throws its
/// error.
pub fn ptc_call(id: &str, name: &str, args: Value) -> ModelReply {
    ptc(
        id,
        &format!(
            "const r = await tools.call({}, {args});\nif (!r.ok) throw new PtcError(r.error);\nreturn r.data.text;",
            json!(name)
        ),
    )
}

/// A slash command (or any prompt): the lines up to its response, which
/// is included.
pub async fn command(
    agent: &mut AgentRun,
    m: &mut Masker,
    r: &mut Recorder,
    step: &str,
    text: &str,
) {
    let id = agent
        .command(json!({ "type": "prompt", "message": text }))
        .await;
    let lines = agent
        .until(|line| line["type"] == "response" && line["id"] == id.as_str())
        .await;
    m.note(r, step, json!(lines));
}

/// Lines up to (and with) the first that satisfies `done`, recorded.
pub async fn then(
    agent: &mut AgentRun,
    m: &mut Masker,
    r: &mut Recorder,
    step: &str,
    done: impl FnMut(&Value) -> bool,
) {
    let lines = agent.until(done).await;
    m.note(r, step, json!(lines));
}

/// Lines up to (and with) the first that satisfies `done`, without
/// responses.
pub async fn lines_until(agent: &mut AgentRun, done: impl FnMut(&Value) -> bool) -> Vec<Value> {
    agent
        .until(done)
        .await
        .into_iter()
        .filter(|line| line["type"] != "response")
        .collect()
}

/// Whether `line` is a `notify` whose message contains `text`.
pub fn notified(line: &Value, text: &str) -> bool {
    line["type"] == "extension_ui_request"
        && line["method"] == "notify"
        && line["message"].as_str().is_some_and(|m| m.contains(text))
}

/// A prompt (or a command that starts a run) and everything until the
/// agent settles; the model requests made meanwhile.
pub async fn turn(agent: &mut AgentRun, m: &mut Masker, r: &mut Recorder, step: &str, text: &str) {
    agent
        .command(json!({ "type": "prompt", "message": text }))
        .await;
    let events = agent.until(|line| line["type"] == "agent_settled").await;
    m.turn(r, step, agent, events);
}

/// Everything until the next `agent_settled` (a run the agent started by
/// itself), and the model requests made meanwhile.
pub async fn settle(agent: &mut AgentRun, m: &mut Masker, r: &mut Recorder, step: &str) {
    let events = agent.until(|line| line["type"] == "agent_settled").await;
    m.turn(r, step, agent, events);
}

/// [`turn`] when the agent starts another run by itself right after
/// (a goal round): only the events, since that run's model request may
/// arrive at any moment; a later [`settle`] or [`Masker::turn`] records
/// both runs' requests.
pub async fn turn_events(
    agent: &mut AgentRun,
    m: &mut Masker,
    r: &mut Recorder,
    step: &str,
    text: &str,
) {
    agent
        .command(json!({ "type": "prompt", "message": text }))
        .await;
    let events = agent.until(|line| line["type"] == "agent_settled").await;
    m.note(r, &format!("{step}: events"), json!(events));
}

/// [`settle`] followed by another automatic run: only the events.
pub async fn settle_events(agent: &mut AgentRun, m: &mut Masker, r: &mut Recorder, step: &str) {
    let events = agent.until(|line| line["type"] == "agent_settled").await;
    m.note(r, &format!("{step}: events"), json!(events));
}
