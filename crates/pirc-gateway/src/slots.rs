//! State a feature module keeps for the gateway, one value per type
//! (`App::slots`), so the modules need no field of their own in `App`.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Slots(Mutex<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>);

impl Slots {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TypeId, Arc<dyn Any + Send + Sync>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The `T`, if one was stored.
    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        self.lock()
            .get(&TypeId::of::<T>())
            .cloned()
            .and_then(|value| value.downcast::<T>().ok())
    }

    /// The `T`, made by `init` on first use.
    pub fn get_or_init<T: Any + Send + Sync>(&self, init: impl FnOnce() -> T) -> Arc<T> {
        if let Some(value) = self.get::<T>() {
            return value;
        }
        let made: Arc<dyn Any + Send + Sync> = Arc::new(init());
        let stored = self.lock().entry(TypeId::of::<T>()).or_insert(made).clone();
        stored.downcast::<T>().expect("a slot holds its own type")
    }

    /// Store `value` (replacing any earlier one).
    pub fn set<T: Any + Send + Sync>(&self, value: Arc<T>) {
        self.lock().insert(TypeId::of::<T>(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_value_per_type() {
        let slots = Slots::default();
        assert!(slots.get::<u8>().is_none());
        assert_eq!(*slots.get_or_init(|| 7u8), 7);
        assert_eq!(*slots.get_or_init(|| 9u8), 7);
        slots.set(Arc::new(String::from("x")));
        assert_eq!(*slots.get::<String>().unwrap(), "x");
    }
}
