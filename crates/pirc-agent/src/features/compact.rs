//! `compact` (`agent/features/compact.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `compactFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(CompactFeature)
}

struct CompactFeature;

impl Feature for CompactFeature {
    fn name(&self) -> &'static str {
        "compact"
    }
}
