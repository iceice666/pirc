//! Secret-safe error texts: upstream bodies can contain request data or
//! credentials, so only fixed classifications leave the gateway.

use std::sync::LazyLock;

use regex_lite::Regex;

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
}

static SAFE_OVERFLOW: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?i)context.?length|context.?window|too many tokens|prompt is too long|input is too long|request too large|HTTP 413",
    )
});
static SAFE_STATUS: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)HTTP\s*(4\d\d|5\d\d)\b"));
static SAFE_RATE: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)rate.?limit|overloaded"));
static SAFE_TIMEOUT: LazyLock<Regex> = LazyLock::new(|| regex(r"(?i)timed? ?out|timeout"));
static SAFE_NETWORK: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)ECONNRESET|ECONNREFUSED|network|fetch failed|unable to connect"));

/// `safeInferenceError` (`backends/inference.ts`): keep actionable
/// classifications, never reflect upstream response bodies, URLs or tokens.
pub fn safe_inference_error(text: &str) -> String {
    if SAFE_OVERFLOW.is_match(text) {
        return "Model context window exceeded".to_owned();
    }
    if let Some(status) = SAFE_STATUS.captures(text).and_then(|c| c.get(1)) {
        return format!("Model request failed (HTTP {})", status.as_str());
    }
    if SAFE_RATE.is_match(text) {
        return "Model rate limit exceeded".to_owned();
    }
    if SAFE_TIMEOUT.is_match(text) {
        return "Model request timed out".to_owned();
    }
    if SAFE_NETWORK.is_match(text) {
        return "Model network request failed".to_owned();
    }
    "Model request failed; check backend configuration or sign in again".to_owned()
}

static PI_OVERFLOW: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?i)context.?length|context.?window|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|max_tokens.*exceed|request too large",
    )
});
static PI_RATE_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)rate.?limit|too many requests|usage limit|quota"));

/// The error text of a failed Pi stream (`fail()` in `backends/pi-adapter.ts`).
/// `status` is the status of a response that started streaming.
pub fn pi_failure(status: Option<u16>, upstream: Option<&str>) -> String {
    let upstream = upstream.filter(|text| !text.is_empty());
    let rate_limited = upstream.is_some_and(|text| PI_RATE_LIMIT.is_match(text));
    if status == Some(413)
        || upstream.is_some_and(|text| PI_OVERFLOW.is_match(text) && !rate_limited)
    {
        "Model context window exceeded.".to_owned()
    } else if let Some(status) = status.filter(|&status| status >= 400) {
        format!("Model provider request failed (HTTP {status}).")
    } else if rate_limited {
        "Model provider rate limit reached.".to_owned()
    } else {
        "Model provider request failed.".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_without_echoing() {
        assert_eq!(
            safe_inference_error("HTTP 500: secret body"),
            "Model request failed (HTTP 500)"
        );
        assert_eq!(
            safe_inference_error("HTTP 400: context_length_exceeded"),
            "Model context window exceeded"
        );
        assert_eq!(
            safe_inference_error("Overloaded"),
            "Model rate limit exceeded"
        );
        assert_eq!(
            safe_inference_error("Request timed out."),
            "Model request timed out"
        );
        assert_eq!(
            safe_inference_error("Unable to connect. Is the computer able to access the url?"),
            "Model network request failed"
        );
        assert_eq!(
            safe_inference_error("sk-secret"),
            "Model request failed; check backend configuration or sign in again"
        );
    }

    #[test]
    fn classifies_pi_failures() {
        assert_eq!(
            pi_failure(None, Some("400 This model's maximum context length is 8k")),
            "Model context window exceeded."
        );
        assert_eq!(
            pi_failure(None, Some("429 rate limit: context window")),
            "Model provider rate limit reached."
        );
        assert_eq!(
            pi_failure(Some(502), Some("x")),
            "Model provider request failed (HTTP 502)."
        );
        assert_eq!(
            pi_failure(Some(413), None),
            "Model context window exceeded."
        );
        assert_eq!(pi_failure(None, Some("")), "Model provider request failed.");
    }
}
