//! PTC v1 contracts (`agent/ptc/contracts.ts`): budgets, typed error codes
//! and the error envelope, shared by the agent (the host) and the guest.
//! Metadata here describes capabilities; it never grants anything.

use serde_json::{Map, Value, json};

pub const CONTRACT_VERSION: u64 = 1;

/// `BUDGETS`.
pub mod budgets {
    pub const STORE_VALUE_CHARS: usize = 262_144;
    pub const STORE_TOTAL_CHARS: usize = 1_048_576;
    pub const SOURCE_BYTES: usize = 65_536;
    pub const INTERNAL_CALLS: usize = 200;
    pub const CONCURRENT_OPERATIONS: usize = 8;
    pub const CONCURRENT_WRITES: usize = 1;
    pub const QUICKJS_HEAP_BYTES: usize = 128 * 1024 * 1024;
    pub const QUICKJS_STACK_BYTES: usize = 512 * 1024;
    pub const MAX_ACTIVE_TIMEOUT_MS: u64 = 3_600_000;
    pub const RESULT_BYTES: usize = 16 * 1024 * 1024;
    pub const ARGS_BYTES: usize = 1024 * 1024;
    pub const CONSOLE_BYTES: usize = 51_200;
    pub const PAR_SCOPES: usize = 200;
    pub const DOCS_NAMES: usize = 8;
    pub const DOCS_PAGE_ITEMS: usize = 20;
    pub const DOCS_OUTPUT_BYTES: usize = 16_384;
    pub const SETTLE_GRACE_MS: u64 = 5_000;
}

/// `ERROR_CODES`.
pub const ERROR_CODES: [&str; 8] = [
    "ApprovalDenied",
    "CapabilityUnavailable",
    "InvalidArguments",
    "QuotaExceeded",
    "Cancelled",
    "Timeout",
    "OperationFailed",
    "StaleContract",
];

/// `WRAPPER_NAMES`: the model-facing wrappers and the retired `code`.
pub const WRAPPER_NAMES: [&str; 3] = ["code", "ptc", "ptc_docs"];

/// `CAPABILITY_NAME`: `^[a-z][a-z0-9_]*$`.
pub fn is_capability_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `PtcError`: a failure the host reports as a typed error.
#[derive(Clone, Debug, PartialEq)]
pub struct PtcError {
    pub code: &'static str,
    pub message: String,
    pub outcome: &'static str,
    /// `{names, registryVersion}`.
    pub docs: Option<Box<(Vec<String>, String)>>,
    pub data: Option<Box<Value>>,
}

impl PtcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            outcome: "not_started",
            docs: None,
            data: None,
        }
    }

    /// `new PtcError(code, message, outcome)`.
    pub fn with_outcome(
        code: &'static str,
        message: impl Into<String>,
        outcome: &'static str,
    ) -> Self {
        Self {
            outcome,
            ..Self::new(code, message)
        }
    }

    /// The typed fields of a failed operation's result (`data`).
    pub fn with_data(mut self, data: Option<Value>) -> Self {
        self.data = data.map(Box::new);
        self
    }

    pub fn stale(message: impl Into<String>, names: Vec<String>, version: &str) -> Self {
        Self {
            docs: Some(Box::new((names, version.to_owned()))),
            ..Self::new("StaleContract", message)
        }
    }

    /// `toJSON(operationId)`.
    pub fn to_json(&self, operation_id: Option<&str>) -> Value {
        let mut out = Map::new();
        out.insert("code".to_owned(), json!(self.code));
        out.insert("message".to_owned(), json!(self.message));
        out.insert("outcome".to_owned(), json!(self.outcome));
        if let Some(id) = operation_id.filter(|id| !id.is_empty()) {
            out.insert("operationId".to_owned(), json!(id));
        }
        if let Some(docs) = &self.docs {
            let (names, version) = docs.as_ref();
            out.insert(
                "docs".to_owned(),
                json!({ "names": names, "registryVersion": version }),
            );
        }
        if let Some(data) = &self.data {
            out.insert("data".to_owned(), (**data).clone());
        }
        Value::Object(out)
    }
}

/// The code as one of [`ERROR_CODES`], or `None` for any other text.
pub fn error_code(code: &str) -> Option<&'static str> {
    ERROR_CODES.iter().copied().find(|known| *known == code)
}

/// `Outcome`: how far an operation got.
pub const OUTCOMES: [&str; 5] = ["not_started", "completed", "failed", "cancelled", "unknown"];

/// The outcome as one of [`OUTCOMES`], or `None` for any other text.
pub fn outcome(value: &str) -> Option<&'static str> {
    OUTCOMES.iter().copied().find(|known| *known == value)
}
