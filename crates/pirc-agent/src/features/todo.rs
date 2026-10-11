//! `todo` (`agent/features/todo/`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `todoFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(TodoFeature)
}

struct TodoFeature;

impl Feature for TodoFeature {
    fn name(&self) -> &'static str {
        "todo"
    }
}
