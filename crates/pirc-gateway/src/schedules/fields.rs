//! Checking request bodies and agent arguments like the TS zod schemas
//! (`.strict()` objects; string lengths in UTF-16 units; `.optional()`
//! refusing `null` unless `.nullable()`). Any mismatch is the caller's
//! plain `invalid_input`.

use serde_json::{Map, Value};

use super::{Input, ModelRef, NOTIFY_LEVELS, THINKING_LEVELS, units};

/// A mismatch with the schema.
pub struct Mismatch;

pub type Checked<T> = Result<T, Mismatch>;

/// A JSON object with only `allowed` keys.
pub struct Object<'a>(&'a Map<String, Value>);

pub fn object<'a>(value: &'a Value, allowed: &[&str]) -> Checked<Object<'a>> {
    match value {
        Value::Object(map) if map.keys().all(|key| allowed.contains(&key.as_str())) => {
            Ok(Object(map))
        }
        _ => Err(Mismatch),
    }
}

impl Object<'_> {
    /// An optional string of `min..=max` UTF-16 units.
    pub fn string(&self, key: &str, min: usize, max: usize) -> Checked<Option<String>> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Value::String(text)) if (min..=max).contains(&units(text)) => {
                Ok(Some(text.clone()))
            }
            Some(_) => Err(Mismatch),
        }
    }

    pub fn required(&self, key: &str, min: usize, max: usize) -> Checked<String> {
        self.string(key, min, max)?.ok_or(Mismatch)
    }

    /// One of `values`, if present.
    pub fn choice(&self, key: &str, values: &[&str]) -> Checked<Option<String>> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Value::String(text)) if values.contains(&text.as_str()) => Ok(Some(text.clone())),
            Some(_) => Err(Mismatch),
        }
    }

    /// One of `values` or `null`, if present (`Some(None)`: `null`).
    pub fn nullable_choice(&self, key: &str, values: &[&str]) -> Checked<Option<Option<String>>> {
        match self.0.get(key) {
            Some(Value::Null) => Ok(Some(None)),
            _ => self.choice(key, values).map(|choice| choice.map(Some)),
        }
    }

    /// `{provider, id}` (strict, both non-empty) or `null`, if present.
    pub fn model(&self, key: &str) -> Checked<Option<Option<ModelRef>>> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(value) => {
                let model = object(value, &["provider", "id"])?;
                Ok(Some(Some(ModelRef {
                    provider: model.required("provider", 1, usize::MAX)?,
                    id: model.required("id", 1, usize::MAX)?,
                })))
            }
        }
    }

    /// An optional integer ≥ 0 (`z.number().int().min(0)`).
    pub fn offset(&self, key: &str) -> Checked<Option<f64>> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Value::Number(number)) => match number.as_f64() {
                Some(value) if value.fract() == 0.0 && value >= 0.0 => Ok(Some(value)),
                _ => Err(Mismatch),
            },
            Some(_) => Err(Mismatch),
        }
    }
}

/// The schedule fields the browser routes take (`fields` in
/// `schedule-routes.ts`); `prompt` up to twice the stored limit.
pub fn route_input(body: &Object<'_>, prompt_required: bool) -> Checked<Input> {
    let prompt_max = super::PROMPT_MAX_CHARS * 2;
    Ok(Input {
        workspace: None,
        title: body.string("title", 0, 300)?,
        prompt: if prompt_required {
            Some(body.required("prompt", 0, prompt_max)?)
        } else {
            body.string("prompt", 0, prompt_max)?
        },
        cron: body.string("cron", 0, 200)?,
        at: body.string("at", 0, 100)?,
        timezone: body.string("timezone", 0, 100)?,
        model: body.model("model")?,
        thinking: body.nullable_choice("thinking", THINKING_LEVELS)?,
        notify: body.choice("notify", NOTIFY_LEVELS)?,
    })
}

/// The fields an agent may set (`scheduleFields` in `agent-ops.ts`): no
/// model or thinking level, which only the user picks.
pub fn agent_input(args: &Object<'_>, prompt_required: bool) -> Checked<Input> {
    Ok(Input {
        workspace: args.string("workspace", 1, 300)?,
        title: args.string("title", 0, 300)?,
        prompt: if prompt_required {
            Some(args.required("prompt", 0, 40_000)?)
        } else {
            args.string("prompt", 0, 40_000)?
        },
        cron: args.string("cron", 0, 200)?,
        at: args.string("at", 0, 100)?,
        timezone: args.string("timezone", 0, 100)?,
        model: None,
        thinking: None,
        notify: args.choice("notify", NOTIFY_LEVELS)?,
    })
}
