//! `background-task` (`agent/features/background/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `backgroundFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(BackgroundFeature)
}

struct BackgroundFeature;

impl Feature for BackgroundFeature {
    fn name(&self) -> &'static str {
        "background-task"
    }
}
