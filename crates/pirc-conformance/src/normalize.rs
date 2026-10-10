//! Turning recorded exchanges into stable snapshots. Values that differ on
//! every run (generated ids, tokens, times, temporary paths, ports) become
//! placeholders; equal values get equal placeholders, so a snapshot still
//! shows which id a later request refers to.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::client::Response;

/// Kinds of generated values, matched in this order. The shapes are exact
/// (lowercase hex, millisecond ISO times), so a changed format shows up as a
/// snapshot difference instead of being normalized away.
static PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("device-token", r"pirc_dev_[A-Za-z0-9_-]{43}"),
        ("sha256", r"\b[0-9a-f]{64}\b"),
        (
            "uuid",
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        ),
        ("time", r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"),
    ]
    .into_iter()
    .map(|(kind, pattern)| (kind, Regex::new(pattern).unwrap()))
    .collect()
});

/// Epoch milliseconds between 2017 and 2049 are taken to be timestamps.
const EPOCH_MS: std::ops::RangeInclusive<u64> = 1_500_000_000_000..=2_500_000_000_000;

#[derive(Default)]
pub struct Normalizer {
    /// Literal substrings and their replacements, longest first.
    literals: Vec<(String, String)>,
    seen: HashMap<(&'static str, String), String>,
    counts: HashMap<&'static str, usize>,
}

impl Normalizer {
    pub fn new(literals: impl IntoIterator<Item = (String, &'static str)>) -> Self {
        let mut normalizer = Self::default();
        for (value, placeholder) in literals {
            normalizer.literal(value, placeholder);
        }
        normalizer
    }

    /// Replace every occurrence of `value` with `placeholder`.
    fn literal(&mut self, value: impl Into<String>, placeholder: &str) {
        let value = value.into();
        if value.is_empty() {
            return;
        }
        self.literals.push((value, placeholder.to_owned()));
        self.literals
            .sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
    }

    pub fn value(&mut self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Number(number) => match number.as_u64() {
                Some(ms) if EPOCH_MS.contains(&ms) => json!("<epoch-ms>"),
                _ => value.clone(),
            },
            Value::Array(items) => items.iter().map(|item| self.value(item)).collect(),
            Value::Object(object) => {
                let mut out = Map::new();
                for (key, item) in object {
                    let item = self.value(item);
                    let key = self.text(key);
                    assert!(
                        !out.contains_key(&key),
                        "two keys normalize to {key:?} in {value}"
                    );
                    out.insert(key, item);
                }
                Value::Object(out)
            }
            Value::Null | Value::Bool(_) => value.clone(),
        }
    }

    pub fn text(&mut self, text: &str) -> String {
        let mut text = text.to_owned();
        for (value, placeholder) in &self.literals {
            if text.contains(value.as_str()) {
                text = text.replace(value.as_str(), placeholder);
            }
        }
        for (kind, pattern) in PATTERNS.iter() {
            if !pattern.is_match(&text) {
                continue;
            }
            let mut out = String::with_capacity(text.len());
            let mut last = 0;
            for found in pattern.find_iter(&text) {
                out.push_str(&text[last..found.start()]);
                out.push_str(&self.placeholder(kind, found.as_str()));
                last = found.end();
            }
            out.push_str(&text[last..]);
            text = out;
        }
        text
    }

    fn placeholder(&mut self, kind: &'static str, value: &str) -> String {
        if kind == "time" {
            return "<time>".to_owned();
        }
        let key = (kind, value.to_owned());
        if let Some(existing) = self.seen.get(&key) {
            return existing.clone();
        }
        let count = self.counts.entry(kind).or_default();
        *count += 1;
        let placeholder = format!("<{kind}:{count}>");
        self.seen.insert(key, placeholder.clone());
        placeholder
    }
}

/// The ordered, normalized steps of one scenario: the value a snapshot records.
pub struct Transcript {
    pub normalizer: Normalizer,
    steps: Vec<Value>,
}

impl Transcript {
    pub fn new(literals: impl IntoIterator<Item = (String, &'static str)>) -> Self {
        Self {
            normalizer: Normalizer::new(literals),
            steps: Vec::new(),
        }
    }

    /// Record an arbitrary observation.
    pub fn note(&mut self, step: &str, value: Value) {
        let value = self.normalizer.value(&value);
        self.steps.push(json!({ "step": step, "observed": value }));
    }

    /// Record a request line and its response. An error's `details` (the
    /// validation library's own report, which no client reads) is left out.
    pub fn response(&mut self, step: &str, request: &str, response: &Response) {
        let request = self.normalizer.text(request);
        let mut body = self.normalizer.value(&response.body);
        if let Some(error) = body.get_mut("error").and_then(Value::as_object_mut) {
            error.remove("details");
        }
        let mut recorded = json!({
            "step": step,
            "request": request,
            "status": response.status,
            "body": body,
        });
        if !response.headers.is_empty() {
            let headers: Map<String, Value> = response
                .headers
                .iter()
                .map(|(name, value)| (name.clone(), json!(value)))
                .collect();
            recorded["headers"] = Value::Object(headers);
        }
        self.steps.push(recorded);
    }

    pub fn into_value(self) -> Value {
        Value::Array(self.steps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_equal_ids_equal_and_distinct_ids_distinct() {
        let mut normalizer = Normalizer::default();
        let a = "session_0b1c6b8e-5d7a-4b55-9a3e-1c2d3e4f5a6b";
        let b = "0b1c6b8e-5d7a-4b55-9a3e-1c2d3e4f5a6c";
        let value = normalizer.value(&json!({ "id": a, "path": format!("/api/sessions/{a}"),
            "other": b }));
        assert_eq!(
            value,
            json!({ "id": "session_<uuid:1>", "path": "/api/sessions/session_<uuid:1>",
                "other": "<uuid:2>" })
        );
    }

    #[test]
    #[should_panic(expected = "two keys normalize to")]
    fn refuses_keys_that_collide_once_normalized() {
        let mut normalizer = Normalizer::default();
        normalizer.value(&json!({
            "0b1c6b8e-5d7a-4b55-9a3e-1c2d3e4f5a6b": 1,
            "<uuid:1>": 2,
        }));
    }

    #[test]
    fn records_responses_without_validation_details() {
        let mut transcript = Transcript::new([]);
        transcript.response(
            "bad",
            "POST /api/sessions",
            &Response {
                status: 400,
                headers: vec![("cache-control".to_owned(), "no-store".to_owned())],
                body: json!({ "error": { "code": "invalid_input", "message": "Invalid request",
                    "details": { "formErrors": [] } } }),
            },
        );
        assert_eq!(
            transcript.into_value(),
            json!([{ "step": "bad", "request": "POST /api/sessions", "status": 400,
                "headers": { "cache-control": "no-store" },
                "body": { "error": { "code": "invalid_input", "message": "Invalid request" } } }])
        );
    }

    #[test]
    fn replaces_tokens_times_and_literals() {
        let mut normalizer = Normalizer::new([("/tmp/pirc-x".to_owned(), "<tmp>")]);
        let token = format!("pirc_dev_{}", "a".repeat(43));
        let hash = "f2d9b9d0fc9eefb77a09c843302dfd2854476463eb9f2d461a868a38993e7920";
        let value = normalizer.value(&json!({
            "token": token,
            "at": 1_791_624_628_720u64,
            "small": 42,
            "iso": "2026-10-10T09:06:36.907Z",
            "isoSeconds": "2026-10-10T09:06:36Z",
            "upper": "0B1C6B8E-5D7A-4B55-9A3E-1C2D3E4F5A6C",
            "cwd": "/tmp/pirc-x/workspace",
            "payloadHash": hash,
            "again": hash,
        }));
        assert_eq!(
            value,
            json!({ "token": "<device-token:1>", "at": "<epoch-ms>", "small": 42,
                "iso": "<time>", "isoSeconds": "2026-10-10T09:06:36Z",
                "upper": "0B1C6B8E-5D7A-4B55-9A3E-1C2D3E4F5A6C", "cwd": "<tmp>/workspace",
                "payloadHash": "<sha256:1>", "again": "<sha256:1>" })
        );
    }
}
