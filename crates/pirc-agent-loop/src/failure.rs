//! What a failed reply's error message says about the failure.

use std::sync::LazyLock;

use pirc_llm_types::{AssistantMessage, StopReason};
use regex_lite::Regex;

use crate::{Failure, FailureKind};

static RETRYABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)HTTP (408|409|429|5\d\d)|rate.?limit|overloaded|timeout|timed out|ECONNRESET|ECONNREFUSED|socket|network|fetch failed|terminated|unable to connect",
    )
    .unwrap()
});

static RATE_LIMITED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)HTTP 429|rate.?limit|overloaded").unwrap());

static OVERFLOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)context.?length|context.?window|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|max_tokens.*exceed|request too large|HTTP 413",
    )
    .unwrap()
});

/// An error a later attempt may not get: a rate limit, an overload, a
/// 408/409/5xx, a dropped connection, a timeout. Says nothing about
/// whether retrying is safe (what was streamed, what the host allows).
pub fn is_retryable(message: &str) -> bool {
    !message.is_empty() && RETRYABLE.is_match(message)
}

/// `reply` failed because the request did not fit the model's context.
pub fn is_context_overflow(reply: &AssistantMessage) -> bool {
    reply.stop_reason == StopReason::Error
        && OVERFLOW.is_match(reply.error_message.as_deref().unwrap_or_default())
}

impl Failure {
    /// The failure `reply` reports, if it is an error reply, classified by
    /// its message. `retryable` is [`is_retryable`] of the message; the host
    /// still decides whether a retry is safe. `outcome_unknown` is false:
    /// a reply is the request's outcome.
    pub fn of_reply(reply: &AssistantMessage) -> Option<Self> {
        if reply.stop_reason != StopReason::Error {
            return None;
        }
        let message = reply.error_message.clone().unwrap_or_default();
        let kind = if is_context_overflow(reply) {
            FailureKind::ContextOverflow
        } else if RATE_LIMITED.is_match(&message) {
            FailureKind::RateLimited
        } else if is_retryable(&message) {
            FailureKind::Transport
        } else {
            FailureKind::Other
        };
        Some(Self {
            retryable: is_retryable(&message),
            kind,
            message,
            retry_after_ms: None,
            outcome_unknown: false,
        })
    }
}
