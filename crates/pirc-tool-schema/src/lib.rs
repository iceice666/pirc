#![doc = include_str!("../README.md")]

mod documentation;
mod text;
mod validation;

pub use documentation::{
    Block, Fitted, compact_signature_of, fit_signatures, signature_of, summary_of, ts_type,
};
pub use validation::validate_schema;
