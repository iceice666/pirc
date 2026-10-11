//! `session-title` (`agent/features/title.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `titleFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(TitleFeature)
}

struct TitleFeature;

impl Feature for TitleFeature {
    fn name(&self) -> &'static str {
        "session-title"
    }
}
