//! `recap` (`agent/features/recap.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `recapFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(RecapFeature)
}

struct RecapFeature;

impl Feature for RecapFeature {
    fn name(&self) -> &'static str {
        "recap"
    }
}
