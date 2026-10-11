//! `sandbox` (`agent/features/sandbox.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `sandboxFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SandboxFeature)
}

struct SandboxFeature;

impl Feature for SandboxFeature {
    fn name(&self) -> &'static str {
        "sandbox"
    }
}
