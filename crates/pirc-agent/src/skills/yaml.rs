//! Front matter YAML as `Bun.YAML.parse` reads it: YAML 1.2 with the core
//! schema (`True`, `0o17`, `.inf`; not 1.1's `yes`/`on`), merge keys, map
//! keys as JavaScript strings, several documents as an array.

use indexmap::IndexMap;
use yaml_rust2::parser::{Event, EventReceiver, Parser, Tag};
use yaml_rust2::scanner::TScalarStyle;

use crate::messages::js;

/// A parsed value, as JavaScript holds it.
#[derive(Clone, Debug, PartialEq)]
pub enum Yaml {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Seq(Vec<Yaml>),
    Map(IndexMap<String, Yaml>),
}

impl Yaml {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    /// `String(value)`.
    pub fn js_string(&self) -> String {
        match self {
            Self::Null => "null".to_owned(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) => js::number_text(*number),
            Self::String(text) => text.clone(),
            Self::Seq(items) => items
                .iter()
                .map(|item| match item {
                    Self::Null => String::new(),
                    other => other.js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::Map(_) => "[object Object]".to_owned(),
        }
    }
}

/// `Bun.YAML.parse(text)`.
pub fn parse(text: &str) -> Result<Yaml, String> {
    let mut builder = Builder::default();
    let mut parser = Parser::new_from_str(text);
    parser
        .load(&mut builder, true)
        .map_err(|error| error_text(&error.to_string()))?;
    if let Some(error) = builder.error {
        return Err(error);
    }
    let mut docs = builder.docs;
    Ok(match docs.len() {
        0 => Yaml::Null,
        1 => docs.remove(0),
        _ => Yaml::Seq(docs),
    })
}

/// Bun's error texts for the kinds of mistakes it names.
fn error_text(info: &str) -> String {
    let lower = info.to_lowercase();
    let reason = if lower.contains("anchor") || lower.contains("alias") {
        "Unresolved alias"
    } else if lower.contains("tab") {
        "Tab characters cannot be used as indentation"
    } else if lower.contains("end of stream") || lower.contains("unexpected end") {
        "Unexpected EOF"
    } else {
        "Unexpected token"
    };
    format!("YAML Parse error: {reason}")
}

enum Frame {
    Seq(Vec<Yaml>, usize),
    Map {
        map: IndexMap<String, Yaml>,
        key: Option<(Yaml, bool)>,
        anchor: usize,
    },
}

#[derive(Default)]
struct Builder {
    docs: Vec<Yaml>,
    stack: Vec<Frame>,
    anchors: std::collections::HashMap<usize, Yaml>,
    /// The scalar just read was the plain merge key `<<`.
    merge: bool,
    error: Option<String>,
}

impl Builder {
    fn finish(&mut self, value: Yaml, anchor: usize) {
        if anchor > 0 {
            self.anchors.insert(anchor, value.clone());
        }
        let merge = std::mem::take(&mut self.merge);
        match self.stack.last_mut() {
            None => self.docs.push(value),
            Some(Frame::Seq(items, _)) => items.push(value),
            Some(Frame::Map { map, key, .. }) => match key.take() {
                None => *key = Some((value, merge)),
                Some((_, true)) => merge_into(map, value),
                Some((name, false)) => {
                    map.insert(name.js_string(), value);
                }
            },
        }
    }
}

/// `<<: *base` (or a list of them): keys not yet set.
fn merge_into(map: &mut IndexMap<String, Yaml>, value: Yaml) {
    match value {
        Yaml::Map(source) => {
            for (key, item) in source {
                map.entry(key).or_insert(item);
            }
        }
        Yaml::Seq(items) => {
            for item in items {
                merge_into(map, item);
            }
        }
        other => {
            map.entry("<<".to_owned()).or_insert(other);
        }
    }
}

fn is_str_tag(tag: Option<&Tag>) -> bool {
    tag.is_some_and(|tag| tag.handle == "tag:yaml.org,2002:" && tag.suffix == "str")
}

impl EventReceiver for Builder {
    fn on_event(&mut self, event: Event) {
        if self.error.is_some() {
            return;
        }
        match event {
            Event::Scalar(value, style, anchor, tag) => {
                let resolved = if style == TScalarStyle::Plain && !is_str_tag(tag.as_ref()) {
                    resolve_plain(&value)
                } else {
                    Yaml::String(value.clone())
                };
                let is_key = matches!(self.stack.last(), Some(Frame::Map { key: None, .. }));
                self.merge = is_key && style == TScalarStyle::Plain && value == "<<";
                self.finish(resolved, anchor);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq(Vec::new(), anchor)),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                map: IndexMap::new(),
                key: None,
                anchor,
            }),
            Event::SequenceEnd => {
                if let Some(Frame::Seq(items, anchor)) = self.stack.pop() {
                    self.finish(Yaml::Seq(items), anchor);
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Map { map, anchor, .. }) = self.stack.pop() {
                    self.finish(Yaml::Map(map), anchor);
                }
            }
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(value) => self.finish(value, 0),
                None => self.error = Some("YAML Parse error: Unresolved alias".to_owned()),
            },
            Event::DocumentStart => self.anchors.clear(),
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => {}
        }
    }
}

fn all_digits(text: &str, radix: u32) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_digit(radix))
}

fn radix_value(digits: &str, radix: u32) -> f64 {
    digits.chars().fold(0.0, |total, c| {
        total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    })
}

/// `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`
fn is_core_float(text: &str) -> bool {
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", fraction)) => all_digits(fraction, 10),
        Some((whole, fraction)) => {
            all_digits(whole, 10) && (fraction.is_empty() || all_digits(fraction, 10))
        }
        None => all_digits(mantissa, 10),
    };
    let exponent_ok = exponent.is_none_or(|exponent| {
        all_digits(exponent.strip_prefix(['-', '+']).unwrap_or(exponent), 10)
    });
    mantissa_ok && exponent_ok
}

/// The core schema's resolution of a plain scalar.
fn resolve_plain(text: &str) -> Yaml {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Yaml::Null,
        "true" | "True" | "TRUE" => return Yaml::Bool(true),
        "false" | "False" | "FALSE" => return Yaml::Bool(false),
        ".nan" | ".NaN" | ".NAN" => return Yaml::Number(f64::NAN),
        _ => {}
    }
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let signed = |value: f64| Yaml::Number(if negative { -value } else { value });
    if matches!(body, ".inf" | ".Inf" | ".INF") {
        return signed(f64::INFINITY);
    }
    if let Some(hex) = body.strip_prefix("0x")
        && all_digits(hex, 16)
    {
        return signed(radix_value(hex, 16));
    }
    if let Some(octal) = body.strip_prefix("0o")
        && all_digits(octal, 8)
    {
        return signed(radix_value(octal, 8));
    }
    if is_core_float(text)
        && let Ok(value) = text.parse::<f64>()
    {
        return Yaml::Number(if value == 0.0 { 0.0 } else { value });
    }
    Yaml::String(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> String {
        fn value(yaml: &Yaml) -> serde_json::Value {
            match yaml {
                Yaml::Null => serde_json::Value::Null,
                Yaml::Bool(flag) => (*flag).into(),
                Yaml::Number(number) if number.is_finite() => js::number_value(*number),
                Yaml::Number(_) => serde_json::Value::Null,
                Yaml::String(text) => text.as_str().into(),
                Yaml::Seq(items) => items.iter().map(value).collect(),
                Yaml::Map(map) => map.iter().map(|(k, v)| (k.clone(), value(v))).collect(),
            }
        }
        match parse(text) {
            Ok(yaml) => js::stringify(&value(&yaml)),
            Err(error) => format!("ERR {error}"),
        }
    }

    /// Recorded from `Bun.YAML.parse` (Bun 1.4.2), as `JSON.stringify`.
    #[test]
    fn reads_like_bun() {
        for (text, expected) in [
            ("thinking: off", r#"{"thinking":"off"}"#),
            ("a: yes", r#"{"a":"yes"}"#),
            ("a: 0x10", r#"{"a":16}"#),
            ("a: 1e3", r#"{"a":1000}"#),
            ("a: .inf", r#"{"a":null}"#),
            ("a: ~", r#"{"a":null}"#),
            ("a: 012", r#"{"a":12}"#),
            ("a: '1'", r#"{"a":"1"}"#),
            (
                "a: true\nb: True\nc: TRUE",
                r#"{"a":true,"b":true,"c":true}"#,
            ),
            (
                "description: >\n  folded\n  text\n\n  para\nx: 1",
                r#"{"description":"folded text\npara\n","x":1}"#,
            ),
            (
                "description: |\n  lit\n  text\n",
                r#"{"description":"lit\ntext\n"}"#,
            ),
            ("tools: [read, grep]", r#"{"tools":["read","grep"]}"#),
            (
                "model:\n  - anthropic/*\n  - \"*/gpt-5\"",
                r#"{"model":["anthropic/*","*/gpt-5"]}"#,
            ),
            ("- a\n- b", r#"["a","b"]"#),
            ("", "null"),
            ("# c\n", "null"),
            ("a: 1\na: 2", r#"{"a":2}"#),
            (
                "a: plain\n  continued\n  line",
                r#"{"a":"plain continued line"}"#,
            ),
            (
                "metadata:\n  k: v\n  n: [1, 2]",
                r#"{"metadata":{"k":"v","n":[1,2]}}"#,
            ),
            ("a: 'it''s'", r#"{"a":"it's"}"#),
            ("a: \"x\\ty\\u00e9\"", "{\"a\":\"x\\tyé\"}"),
            ("a: &x 1\nb: *x", r#"{"a":1,"b":1}"#),
            ("a: !!str 1", r#"{"a":"1"}"#),
            ("a: 1_000", r#"{"a":"1_000"}"#),
            ("a: 0o17", r#"{"a":15}"#),
            ("a: +1", r#"{"a":1}"#),
            ("a: -.5", r#"{"a":-0.5}"#),
            ("a: 1.", r#"{"a":1}"#),
            ("a: Null", r#"{"a":null}"#),
            ("a: y", r#"{"a":"y"}"#),
            ("a:   ", r#"{"a":null}"#),
            ("a: x # comment", r#"{"a":"x"}"#),
            ("a: x#y", r#"{"a":"x#y"}"#),
            ("a: {b: 1, c: [2]}", r#"{"a":{"b":1,"c":[2]}}"#),
            ("a: 2001-12-14", r#"{"a":"2001-12-14"}"#),
            ("1: x", r#"{"1":"x"}"#),
            ("---\na: 1", r#"{"a":1}"#),
            ("a: 1\n...\n", r#"{"a":1}"#),
            ("a:\n- x\n- y", r#"{"a":["x","y"]}"#),
            ("foo\nbar", r#""foo bar""#),
            ("a: 0X10", r#"{"a":"0X10"}"#),
            ("a: -0x10", r#"{"a":-16}"#),
            ("a: 1E3", r#"{"a":1000}"#),
            ("a: .5", r#"{"a":0.5}"#),
            ("a: 0o8", r#"{"a":"0o8"}"#),
            ("a: 1e", r#"{"a":"1e"}"#),
            ("a: -0o7", r#"{"a":-7}"#),
            ("a: 0b11", r#"{"a":"0b11"}"#),
            ("a: -0", r#"{"a":0}"#),
            ("a: 9007199254740993", r#"{"a":9007199254740992}"#),
            ("a: inf", r#"{"a":"inf"}"#),
            ("a: -.nan", r#"{"a":"-.nan"}"#),
            ("a: 12:30", r#"{"a":"12:30"}"#),
            ("a: tRue", r#"{"a":"tRue"}"#),
            (
                "true: x\n~: y\n1.5: z\n[1,2]: w",
                r#"{"true":"x","null":"y","1.5":"z","1,2":"w"}"#,
            ),
            (
                "a: &a {x: 1}\nb:\n  <<: *a\n  y: 2",
                r#"{"a":{"x":1},"b":{"x":1,"y":2}}"#,
            ),
            ("a: !!int '5'", r#"{"a":"5"}"#),
            ("a: !!float 1", r#"{"a":1}"#),
            ("a: !foo bar", r#"{"a":"bar"}"#),
            ("a: 'x\n  y'", r#"{"a":"x y"}"#),
            ("a: |-\n  x\n  y\n\n", r#"{"a":"x\ny"}"#),
            ("a: |+\n  x\n\n", r#"{"a":"x\n\n"}"#),
            ("a: >-\n  x\n   y\n  z", r#"{"a":"x\n y\nz"}"#),
            ("{a: 1}", r#"{"a":1}"#),
            ("---\n---", "[null,null]"),
            ("a: 1\n---\nb: 2", r#"[{"a":1},{"b":2}]"#),
            ("a: [1,\n  2]", r#"{"a":[1,2]}"#),
            ("123", "123"),
            ("a: [a: b]", r#"{"a":[{"a":"b"}]}"#),
            ("a: {b}", r#"{"a":{"b":null}}"#),
            ("a: x\n b: y", "ERR YAML Parse error: Unexpected token"),
            ("a: [a, b", "ERR YAML Parse error: Unexpected token"),
            ("a: *nope", "ERR YAML Parse error: Unresolved alias"),
        ] {
            assert_eq!(json(text), expected, "{text:?}");
        }
    }

    #[test]
    fn stringifies_like_javascript() {
        assert_eq!(parse("[1, ~, x, [2]]").unwrap().js_string(), "1,,x,2");
        assert_eq!(parse("{a: 1}").unwrap().js_string(), "[object Object]");
        assert_eq!(parse(".inf").unwrap().js_string(), "Infinity");
    }
}
