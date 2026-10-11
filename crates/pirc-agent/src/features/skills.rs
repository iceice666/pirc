//! `skills` (`agent/features/skills.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `skillsFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SkillsFeature)
}

struct SkillsFeature;

impl Feature for SkillsFeature {
    fn name(&self) -> &'static str {
        "skills"
    }
}
