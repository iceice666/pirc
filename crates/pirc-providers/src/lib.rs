//! Model transports and the gateway's `models.json`, ported from the TS
//! gateway (`backends/inference.ts`, `backends/pi-adapter.ts`, `models.ts`,
//! `agent/providers/openai-chat.ts`) and the parts of pi-ai 0.73.1 and the
//! `openai` SDK they use.
//!
//! M2 scope: the `openai-completions` wire API (pi-ai's transport, also used
//! for `openai-chat` providers routed through Pi) and the native
//! `openai-chat` transport. Other APIs answer with an error message until M3.

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

pub use errors::safe_inference_error;
pub use inference::Inference;
pub use models_file::{ModelsFile, expand_home, list_models, load_models_file, public_models};
