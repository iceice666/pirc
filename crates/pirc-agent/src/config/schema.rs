//! The validation the TS agent did with zod 3, reproduced where its result
//! is observable: which issues (code, path, bounds) a value gives, in zod's
//! order, and `ZodError.message` (the issues as indented JSON).

use serde_json::{Map, Value};

use crate::messages::js;

#[derive(Clone, Debug, PartialEq)]
pub enum PathPart {
    Key(String),
    Index(usize),
}

#[derive(Clone, Debug, PartialEq)]
pub enum IssueKind {
    /// `{code, expected, received}`.
    InvalidType {
        expected: String,
        received: &'static str,
    },
    /// `.int()` on a fraction: `{code, expected: 'integer', received: 'float', message}`.
    NotInteger,
    /// `z.enum` given a non-string: `{expected, received, code}`.
    EnumType {
        expected: String,
        received: &'static str,
    },
    /// `{received, code, options}`.
    InvalidEnum {
        received: String,
        options: Vec<String>,
    },
    /// `{code, minimum, type, inclusive, exact, message}`.
    TooSmall {
        minimum: f64,
        kind: &'static str,
        inclusive: bool,
    },
    /// `{code, maximum, type, inclusive, exact, message}`.
    TooBig {
        maximum: f64,
        kind: &'static str,
        inclusive: bool,
    },
    /// `{code, keys}`.
    UnrecognizedKeys { keys: Vec<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub path: Vec<PathPart>,
}

fn join_values(values: &[String], separator: &str) -> String {
    values
        .iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(separator)
}

impl Issue {
    /// zod's default (English) message.
    pub fn message(&self) -> String {
        match &self.kind {
            IssueKind::InvalidType { expected, received }
            | IssueKind::EnumType { expected, received } => {
                if *received == "undefined" {
                    "Required".to_owned()
                } else {
                    format!("Expected {expected}, received {received}")
                }
            }
            IssueKind::NotInteger => "Expected integer, received float".to_owned(),
            IssueKind::InvalidEnum { received, options } => format!(
                "Invalid enum value. Expected {}, received '{received}'",
                join_values(options, " | ")
            ),
            IssueKind::TooSmall {
                minimum,
                kind,
                inclusive,
            } => {
                let minimum = js::number_text(*minimum);
                if *kind == "string" {
                    let bound = if *inclusive { "at least" } else { "over" };
                    format!("String must contain {bound} {minimum} character(s)")
                } else {
                    let bound = if *inclusive {
                        "greater than or equal to "
                    } else {
                        "greater than "
                    };
                    format!("Number must be {bound}{minimum}")
                }
            }
            IssueKind::TooBig {
                maximum,
                kind,
                inclusive,
            } => {
                let maximum = js::number_text(*maximum);
                if *kind == "string" {
                    let bound = if *inclusive { "at most" } else { "under" };
                    format!("String must contain {bound} {maximum} character(s)")
                } else {
                    let bound = if *inclusive {
                        "less than or equal to "
                    } else {
                        "less than "
                    };
                    format!("Number must be {bound}{maximum}")
                }
            }
            IssueKind::UnrecognizedKeys { keys } => {
                format!("Unrecognized key(s) in object: {}", join_values(keys, ", "))
            }
        }
    }

    fn path_value(&self) -> Value {
        Value::Array(
            self.path
                .iter()
                .map(|part| match part {
                    PathPart::Key(key) => Value::from(key.as_str()),
                    PathPart::Index(index) => Value::from(*index),
                })
                .collect(),
        )
    }

    /// The issue as zod builds it: its own fields, then `path` and
    /// `message` (where the issue already had a `message` key, in place).
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        let mut put = |key: &str, value: Value| {
            map.insert(key.to_owned(), value);
        };
        let message = Value::from(self.message());
        match &self.kind {
            IssueKind::InvalidType { expected, received } => {
                put("code", "invalid_type".into());
                put("expected", expected.as_str().into());
                put("received", (*received).into());
            }
            IssueKind::NotInteger => {
                put("code", "invalid_type".into());
                put("expected", "integer".into());
                put("received", "float".into());
                put("message", message.clone());
            }
            IssueKind::EnumType { expected, received } => {
                put("expected", expected.as_str().into());
                put("received", (*received).into());
                put("code", "invalid_type".into());
            }
            IssueKind::InvalidEnum { received, options } => {
                put("received", received.as_str().into());
                put("code", "invalid_enum_value".into());
                put("options", options.clone().into());
            }
            IssueKind::TooSmall {
                minimum,
                kind,
                inclusive,
            } => {
                put("code", "too_small".into());
                put("minimum", js::number_value(*minimum));
                put("type", (*kind).into());
                put("inclusive", (*inclusive).into());
                put("exact", false.into());
                put("message", message.clone());
            }
            IssueKind::TooBig {
                maximum,
                kind,
                inclusive,
            } => {
                put("code", "too_big".into());
                put("maximum", js::number_value(*maximum));
                put("type", (*kind).into());
                put("inclusive", (*inclusive).into());
                put("exact", false.into());
                put("message", message.clone());
            }
            IssueKind::UnrecognizedKeys { keys } => {
                put("code", "unrecognized_keys".into());
                put("keys", keys.clone().into());
            }
        }
        map.insert("path".to_owned(), self.path_value());
        map.insert("message".to_owned(), message);
        Value::Object(map)
    }
}

/// `ZodError.message`: `JSON.stringify(issues, null, 2)`.
pub fn error_message(issues: &[Issue]) -> String {
    let values: Vec<Value> = issues.iter().map(Issue::to_value).collect();
    serde_json::to_string_pretty(&values).unwrap_or_default()
}

/// zod's `getParsedType` of a JSON value (`undefined` when absent).
pub fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A number check: `(bound, inclusive)`.
pub type Bound = (f64, bool);

/// Collects issues while a value is walked, like a zod parse context.
#[derive(Default)]
pub struct Checker {
    pub issues: Vec<Issue>,
    path: Vec<PathPart>,
}

impl Checker {
    pub fn issue(&mut self, kind: IssueKind) {
        self.issues.push(Issue {
            kind,
            path: self.path.clone(),
        });
    }

    fn invalid_type(&mut self, expected: &str, value: Option<&Value>) {
        self.issue(IssueKind::InvalidType {
            expected: expected.to_owned(),
            received: received(value),
        });
    }

    /// Check `run` at `path` + `part`.
    pub fn at<T>(&mut self, part: PathPart, run: impl FnOnce(&mut Self) -> T) -> T {
        self.path.push(part);
        let out = run(self);
        self.path.pop();
        out
    }

    pub fn key<'v, T>(
        &mut self,
        map: &'v Map<String, Value>,
        key: &str,
        run: impl FnOnce(&mut Self, Option<&'v Value>) -> T,
    ) -> T {
        let value = map.get(key);
        self.at(PathPart::Key(key.to_owned()), |checker| run(checker, value))
    }

    pub fn object<'v>(&mut self, value: Option<&'v Value>) -> Option<&'v Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Some(map),
            other => {
                self.invalid_type("object", other);
                None
            }
        }
    }

    pub fn array<'v>(&mut self, value: Option<&'v Value>) -> Option<&'v Vec<Value>> {
        match value {
            Some(Value::Array(items)) => Some(items),
            other => {
                self.invalid_type("array", other);
                None
            }
        }
    }

    pub fn boolean(&mut self, value: Option<&Value>) -> Option<bool> {
        match value {
            Some(Value::Bool(flag)) => Some(*flag),
            other => {
                self.invalid_type("boolean", other);
                None
            }
        }
    }

    /// `z.string()`, with `.min(n)` (UTF-16 length).
    pub fn string(&mut self, value: Option<&Value>, min: Option<usize>) -> Option<String> {
        match value {
            Some(Value::String(text)) => {
                if let Some(min) = min
                    && js::utf16_len(text) < min
                {
                    self.issue(IssueKind::TooSmall {
                        minimum: min as f64,
                        kind: "string",
                        inclusive: true,
                    });
                }
                Some(text.clone())
            }
            other => {
                self.invalid_type("string", other);
                None
            }
        }
    }

    /// `z.number()` with `.int()`, a minimum and a maximum, checked in that order.
    pub fn number(
        &mut self,
        value: Option<&Value>,
        int: bool,
        min: Option<Bound>,
        max: Option<Bound>,
    ) -> Option<f64> {
        let Some(number) = value.and_then(Value::as_f64) else {
            self.invalid_type("number", value);
            return None;
        };
        if int && number.fract() != 0.0 {
            self.issue(IssueKind::NotInteger);
        }
        if let Some((minimum, inclusive)) = min
            && (if inclusive {
                number < minimum
            } else {
                number <= minimum
            })
        {
            self.issue(IssueKind::TooSmall {
                minimum,
                kind: "number",
                inclusive,
            });
        }
        if let Some((maximum, inclusive)) = max
            && (if inclusive {
                number > maximum
            } else {
                number >= maximum
            })
        {
            self.issue(IssueKind::TooBig {
                maximum,
                kind: "number",
                inclusive,
            });
        }
        Some(number)
    }

    /// `z.number().int().positive()`, optionally `.max(n)`.
    pub fn positive_int(&mut self, value: Option<&Value>, max: Option<f64>) -> Option<u64> {
        self.number(value, true, Some((0.0, false)), max.map(|max| (max, true)))
            .map(|number| number as u64)
    }

    /// `z.enum(options)`.
    pub fn enumeration(&mut self, value: Option<&Value>, options: &[&str]) -> Option<String> {
        let options: Vec<String> = options.iter().map(|option| (*option).to_owned()).collect();
        match value {
            Some(Value::String(text)) if options.contains(text) => Some(text.clone()),
            Some(Value::String(text)) => {
                self.issue(IssueKind::InvalidEnum {
                    received: text.clone(),
                    options,
                });
                None
            }
            other => {
                self.issue(IssueKind::EnumType {
                    expected: join_values(&options, " | "),
                    received: received(other),
                });
                None
            }
        }
    }

    /// `z.record(z.string())`: entries in input order.
    pub fn string_record(&mut self, value: Option<&Value>) -> Vec<(String, String)> {
        let Some(map) = self.object(value) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (key, item) in map {
            if let Some(text) = self.at(PathPart::Key(key.clone()), |c| c.string(Some(item), None))
            {
                out.push((key.clone(), text));
            }
        }
        out
    }

    /// `z.array(z.string())`.
    pub fn string_array(&mut self, value: Option<&Value>) -> Vec<String> {
        let Some(items) = self.array(value) else {
            return Vec::new();
        };
        items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                self.at(PathPart::Index(index), |c| c.string(Some(item), None))
            })
            .collect()
    }

    /// `.strict()`: keys outside `known`, in input order.
    pub fn strict(&mut self, map: &Map<String, Value>, known: &[&str]) {
        let keys: Vec<String> = map
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .cloned()
            .collect();
        if !keys.is_empty() {
            self.issue(IssueKind::UnrecognizedKeys { keys });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_zod_errors() {
        let mut checker = Checker::default();
        let value = json!({"a": 1.5, "b": "x", "c": "q", "extra": 1});
        let map = value.as_object().unwrap();
        checker.key(map, "a", |c, v| c.positive_int(v, Some(1.0)));
        checker.key(map, "b", |c, v| c.string(v, Some(2)));
        checker.key(map, "c", |c, v| c.enumeration(v, &["x", "y"]));
        checker.key(map, "d", |c, v| c.enumeration(v, &["x"]));
        checker.key(map, "e", |c, v| c.boolean(v));
        checker.strict(map, &["a", "b", "c"]);
        assert_eq!(
            error_message(&checker.issues),
            r#"[
  {
    "code": "invalid_type",
    "expected": "integer",
    "received": "float",
    "message": "Expected integer, received float",
    "path": [
      "a"
    ]
  },
  {
    "code": "too_big",
    "maximum": 1,
    "type": "number",
    "inclusive": true,
    "exact": false,
    "message": "Number must be less than or equal to 1",
    "path": [
      "a"
    ]
  },
  {
    "code": "too_small",
    "minimum": 2,
    "type": "string",
    "inclusive": true,
    "exact": false,
    "message": "String must contain at least 2 character(s)",
    "path": [
      "b"
    ]
  },
  {
    "received": "q",
    "code": "invalid_enum_value",
    "options": [
      "x",
      "y"
    ],
    "path": [
      "c"
    ],
    "message": "Invalid enum value. Expected 'x' | 'y', received 'q'"
  },
  {
    "expected": "'x'",
    "received": "undefined",
    "code": "invalid_type",
    "path": [
      "d"
    ],
    "message": "Required"
  },
  {
    "code": "invalid_type",
    "expected": "boolean",
    "received": "undefined",
    "path": [
      "e"
    ],
    "message": "Required"
  },
  {
    "code": "unrecognized_keys",
    "keys": [
      "extra"
    ],
    "path": [],
    "message": "Unrecognized key(s) in object: 'extra'"
  }
]"#
        );
    }
}
