//! Model transports and the gateway's `models.json`, ported from the TS
//! gateway (`backends/inference.ts`, `backends/pi-adapter.ts`, `models.ts`,
//! `agent/providers/openai-chat.ts`) and the parts of pi-ai 0.73.1 and the
//! `openai` SDK they use.
//!
//! Transports: pi-ai's `openai-completions` (also used for `openai-chat`
//! providers routed through Pi), `anthropic-messages`, `openai-responses`
//! and `openai-codex-responses`, and the native `openai-chat` and
//! `anthropic-messages` transports ([`Inference::run`] picks one as
//! `GatewayInference` did). [`backends`] is the backend settings store.

mod anthropic;
mod anthropic_native;
pub mod backends;
mod catalog;
mod chat;
mod codex;
mod completions;
mod errors;
mod http;
mod inference;
mod js;
mod json_parse;
mod models_file;
mod pi;
mod responses;
mod sse;
mod stream;

pub use catalog::{CatalogModel, catalog_models, catalog_providers, catalog_version};
pub use errors::safe_inference_error;
pub use inference::{Inference, Resolve, Resolved};
pub use models_file::{ModelsFile, expand_home, list_models, load_models_file, public_models};
