//! The error shape every client reads, `{error:{code,message,details?}}`
//! (`apps/gateway/src/errors.ts`). Routes return it; the router turns it
//! into the relayed response, and side channels into their own error
//! objects.

use std::borrow::Cow;

use serde_json::{Value, json};

/// An error with its HTTP status and machine-readable code. The message is
/// shown to users: it never carries secrets or raw upstream bodies.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub code: Cow<'static, str>,
    pub message: String,
    /// Boxed: errors travel in every `Result`, and a `Value` is large.
    pub details: Option<Box<Value>>,
}

impl ApiError {
    pub fn new(
        status: u16,
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(Box::new(details));
        self
    }

    /// Request input that does not match its schema (zod's failure in
    /// `util.ts` `parse`). Its `details` (zod's report) is read by no client
    /// and left out, as in the Rust gateway.
    pub fn invalid_input() -> Self {
        Self::new(400, "invalid_input", "Invalid request")
    }

    /// 400 `invalid_input` with a specific message.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_input", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "forbidden", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "conflict", message)
    }

    /// 503 `runner_unavailable`: the agent cannot be reached or started.
    pub fn runner_unavailable(message: impl Into<String>) -> Self {
        Self::new(503, "runner_unavailable", message)
    }

    /// Fastify's body limit (`FST_ERR_CTP_BODY_TOO_LARGE`, mapped in `http.ts`).
    pub fn payload_too_large() -> Self {
        Self::new(
            413,
            "payload_too_large",
            "Request body exceeds configured limit",
        )
    }

    /// Anything unexpected: logged by the caller, never shown.
    pub fn internal() -> Self {
        Self::new(500, "internal_error", "Internal server error")
    }

    /// A database failure: logged, answered as [`ApiError::internal`].
    pub fn database(error: rusqlite::Error) -> Self {
        crate::log::error(&format!("database: {error}"));
        Self::internal()
    }

    /// `{error:{code,message,details?}}`.
    pub fn body(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(details) = &self.details {
            error["details"] = (**details).clone();
        }
        json!({ "error": error })
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::database(error)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies() {
        assert_eq!(
            ApiError::not_found("Session not found").body(),
            json!({ "error": { "code": "not_found", "message": "Session not found" } })
        );
        let error = ApiError::new(409, String::from("stale_interaction"), "gone")
            .with_details(json!({ "current": 2 }));
        assert_eq!(
            error.body(),
            json!({ "error": { "code": "stale_interaction", "message": "gone",
                "details": { "current": 2 } } })
        );
    }
}
