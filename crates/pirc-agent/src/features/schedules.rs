//! `schedules` (`agent/features/schedules.ts`): not ported yet (plans/rust-rewrite.md, M5).

use std::rc::Rc;

use crate::feature::Feature;

/// `schedulesFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SchedulesFeature)
}

struct SchedulesFeature;

impl Feature for SchedulesFeature {
    fn name(&self) -> &'static str {
        "schedules"
    }
}
