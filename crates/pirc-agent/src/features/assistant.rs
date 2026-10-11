//! `assistant` (`agent/features/assistant/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `assistantFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(AssistantFeature)
}

struct AssistantFeature;

impl Feature for AssistantFeature {
    fn name(&self) -> &'static str {
        "assistant"
    }
}
