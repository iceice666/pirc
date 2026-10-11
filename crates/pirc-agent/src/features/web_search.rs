//! `web-search` (`agent/features/web-search.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `webSearchFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(WebSearchFeature)
}

struct WebSearchFeature;

impl Feature for WebSearchFeature {
    fn name(&self) -> &'static str {
        "web-search"
    }
}
