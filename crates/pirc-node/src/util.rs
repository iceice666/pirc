//! Small helpers shared by the node's modules (`apps/gateway/src/util.ts`).
//! The same as the gateway's `util.rs`; copied rather than shared, as the
//! two executables share no crate for them.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Milliseconds since the Unix epoch (`Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// `n` bytes from the operating system's random source.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes
}

/// A random (version 4) UUID, lowercase (`crypto.randomUUID()`).
pub fn uuid() -> String {
    let mut bytes = random_bytes::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `<prefix>_<uuid>` (`id(prefix)`): sessions, runs, interactions, uploads,
/// RPC ids.
pub fn prefix_uuid(prefix: &str) -> String {
    format!("{prefix}_{}", uuid())
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

pub fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(data.as_ref()))
}

/// The value with object keys sorted, so equal payloads hash equally, and
/// integral numbers written as integers (`JSON.stringify(1.0)` is `1`).
fn stable(value: &Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => number
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15)
            .map_or_else(|| value.clone(), |f| Value::from(f as i64)),
        Value::Array(items) => items.iter().map(stable).collect(),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, item)| (key.clone(), stable(item)))
                    .collect::<Map<_, _>>(),
            )
        }
        _ => value.clone(),
    }
}

/// SHA-256 of the payload's JSON with sorted keys: a command's identity
/// (`payloadHash`; byte order instead of `localeCompare`, as the gateway).
pub fn payload_hash(value: &Value) -> String {
    sha256_hex(stable(value).to_string())
}

/// Parse stored JSON, or `fallback` when it does not parse (`safeJson`).
pub fn safe_json(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

pub use pirc_config::text::utf16_head as head16;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn ids() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_ne!(uuid(), id);
        assert!(prefix_uuid("session").starts_with("session_"));
    }

    #[test]
    fn payload_hashes_ignore_key_order() {
        assert_eq!(
            payload_hash(&json!({ "a": 1, "b": { "c": 2, "d": [1, { "e": 1, "f": 2 }] } })),
            payload_hash(&json!({ "b": { "d": [1, { "f": 2, "e": 1 }], "c": 2 }, "a": 1 }))
        );
        assert_eq!(
            payload_hash(&json!({ "a": 1.0 })),
            payload_hash(&json!({ "a": 1 }))
        );
        assert_ne!(
            payload_hash(&json!({ "a": 1 })),
            payload_hash(&json!({ "a": 2 }))
        );
    }

    #[test]
    fn utf16_heads() {
        assert_eq!(head16("abc", 2), "ab");
        assert_eq!(head16("a😀b", 2), "a");
        assert_eq!(head16("a😀b", 3), "a😀");
        assert_eq!(head16("", 5), "");
    }
}
