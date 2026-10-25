//! Text as clients and models measure it: lengths and cuts in UTF-16 code
//! units (what the web client's `.length` counts, so budgets agree on both
//! sides), trimming that also drops a BOM, and JSON values as plain text.

use serde_json::Value;

use crate::frontmatter::js::{number_text, stringify};

/// White space, including a byte-order mark (which editors leave at the
/// start of files and JSON strings).
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `text` without leading and trailing [`is_space`] characters.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// The length in UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset after the longest prefix of at most `units` code units.
fn byte_at_unit(text: &str, units: usize) -> usize {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return index;
        }
    }
    text.len()
}

/// The first `units` code units, never more (a character of two units
/// at the boundary is left out).
pub fn utf16_head(text: &str, units: usize) -> &str {
    &text[..byte_at_unit(text, units)]
}

/// The last `units` code units, never more.
pub fn utf16_tail(text: &str, units: usize) -> &str {
    let total = utf16_len(text);
    if units >= total {
        return text;
    }
    let drop = total - units;
    let mut used = 0;
    for (index, c) in text.char_indices() {
        if used >= drop {
            return &text[index..];
        }
        used += c.len_utf16();
    }
    ""
}

/// A JSON value as text: strings as they are, numbers as JavaScript prints
/// them (`2`, not `2.0`), arrays and objects as JSON.
pub fn value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_i64()
            .map(|i| i.to_string())
            .or_else(|| n.as_u64().map(|u| u.to_string()))
            .unwrap_or_else(|| number_text(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => stringify(value),
    }
}

/// Whether a JSON value is "set": not absent, null, false, 0 or empty.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn measures_in_utf16_units() {
        assert_eq!(utf16_len("a😀b"), 4);
        assert_eq!(utf16_head("a😀b", 2), "a");
        assert_eq!(utf16_head("a😀b", 3), "a😀");
        assert_eq!(utf16_head("abc", 9), "abc");
        assert_eq!(utf16_tail("a😀b", 2), "b");
        assert_eq!(utf16_tail("a😀b", 3), "😀b");
        assert_eq!(utf16_tail("abc", 9), "abc");
        assert_eq!(utf16_tail("abc", 0), "");
    }

    #[test]
    fn trims_space_and_bom() {
        assert_eq!(trim("\u{feff} x \u{a0}\n"), "x");
        assert_eq!(trim_start("\u{feff}x "), "x ");
        assert_eq!(trim_end(" x\u{3000}"), " x");
    }

    #[test]
    fn values_as_text() {
        assert_eq!(value_text(&json!(2.0)), "2");
        assert_eq!(value_text(&json!(1.5)), "1.5");
        assert_eq!(value_text(&json!(-3)), "-3");
        assert_eq!(value_text(&json!("s")), "s");
        assert_eq!(value_text(&json!(null)), "null");
        assert_eq!(value_text(&json!([1, null])), "[1,null]");
        assert_eq!(value_text(&json!({"a": 1})), "{\"a\":1}");
        assert!(truthy(Some(&json!("x"))) && !truthy(Some(&json!(0))) && !truthy(None));
    }
}
