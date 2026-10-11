//! `browser` (`agent/features/browser.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `browserFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(BrowserFeature)
}

struct BrowserFeature;

impl Feature for BrowserFeature {
    fn name(&self) -> &'static str {
        "browser"
    }
}
