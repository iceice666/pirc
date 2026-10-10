//! Model transports and the gateway's `models.json`, ported from the TS
//! gateway (`backends/inference.ts`, `backends/pi-adapter.ts`, `models.ts`,
//! `agent/providers/openai-chat.ts`) and the parts of pi-ai 0.73.1 and the
//! `openai` SDK they use.
//!
//! Wire APIs so far: `openai-completions` (pi-ai's transport, also used for
//! `openai-chat` providers routed through Pi) and the native `openai-chat`
//! transport. Other APIs answer with an error message until the M3
//! transports land. [`backends`] is the backend settings store.

pub mod backends;
mod catalog;
mod chat;
mod completions;
mod errors;
mod http;
mod inference;
mod js;
mod json_parse;
mod models_file;
mod sse;
mod stream;

pub use catalog::{CatalogModel, catalog_models, catalog_providers, catalog_version};
pub use errors::safe_inference_error;
pub use inference::{Inference, Resolve, Resolved};
pub use models_file::{ModelsFile, expand_home, list_models, load_models_file, public_models};
