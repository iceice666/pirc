use regex_lite::Regex;
use std::sync::LazyLock;
fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
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
