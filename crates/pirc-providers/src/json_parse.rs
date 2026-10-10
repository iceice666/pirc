//! Streaming tool-argument parsing, ported from pi-ai 0.73.1
//! (`utils/json-parse.js`) and the `partial-json` 0.1.7 package it uses.
//! Positions are counted in `char`s where JavaScript counts UTF-16 units;
//! every scan stops at ASCII characters, so the results are the same.

use serde_json::{Map, Value};

/// `JSON.parse`. `Infinity`-producing number literals fail here, where
/// JavaScript yields `Infinity`.
fn json_parse(text: &str) -> Result<Value, ()> {
    serde_json::from_str(text).map_err(|_| ())
}

fn is_control(c: char) -> bool {
    (c as u32) <= 0x1f
}

fn escape_control(c: char) -> String {
    match c {
        '\u{8}' => "\\b".to_owned(),
        '\u{c}' => "\\f".to_owned(),
        '\n' => "\\n".to_owned(),
        '\r' => "\\r".to_owned(),
        '\t' => "\\t".to_owned(),
        other => format!("\\u{:04x}", other as u32),
    }
}

/// Escape raw control characters inside strings and double backslashes
/// before invalid escape characters (`repairJson`).
pub fn repair_json(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut repaired = String::with_capacity(json.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if !in_string {
            repaired.push(c);
            if c == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }
        if c == '"' {
            repaired.push(c);
            in_string = false;
            index += 1;
            continue;
        }
        if c == '\\' {
            let Some(&next) = chars.get(index + 1) else {
                repaired.push_str("\\\\");
                index += 1;
                continue;
            };
            if next == 'u' {
                let digits: String = chars.iter().skip(index + 2).take(4).collect();
                if digits.len() == 4 && digits.chars().all(|d| d.is_ascii_hexdigit()) {
                    repaired.push_str("\\u");
                    repaired.push_str(&digits);
                    index += 6;
                    continue;
                }
            }
            if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') {
                repaired.push('\\');
                repaired.push(next);
                index += 2;
                continue;
            }
            repaired.push_str("\\\\");
            index += 1;
            continue;
        }
        if is_control(c) {
            repaired.push_str(&escape_control(c));
        } else {
            repaired.push(c);
        }
        index += 1;
    }
    repaired
}

fn parse_json_with_repair(json: &str) -> Result<Value, ()> {
    json_parse(json).or_else(|()| {
        let repaired = repair_json(json);
        if repaired != json {
            json_parse(&repaired)
        } else {
            Err(())
        }
    })
}

/// Parse possibly incomplete JSON; `{}` when nothing can be recovered
/// (`parseStreamingJson`).
pub fn parse_streaming_json(partial: &str) -> Value {
    if partial.trim().is_empty() {
        return Value::Object(Map::new());
    }
    if let Ok(value) = parse_json_with_repair(partial) {
        return value;
    }
    let or_empty = |value: Value| {
        if value.is_null() {
            Value::Object(Map::new())
        } else {
            value
        }
    };
    if let Ok(value) = partial_parse(partial) {
        return or_empty(value);
    }
    match partial_parse(&repair_json(partial)) {
        Ok(value) => or_empty(value),
        Err(()) => Value::Object(Map::new()),
    }
}

/// `partial-json`'s `parse(text, Allow.ALL)`. Errors carry no detail: every
/// caller only distinguishes success from failure.
pub fn partial_parse(text: &str) -> Result<Value, ()> {
    let trimmed = crate::js::trim(text);
    if trimmed.is_empty() {
        return Err(());
    }
    let mut parser = Partial {
        s: trimmed.chars().collect(),
        index: 0,
    };
    parser.parse_any()
}

struct Partial {
    s: Vec<char>,
    index: usize,
}

impl Partial {
    fn len(&self) -> usize {
        self.s.len()
    }

    fn at(&self, index: usize) -> Option<char> {
        self.s.get(index).copied()
    }

    /// `String.prototype.substring`: clamps and swaps its bounds.
    fn substring(&self, start: isize, end: isize) -> String {
        let clamp = |value: isize| value.clamp(0, self.len() as isize) as usize;
        let (mut a, mut b) = (clamp(start), clamp(end));
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        self.s[a..b].iter().collect()
    }

    fn last_index_of(&self, c: char) -> isize {
        self.s
            .iter()
            .rposition(|&x| x == c)
            .map_or(-1, |index| index as isize)
    }

    fn rest_is_prefix_of(&self, word: &str) -> bool {
        let rest = self.substring(self.index as isize, self.len() as isize);
        word.starts_with(&rest)
    }

    fn starts_with_at(&self, word: &str) -> bool {
        let end = self.index + word.chars().count();
        end <= self.len() && self.s[self.index..end].iter().copied().eq(word.chars())
    }

    fn skip_blank(&mut self) {
        while self.index < self.len() && matches!(self.s[self.index], ' ' | '\n' | '\r' | '\t') {
            self.index += 1;
        }
    }

    fn parse_any(&mut self) -> Result<Value, ()> {
        self.skip_blank();
        if self.index >= self.len() {
            return Err(());
        }
        match self.s[self.index] {
            '"' => return self.parse_str(),
            '{' => return self.parse_obj(),
            '[' => return self.parse_arr(),
            _ => {}
        }
        let remaining = self.len() - self.index;
        let literals: [(&str, Value, usize); 6] = [
            ("null", Value::Null, 4),
            ("true", Value::Bool(true), 4),
            ("false", Value::Bool(false), 5),
            // JavaScript yields ±Infinity and NaN, which JSON (and the
            // wire) can only carry as null.
            ("Infinity", Value::Null, 8),
            ("-Infinity", Value::Null, 9),
            ("NaN", Value::Null, 3),
        ];
        for (word, value, length) in literals {
            let partial_ok = if word == "-Infinity" {
                1 < remaining && remaining < length
            } else {
                remaining < length
            };
            if self.starts_with_at(word) || (partial_ok && self.rest_is_prefix_of(word)) {
                self.index += length;
                return Ok(value);
            }
        }
        self.parse_num()
    }

    fn parse_str(&mut self) -> Result<Value, ()> {
        let start = self.index;
        let mut escape = false;
        self.index += 1;
        while self.index < self.len()
            && (self.s[self.index] != '"' || (escape && self.s[self.index - 1] == '\\'))
        {
            escape = if self.s[self.index] == '\\' {
                !escape
            } else {
                false
            };
            self.index += 1;
        }
        if self.at(self.index) == Some('"') {
            self.index += 1;
            let end = self.index as isize - isize::from(escape);
            return json_parse(&self.substring(start as isize, end));
        }
        let end = self.index as isize - isize::from(escape);
        json_parse(&(self.substring(start as isize, end) + "\"")).or_else(|()| {
            let cut = self.last_index_of('\\');
            json_parse(&(self.substring(start as isize, cut) + "\""))
        })
    }

    fn parse_obj(&mut self) -> Result<Value, ()> {
        self.index += 1;
        self.skip_blank();
        let mut object = Map::new();
        while self.at(self.index) != Some('}') {
            let before = self.index;
            self.skip_blank();
            if self.index >= self.len() {
                return Ok(Value::Object(object));
            }
            let Ok(key) = self.parse_str() else {
                return Ok(Value::Object(object));
            };
            self.skip_blank();
            self.index += 1;
            match self.parse_any() {
                Ok(value) => {
                    let key = match key {
                        Value::String(key) => key,
                        other => crate::js::to_js_string(&other),
                    };
                    object.insert(key, value);
                }
                Err(()) => return Ok(Value::Object(object)),
            }
            self.skip_blank();
            if self.at(self.index) == Some(',') {
                self.index += 1;
            }
            // JavaScript would loop forever here; stop instead.
            if self.index == before {
                return Ok(Value::Object(object));
            }
        }
        self.index += 1;
        Ok(Value::Object(object))
    }

    fn parse_arr(&mut self) -> Result<Value, ()> {
        self.index += 1;
        let mut array = Vec::new();
        while self.at(self.index) != Some(']') {
            let before = self.index;
            match self.parse_any() {
                Ok(value) => array.push(value),
                Err(()) => return Ok(Value::Array(array)),
            }
            self.skip_blank();
            if self.at(self.index) == Some(',') {
                self.index += 1;
            }
            if self.index == before {
                return Ok(Value::Array(array));
            }
        }
        self.index += 1;
        Ok(Value::Array(array))
    }

    fn parse_num(&mut self) -> Result<Value, ()> {
        if self.index == 0 {
            let whole: String = self.s.iter().collect();
            if whole == "-" {
                return Err(());
            }
            return json_parse(&whole)
                .or_else(|()| json_parse(&self.substring(0, self.last_index_of('e'))));
        }
        let start = self.index;
        if self.at(self.index) == Some('-') {
            self.index += 1;
        }
        while let Some(c) = self.at(self.index) {
            if matches!(c, ',' | ']' | '}') {
                break;
            }
            self.index += 1;
        }
        let literal = self.substring(start as isize, self.index as isize);
        json_parse(&literal).or_else(|()| {
            if literal == "-" {
                return Err(());
            }
            json_parse(&self.substring(start as isize, self.last_index_of('e')))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_complete_and_partial_json() {
        assert_eq!(parse_streaming_json(""), json!({}));
        assert_eq!(parse_streaming_json("  "), json!({}));
        assert_eq!(parse_streaming_json(r#"{"a":1}"#), json!({ "a": 1 }));
        assert_eq!(parse_streaming_json("null"), json!(null));
        assert_eq!(parse_streaming_json("[1]"), json!([1]));
        assert_eq!(
            parse_streaming_json(r#"{"path":"a"#),
            json!({ "path": "a" })
        );
        assert_eq!(parse_streaming_json(r#"{"pat"#), json!({}));
        assert_eq!(parse_streaming_json(r#"{"a":tru"#), json!({ "a": true }));
        assert_eq!(
            parse_streaming_json(r#"{"a":[1, 2"#),
            json!({ "a": [1, 2] })
        );
        assert_eq!(parse_streaming_json(r#"{"a":"x\"#), json!({ "a": "x" }));
        assert_eq!(parse_streaming_json(r#"{"a":-"#), json!({}));
        assert_eq!(parse_streaming_json(r#"{"a":1.5e"#), json!({ "a": 1.5 }));
        // Invalid escapes: the strict partial parse gives up on the key.
        assert_eq!(
            parse_streaming_json(r#"{"path":"a\qb", "n": [1, 2"#),
            json!({})
        );
    }

    #[test]
    fn repairs_strings() {
        assert_eq!(repair_json("{\"a\":\"x\ny\"}"), "{\"a\":\"x\\ny\"}");
        assert_eq!(repair_json(r#"{"a":"\q"}"#), r#"{"a":"\\q"}"#);
        assert_eq!(repair_json(r#"{"a":"\u00e9"}"#), r#"{"a":"\u00e9"}"#);
        assert_eq!(
            parse_streaming_json("{\"a\":\"x\ty\"}"),
            json!({ "a": "x\ty" })
        );
        assert_eq!(parse_streaming_json(r#"{"a":"\d"}"#), json!({ "a": "\\d" }));
    }
}
