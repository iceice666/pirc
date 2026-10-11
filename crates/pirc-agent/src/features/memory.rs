//! `observational-memory` (`agent/features/memory/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `memoryFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(MemoryFeature)
}

struct MemoryFeature;

impl Feature for MemoryFeature {
    fn name(&self) -> &'static str {
        "observational-memory"
    }
}
