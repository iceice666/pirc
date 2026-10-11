//! `project-instructions` (`agent/features/project-instructions.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `projectInstructionsFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(ProjectInstructionsFeature)
}

struct ProjectInstructionsFeature;

impl Feature for ProjectInstructionsFeature {
    fn name(&self) -> &'static str {
        "project-instructions"
    }
}
