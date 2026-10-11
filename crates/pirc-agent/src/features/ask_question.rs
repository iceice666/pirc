//! `ask-question` (`agent/features/ask-question.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `askQuestionFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(AskQuestionFeature)
}

struct AskQuestionFeature;

impl Feature for AskQuestionFeature {
    fn name(&self) -> &'static str {
        "ask-question"
    }
}
