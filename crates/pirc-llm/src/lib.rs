//! Wire-compatible model transports with explicit host dependencies.
//!
//! No client is constructed here. Inject a configured reqwest client (including
//! TLS/proxy/trust policy), cache retention, an opaque cache identity, optional
//! URL-variable lookup and cancellation. No runtime environment variables are
//! read and no process-global crypto provider is installed.
//!
//! Defaults enable no HTTP or OAuth. Each wire API is opt-in; subscription token
//! inference does not require login-flow machinery. Optional OAuth flows take
//! explicit clients/endpoints/presentation hooks and host-selected policy IDs;
//! the library never stores credentials or chooses a backend account.
//! Raw native provider errors are not safe for presentation; redact at the host.
//! Native/Pi paths intentionally retain their differing wire semantics.

pub use pirc_llm_types as types;

#[cfg(feature = "oauth")]
pub mod oauth;

#[cfg(feature = "_transport")]
mod outcome;
#[cfg(feature = "_transport")]
mod runtime;
#[cfg(feature = "_transport")]
pub use outcome::{ErrorKind, LlmError, RunOutcome, Termination};
#[cfg(feature = "_transport")]
pub use runtime::{Auth, Context, RequestOptions, ResolvedEndpoint, ResolvedModel, RunRequest};
#[cfg(feature = "_transport")]
mod transport;
#[cfg(feature = "_transport")]
pub use http::is_opencode_endpoint;
#[cfg(feature = "_transport")]
pub use pi::api_name;
#[cfg(feature = "_transport")]
pub use stream::{StreamRequest, assistant};
#[cfg(feature = "_transport")]
pub use transport::{Route, Transport};

#[cfg(feature = "anthropic-messages")]
mod anthropic;
#[cfg(feature = "anthropic-messages")]
mod anthropic_native;
#[cfg(feature = "openai-chat")]
mod chat;
#[cfg(feature = "openai-codex-responses")]
mod codex;
#[cfg(feature = "openai-completions")]
mod completions;
#[cfg(feature = "openai-responses")]
mod responses;
// Private cross-wire compatibility helpers are deliberately not public APIs.
#[cfg(any(
    feature = "anthropic-messages",
    feature = "openai-completions",
    feature = "openai-responses",
    feature = "openai-codex-responses"
))]
mod errors;
#[cfg(feature = "_transport")]
mod http;
#[cfg(feature = "_transport")]
mod js;
#[cfg(feature = "_transport")]
mod json_parse;
#[cfg(any(feature = "openai-chat", feature = "anthropic-messages"))]
mod native;
#[cfg(feature = "_transport")]
mod pi;
#[cfg(any(feature = "openai-responses", feature = "openai-codex-responses"))]
mod responses_common;
#[cfg(any(feature = "openai-responses", feature = "openai-codex-responses"))]
mod responses_shared;
#[cfg(any(
    feature = "anthropic-messages",
    feature = "openai-completions",
    feature = "openai-responses"
))]
mod sdk;
#[cfg(any(
    feature = "openai-chat",
    feature = "anthropic-messages",
    feature = "openai-completions",
    feature = "openai-responses"
))]
mod sse;
#[cfg(feature = "_transport")]
mod stream;
