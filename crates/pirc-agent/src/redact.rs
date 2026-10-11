//! `redactSecrets` (`agent/features/memory/redact.ts`): best-effort removal
//! of credentials from text that outlives its session (recap reports,
//! memory). Covers well-known token formats plus the literal values of this
//! process's secret-looking environment variables; arbitrary secrets in
//! other formats are not detected. Shared by `recap` and, later, memory.

use std::sync::LazyLock;

use regex_lite::Regex;

use crate::tools::js;

/// JavaScript's `\s`, for the one pattern that uses it (`regex_lite`'s
/// `\s` is ASCII only).
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// `PATTERNS`, in order. `regex_lite`'s `\b` and case folding are ASCII,
/// as JavaScript's are without the `u` flag.
static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
                .to_owned(),
            "[REDACTED PRIVATE KEY]",
        ),
        (
            r"\b(pirc_dev_)[A-Za-z0-9_-]{16,}".to_owned(),
            "${1}[REDACTED]",
        ),
        (r"\b(sk-)[A-Za-z0-9_-]{20,}".to_owned(), "${1}[REDACTED]"),
        (
            r"\b(github_pat_)[A-Za-z0-9_]{20,}".to_owned(),
            "${1}[REDACTED]",
        ),
        (
            r"\b(gh[pousr]_)[A-Za-z0-9]{30,}".to_owned(),
            "${1}[REDACTED]",
        ),
        (
            r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b".to_owned(),
            "[REDACTED AWS KEY]",
        ),
        (
            format!(r"(?i)\b(Bearer{JS_SPACE}+)[A-Za-z0-9._~+/-]{{16,}}=*"),
            "${1}[REDACTED]",
        ),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(&pattern).unwrap(), replacement))
    .collect()
});

static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL").unwrap()
});

const MIN_SECRET_LENGTH: usize = 16;

/// `redactSecrets(text)` with this process's environment.
pub fn redact_secrets(text: &str) -> String {
    let env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    redact_with(text, &env)
}

/// `redactSecrets(text, env)`.
pub fn redact_with(text: &str, env: &[(String, String)]) -> String {
    let mut values: Vec<&(String, String)> = env
        .iter()
        .filter(|(name, value)| js::len16(value) >= MIN_SECRET_LENGTH && SECRET_NAME.is_match(name))
        .collect();
    // Longest first, so a secret containing another is replaced whole.
    values.sort_by_key(|(_, value)| std::cmp::Reverse(js::len16(value)));
    let mut out = text.to_owned();
    for (name, value) in values {
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("[REDACTED {name}]"));
        }
    }
    for (pattern, replacement) in PATTERNS.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_token_formats_and_secret_variables() {
        let env = vec![
            ("MY_API_KEY".to_owned(), "abcdefghijklmnop".to_owned()),
            ("LONG_TOKEN".to_owned(), "abcdefghijklmnopqrstu".to_owned()),
            ("SHORT_TOKEN".to_owned(), "short".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin:/usr/local/bin".to_owned()),
        ];
        assert_eq!(
            redact_with("a abcdefghijklmnopqrstu b abcdefghijklmnop short", &env),
            "a [REDACTED LONG_TOKEN] b [REDACTED MY_API_KEY] short"
        );
        let text = "sk-abcdefghijklmnopqrstuvwxyz1234 xsk-abcdefghijklmnopqrstuvwxyz \
            pirc_dev_0123456789abcdefXYZ ghp_012345678901234567890123456789ab \
            github_pat_0123456789abcdefghij AKIA0123456789ABCDEF bearer\u{3000}abcdefghijklmnop== \
            -----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----";
        assert_eq!(
            redact_with(text, &[]),
            "sk-[REDACTED] xsk-abcdefghijklmnopqrstuvwxyz \
            pirc_dev_[REDACTED] ghp_[REDACTED] \
            github_pat_[REDACTED] [REDACTED AWS KEY] bearer\u{3000}[REDACTED] \
            [REDACTED PRIVATE KEY]"
        );
    }
}
