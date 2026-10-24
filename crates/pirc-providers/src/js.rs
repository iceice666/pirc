//! Host settings compatibility: nullish lookup and JavaScript trimming.
use serde_json::Value;

/// `a ?? b` on property values: `null` counts as absent.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `String.prototype.trim`: Unicode white space (but U+0085, which
/// JavaScript does not count) plus the BOM.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
