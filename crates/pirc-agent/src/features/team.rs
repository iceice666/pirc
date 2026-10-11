//! `agent-team` (`agent/features/team/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `teamFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(TeamFeature)
}

struct TeamFeature;

impl Feature for TeamFeature {
    fn name(&self) -> &'static str {
        "agent-team"
    }
}
