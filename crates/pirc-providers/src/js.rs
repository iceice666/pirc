//! Host settings compatibility: nullish lookup and trimming.
use serde_json::Value;

pub use pirc_config::text::trim;

/// `a ?? b` on property values: `null` counts as absent.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}
