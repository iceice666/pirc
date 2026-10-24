//! Durable bounded pots tracking. No model scheduler or execution adapter.
//! Only authenticated host events may call ingest_progress/resolve_progress.
mod api;
pub mod host;
pub use api::routes;
mod store;
pub use store::*;
#[cfg(test)]
mod api_tests;
#[cfg(test)]
mod migration_tests;
#[cfg(test)]
mod tests;
