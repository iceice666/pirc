//! Runtime completion metadata, separate from serializable message DTOs.

use std::fmt;

use pirc_llm_types::{AssistantMessage, StopReason};

/// Machine-readable failure category. No provider text is needed to inspect it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    InvalidRequest,
    CredentialsUnavailable,
    FeatureDisabled,
    Timeout,
    Network,
    Http,
    Protocol,
    ContextWindow,
    RateLimited,
    Provider,
}

/// A transport failure with a safe summary and explicitly accessed diagnostics.
///
/// Diagnostics can contain credentials, URLs or prompt data. Neither `Display`
/// nor `Debug` includes them. This type does not prescribe retry policy.
#[derive(Clone)]
pub struct LlmError {
    kind: ErrorKind,
    status: Option<u16>,
    diagnostics: Option<String>,
}

impl LlmError {
    pub fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            status: None,
            diagnostics: None,
        }
    }

    pub fn diagnostic(kind: ErrorKind, diagnostics: impl Into<String>) -> Self {
        Self {
            kind,
            status: None,
            diagnostics: Some(diagnostics.into()),
        }
    }

    /// Preserve the actual HTTP status, not a status extracted from error text.
    /// Explicit 413/429 status classifications take precedence; otherwise
    /// provider context/rate-limit text may refine the generic HTTP category.
    pub fn http(status: u16, diagnostics: impl Into<String>) -> Self {
        let mut error = Self::upstream(diagnostics);
        error.kind = match status {
            413 => ErrorKind::ContextWindow,
            429 => ErrorKind::RateLimited,
            _ => match error.kind {
                ErrorKind::ContextWindow | ErrorKind::RateLimited => error.kind,
                _ => ErrorKind::Http,
            },
        };
        error.status = Some(status);
        error
    }

    /// Fallback classification for provider-defined error events without a typed cause.
    pub fn upstream(diagnostics: impl Into<String>) -> Self {
        let diagnostics = diagnostics.into();
        let lower = diagnostics.to_ascii_lowercase();
        let rate = [
            "rate limit",
            "rate_limit",
            "rate-limit",
            "too many requests",
            "usage limit",
            "usage_limit",
            "quota",
            "overloaded",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        let context = [
            "context length",
            "context_length",
            "context window",
            "context_window",
            "maximum context",
            "too many tokens",
            "prompt is too long",
            "input is too long",
            "request too large",
            "max_tokens exceed",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        let kind = if rate {
            ErrorKind::RateLimited
        } else if context {
            ErrorKind::ContextWindow
        } else {
            ErrorKind::Provider
        };
        Self::diagnostic(kind, diagnostics)
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }
    pub fn status(&self) -> Option<u16> {
        self.status
    }

    /// Raw, potentially secret-bearing details. Redact before display or logging.
    pub fn diagnostics(&self) -> Option<&str> {
        self.diagnostics.as_deref()
    }

    #[cfg(feature = "openai-codex-responses")]
    pub(crate) fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub(crate) fn from_reqwest(error: &reqwest::Error) -> Self {
        if let Some(status) = error.status() {
            Self::http(status.as_u16(), error.to_string())
        } else {
            Self::diagnostic(
                if error.is_builder() {
                    ErrorKind::InvalidRequest
                } else if error.is_timeout() {
                    ErrorKind::Timeout
                } else {
                    ErrorKind::Network
                },
                error.to_string(),
            )
        }
    }
}

impl fmt::Display for LlmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let summary = match self.kind {
            ErrorKind::InvalidRequest => "Invalid model request",
            ErrorKind::CredentialsUnavailable => "Model credentials are unavailable",
            ErrorKind::FeatureDisabled => "Requested wire API feature is disabled",
            ErrorKind::Timeout => "Model request timed out",
            ErrorKind::Network => "Model network request failed",
            ErrorKind::Http => "Model provider request failed",
            ErrorKind::Protocol => "Invalid model provider stream",
            ErrorKind::ContextWindow => "Model context window exceeded",
            ErrorKind::RateLimited => "Model provider rate limit reached",
            ErrorKind::Provider => "Model provider request failed",
        };
        f.write_str(summary)?;
        if let Some(status) = self.status {
            write!(f, " (HTTP {status})")?;
        }
        Ok(())
    }
}

impl fmt::Debug for LlmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LlmError")
            .field("kind", &self.kind)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}
impl std::error::Error for LlmError {}

/// How a run terminated. Cancellation is not a provider failure.
#[derive(Clone, Debug)]
pub enum Termination {
    /// This model invocation finished (including tool-use and length stops).
    /// It does not mean an agent task or conversation is complete.
    Finished,
    Cancelled,
    Failed(LlmError),
}

/// A completed or interrupted run, retaining partial content and usage under
/// the selected codec's rules (unfinished tool calls may be removed).
///
/// The final message error summary is safe. Callback snapshots retain existing
/// codec semantics and may contain provider data; this is not content redaction.
/// Raw compatibility error text requires explicit legacy conversion.
#[derive(Clone)]
pub struct RunOutcome {
    pub message: AssistantMessage,
    pub termination: Termination,
    legacy_error: Option<String>,
}

impl RunOutcome {
    pub(crate) fn new(mut message: AssistantMessage, error: Option<LlmError>) -> Self {
        let legacy_error = message.error_message.take();
        let termination = match message.stop_reason {
            StopReason::Aborted => {
                message.error_message = Some("Model request cancelled".to_owned());
                Termination::Cancelled
            }
            StopReason::Error => {
                let error = error.unwrap_or_else(|| LlmError::new(ErrorKind::Provider));
                message.error_message = Some(error.to_string());
                Termination::Failed(error)
            }
            _ => Termination::Finished,
        };
        Self {
            message,
            termination,
            legacy_error,
        }
    }

    /// Restore the original native/Pi compatibility error text.
    ///
    /// Native errors may contain response bodies or credentials. This conversion
    /// is for existing adapters that already apply host redaction; do not present
    /// or log the result without that policy.
    pub fn into_legacy_message(mut self) -> AssistantMessage {
        self.message.error_message = self.legacy_error;
        self.message
    }
}

impl fmt::Debug for RunOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RunOutcome")
            .field("message", &self.message)
            .field("termination", &self.termination)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_are_explicit_and_status_is_structured() {
        let error = LlmError::http(401, "secret-token prompt https://private.example");
        assert_eq!(error.kind(), ErrorKind::Http);
        assert_eq!(error.status(), Some(401));
        assert!(!format!("{error} {error:?}").contains("secret-token"));
        assert!(error.diagnostics().unwrap().contains("secret-token"));
        assert_eq!(LlmError::http(413, "").kind(), ErrorKind::ContextWindow);
        assert_eq!(LlmError::http(429, "").kind(), ErrorKind::RateLimited);
        let context = LlmError::http(400, r#"{"error":{"code":"context_length_exceeded"}}"#);
        assert_eq!(context.kind(), ErrorKind::ContextWindow);
        assert_eq!(context.status(), Some(400));
        assert_eq!(
            LlmError::http(400, "usage_limit_reached").kind(),
            ErrorKind::RateLimited
        );
        assert_eq!(
            LlmError::http(413, "rate limit").kind(),
            ErrorKind::ContextWindow
        );
        assert_eq!(
            LlmError::http(429, "context window").kind(),
            ErrorKind::RateLimited
        );
    }

    #[test]
    fn failed_outcome_keeps_partial_but_not_unsafe_error_in_debug() {
        let mut message = crate::stream::assistant("a", "p", "m", StopReason::Error);
        message.error_message = Some("raw-secret".to_owned());
        message
            .content
            .push(pirc_llm_types::AssistantContent::Text {
                text: "partial".to_owned(),
                text_signature: None,
            });
        message.usage.output = 3;
        let outcome = RunOutcome::new(
            message.clone(),
            Some(LlmError::diagnostic(ErrorKind::Protocol, "raw-secret")),
        );
        assert_eq!(outcome.message.content, message.content);
        assert_eq!(outcome.message.usage, message.usage);
        assert!(!format!("{outcome:?}").contains("raw-secret"));
        assert_eq!(outcome.into_legacy_message(), message);
    }
}
