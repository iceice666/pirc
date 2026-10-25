//! Checking `config.json` values: every problem is collected (not just the
//! first), each with the path of the value it is about.

use serde_json::{Map, Value};

use crate::messages::js;

#[derive(Clone, Debug, PartialEq)]
pub enum PathPart {
    Key(String),
    Index(usize),
}

#[derive(Clone, Debug, PartialEq)]
pub enum IssueKind {
    /// A value of the wrong type (`received` is [`received`]'s name).
    InvalidType {
        expected: String,
        received: &'static str,
    },
    /// A fraction where an integer is needed.
    NotInteger,
    /// A non-string where one of `expected` (the options) is needed.
    EnumType {
        expected: String,
        received: &'static str,
    },
    /// A string outside the options.
    InvalidEnum {
        received: String,
        options: Vec<String>,
    },
    /// Below the minimum (`kind`: "string" for a length, "number").
    TooSmall {
        minimum: f64,
        kind: &'static str,
        inclusive: bool,
    },
    /// Above the maximum.
    TooBig {
        maximum: f64,
        kind: &'static str,
        inclusive: bool,
    },
    /// Keys the object does not allow.
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
    /// What is wrong, without the rejected value itself (except an enum's).
    pub fn message(&self) -> String {
        match &self.kind {
            IssueKind::InvalidType { expected, received }
            | IssueKind::EnumType { expected, received } => {
                if *received == "nothing" {
                    format!("Required ({expected})")
                } else {
                    format!("Expected {expected}, received {received}")
                }
            }
            IssueKind::NotInteger => "Expected an integer".to_owned(),
            IssueKind::InvalidEnum { received, options } => format!(
                "Expected one of {}, received '{received}'",
                join_values(options, ", ")
            ),
            IssueKind::TooSmall {
                minimum,
                kind,
                inclusive,
            } => {
                let minimum = js::number_text(*minimum);
                let bound = if *inclusive { "at least" } else { "more than" };
                if *kind == "string" {
                    format!("Expected {bound} {minimum} characters")
                } else {
                    format!("Expected {bound} {minimum}")
                }
            }
            IssueKind::TooBig {
                maximum,
                kind,
                inclusive,
            } => {
                let maximum = js::number_text(*maximum);
                let bound = if *inclusive { "at most" } else { "less than" };
                if *kind == "string" {
                    format!("Expected {bound} {maximum} characters")
                } else {
                    format!("Expected {bound} {maximum}")
                }
            }
            IssueKind::UnrecognizedKeys { keys } => {
                format!("Unknown key(s): {}", join_values(keys, ", "))
            }
        }
    }

    /// The path as `a.b[0].c` (`(root)` for the value itself).
    pub fn path_text(&self) -> String {
        let mut out = String::new();
        for part in &self.path {
            match part {
                PathPart::Key(key) => {
                    if !out.is_empty() {
                        out.push('.');
                    }
                    out.push_str(key);
                }
                PathPart::Index(index) => out.push_str(&format!("[{index}]")),
            }
        }
        if out.is_empty() {
            out.push_str("(root)");
        }
        out
    }
}

/// Every issue as `<path>: <message>`, one per line.
pub fn error_message(issues: &[Issue]) -> String {
    issues
        .iter()
        .map(|issue| format!("{}: {}", issue.path_text(), issue.message()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The type name of a JSON value (`nothing` when absent).
pub fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "nothing",
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

/// Collects issues while a value is walked.
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
    fn lists_every_issue_with_its_path() {
        let mut checker = Checker::default();
        let value = json!({"a": 1.5, "b": "x", "c": "q", "extra": 1, "f": [1, "y"]});
        let map = value.as_object().unwrap();
        checker.key(map, "a", |c, v| c.positive_int(v, Some(1.0)));
        checker.key(map, "b", |c, v| c.string(v, Some(2)));
        checker.key(map, "c", |c, v| c.enumeration(v, &["x", "y"]));
        checker.key(map, "d", |c, v| c.enumeration(v, &["x"]));
        checker.key(map, "e", |c, v| c.boolean(v));
        checker.key(map, "f", |c, v| c.string_array(v));
        checker.strict(map, &["a", "b", "c", "f"]);
        assert_eq!(
            error_message(&checker.issues),
            "a: Expected an integer\n\
             a: Expected at most 1\n\
             b: Expected at least 2 characters\n\
             c: Expected one of 'x', 'y', received 'q'\n\
             d: Required ('x')\n\
             e: Required (boolean)\n\
             f[0]: Expected string, received number\n\
             (root): Unknown key(s): 'extra'"
        );
    }
}
