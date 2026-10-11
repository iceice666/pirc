//! Messages between the agent (host) and the `ptc-guest` process running one
//! `ptc` script in QuickJS (`agent/ptc/protocol.ts`). TS used Bun's IPC
//! channel (JSON); here each message is one JSON line, host to guest on the
//! guest's stdin and guest to host on its stdout. The guest holds no
//! authority: it can only ask the host to run an operation; the host
//! validates every field, decides and keeps every record.
//!
//! Host to guest: `{"type":"start","code","manifest","store"}`, then
//! `{"type":"result","id","json"}`. Guest to host: `call`, `attach`, `log`,
//! `scope_open`, `scope_cancel`, `scope_close`, `idle` and `done`, with the
//! fields of `GuestMessage` in protocol.ts.

use std::borrow::Cow;

use crate::contracts::budgets;

/// `ROOT_SCOPE`: the scope of code outside any `tools.par`.
pub const ROOT_SCOPE: &str = "root";

/// `GUEST_LIMITS`: what the guest sends at most, so oversized script values
/// never cross the process boundary.
pub mod guest_limits {
    /// Arguments of one call (UTF-16 units; the host checks bytes again).
    pub const ARGS_CHARS: usize = super::budgets::ARGS_BYTES;
    pub const NAME_CHARS: usize = 65;
    /// A returned value; the model sees at most `toolOutputBytes` of it.
    pub const VALUE_CHARS: usize = 1024 * 1024;
}

/// `s.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 code units (a surrogate pair cut in two stays
/// whole: Rust strings cannot hold half of one).
pub fn head16(s: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in s.char_indices() {
        if count >= units {
            return &s[..index];
        }
        count += c.len_utf16();
    }
    s
}

/// JSON text with each unpaired UTF-16 surrogate escape (`\ud800` alone,
/// which `JSON.stringify` writes for a lone surrogate) replaced by
/// `\ufffd`: serde_json refuses them, JavaScript's `JSON.parse` did not.
pub fn well_formed_json(json: &str) -> Cow<'_, str> {
    if !json.contains("\\u") {
        return Cow::Borrowed(json);
    }
    let bytes = json.as_bytes();
    let hex = |at: usize| -> Option<u16> {
        let digits = json.get(at..at + 4)?;
        u16::from_str_radix(digits, 16).ok()
    };
    // `\uXXXX` at `at` (the backslash), when it is one.
    let escape = |at: usize| -> Option<u16> {
        (bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u'))
            .then(|| hex(at + 2))
            .flatten()
    };
    let mut out = String::with_capacity(json.len());
    let mut last = 0;
    let mut at = 0;
    let mut changed = false;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(unit) = escape(at) else {
            // Another escape (`\\`, `\"`, …): skip both characters.
            at += 2;
            continue;
        };
        let lone = match unit {
            0xD800..=0xDBFF => {
                if escape(at + 6).is_some_and(|next| (0xDC00..=0xDFFF).contains(&next)) {
                    at += 12;
                    continue;
                }
                true
            }
            0xDC00..=0xDFFF => true,
            _ => false,
        };
        if lone {
            out.push_str(&json[last..at]);
            out.push_str("\\ufffd");
            changed = true;
            last = at + 6;
        }
        at += 6;
    }
    if !changed {
        return Cow::Borrowed(json);
    }
    out.push_str(&json[last..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_unpaired_surrogate_escapes() {
        assert_eq!(well_formed_json(r#""a""#), r#""a""#);
        assert_eq!(well_formed_json(r#""\ud83d\ude00""#), r#""\ud83d\ude00""#);
        assert_eq!(well_formed_json(r#""\ud83d""#), r#""\ufffd""#);
        assert_eq!(well_formed_json(r#""\ude00x\ud800""#), r#""\ufffdx\ufffd""#);
        assert_eq!(well_formed_json(r#""\\ud800""#), r#""\\ud800""#);
        assert_eq!(well_formed_json(r#""\u0041""#), r#""\u0041""#);
        let parsed: serde_json::Value =
            serde_json::from_str(&well_formed_json(r#"{"s":"\ud800\u0041"}"#)).unwrap();
        assert_eq!(parsed["s"], "\u{fffd}A");
    }

    #[test]
    fn slices_by_utf16_units() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(head16("a😀b", 2), "a😀");
        assert_eq!(head16("abc", 2), "ab");
        assert_eq!(head16("ab", 5), "ab");
    }
}
