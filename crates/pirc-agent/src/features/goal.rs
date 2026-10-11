//! `goal` (`agent/features/goal/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `goalFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(GoalFeature)
}

struct GoalFeature;

impl Feature for GoalFeature {
    fn name(&self) -> &'static str {
        "goal"
    }
}
