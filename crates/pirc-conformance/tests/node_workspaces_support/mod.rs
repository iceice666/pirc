//! Masking of the workspace ids a node generates (`workspace_<uuid with
//! underscores>`, which the transcript's uuid pattern does not match), and
//! the canonical JSON a project's trust hash covers.

#![allow(dead_code)]

use serde_json::Value;

/// Replaces generated values the transcript's normalizer does not know
/// before a value reaches it: directory workspace ids
/// (`workspace_<uuid with underscores>`) become `<workspace:N>`.
#[derive(Default)]
pub struct Ids {
    known: Vec<(String, String)>,
}

impl Ids {
    /// Give `id` the next placeholder (once).
    pub fn add(&mut self, id: &str) {
        if !self.known.iter().any(|(known, _)| known == id) {
            let placeholder = format!("<workspace:{}>", self.known.len() + 1);
            self.known.push((id.to_owned(), placeholder));
        }
    }

    /// Every `workspace_…` id in `value` gets a placeholder, in order of appearance.
    pub fn learn(&mut self, value: &Value) {
        match value {
            Value::String(text) => {
                for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                    if is_workspace_id(word) {
                        self.add(word);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| self.learn(item)),
            Value::Object(object) => {
                for (key, item) in object {
                    self.learn(&Value::String(key.clone()));
                    self.learn(item);
                }
            }
            _ => {}
        }
    }

    pub fn text(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (id, placeholder) in &self.known {
            text = text.replace(id.as_str(), placeholder);
        }
        text
    }

    /// `value` with known ids replaced (learning new ones first).
    pub fn value(&mut self, value: &Value) -> Value {
        self.learn(value);
        self.mask(value)
    }

    fn mask(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => items.iter().map(|item| self.mask(item)).collect(),
            Value::Object(object) => object
                .iter()
                .map(|(key, item)| (self.text(key), self.mask(item)))
                .collect::<serde_json::Map<_, _>>()
                .into(),
            other => other.clone(),
        }
    }

    pub fn response(
        &mut self,
        response: &pirc_conformance::Response,
    ) -> pirc_conformance::Response {
        let mut response = response.clone();
        response.body = self.value(&response.body);
        response
    }
}

fn is_workspace_id(word: &str) -> bool {
    let Some(rest) = word.strip_prefix("workspace_") else {
        return false;
    };
    let groups: Vec<&str> = rest.split('_').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length
                && group
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        })
}

/// JSON with object keys sorted at every level, numbers and strings as
/// `JSON.stringify` writes them (TS `canonicalJson` in agent/config.ts).
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let inner: Vec<String> = entries
                .into_iter()
                .map(|(key, item)| {
                    format!("{}:{}", Value::String(key.clone()), canonical_json(item))
                })
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        other => other.to_string(),
    }
}
