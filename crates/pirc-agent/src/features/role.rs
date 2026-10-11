//! `role` (`agent/features/role.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `roleFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(RoleFeature)
}

struct RoleFeature;

impl Feature for RoleFeature {
    fn name(&self) -> &'static str {
        "role"
    }
}
