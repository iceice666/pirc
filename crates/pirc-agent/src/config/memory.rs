//! The observational memory settings check (`features/memory/config.ts`
//! `validateMemoryConfig`), as far as `loadAgentConfig` uses it: the
//! startup warning, which never repeats a configured value.

use serde_json::{Map, Value};

use super::schema::{Checker, Issue, IssueKind, PathPart};

use crate::features::memory::config::{MEMORY_KEYS, MODEL_KEYS, THINKING_CHOICES, WORKSPACE_KEYS};

/// `modelChoice`.
fn model_choice(checker: &mut Checker, value: Option<&Value>) {
    let Some(map) = checker.object(value) else {
        return;
    };
    checker.key(map, "provider", |c, v| c.string(v, Some(1)));
    checker.key(map, "id", |c, v| c.string(v, Some(1)));
    checker.key(map, "thinking", |c, v| {
        if v.is_some() {
            c.enumeration(v, &THINKING_CHOICES);
        }
    });
}

fn workspace_fields(c: &mut Checker, value: Option<&Value>) {
    let Some(map) = c.object(value) else { return };
    for key in WORKSPACE_KEYS {
        c.key(map, key, |c, v| {
            if v.is_none() {
                return;
            }
            match key {
                "enabled" | "passive" => {
                    c.boolean(v);
                }
                "model" => model_choice(c, v),
                "fallbackModels" => {
                    if let Some(items) = c.array(v) {
                        for (i, item) in items.iter().enumerate() {
                            c.at(PathPart::Index(i), |c| model_choice(c, Some(item)));
                        }
                    }
                }
                _ => {
                    c.positive_int(v, None);
                }
            }
        });
    }
}

/// The problems in `features.observationalMemory`, in schema order.
fn memory_issues(raw: Option<&Value>) -> Vec<Issue> {
    let mut checker = Checker::default();
    let Some(map) = checker.object(raw) else {
        return checker.issues;
    };
    let optional =
        |c: &mut Checker, v: Option<&Value>, check: &dyn Fn(&mut Checker, Option<&Value>)| {
            if v.is_some() {
                check(c, v);
            }
        };
    let boolean = |c: &mut Checker, v: Option<&Value>| {
        c.boolean(v);
    };
    let positive = |c: &mut Checker, v: Option<&Value>| {
        c.positive_int(v, None);
    };
    for key in MEMORY_KEYS {
        checker.key(map, key, |c, v| match key {
            "enabled" | "passive" | "showWorkerNotifications" => optional(c, v, &boolean),
            "compactAfterTokensMode" => optional(c, v, &|c, v| {
                c.enumeration(v, &["calibrated", "ratio"]);
            }),
            "missingModelPolicy" => optional(c, v, &|c, v| {
                c.enumeration(v, &["fallback", "error"]);
            }),
            "compactAfterTokensRatio" => optional(c, v, &|c, v| {
                c.number(v, false, Some((0.0, false)), Some((1.0, false)));
            }),
            "model" => optional(c, v, &model_choice),
            "fallbackModels" => optional(c, v, &|c, v| {
                if let Some(items) = c.array(v) {
                    for (index, item) in items.iter().enumerate() {
                        c.at(PathPart::Index(index), |c| model_choice(c, Some(item)));
                    }
                }
            }),
            "workspace" => optional(c, v, &|c, v| {
                workspace_fields(c, v);
            }),
            _ => optional(c, v, &positive),
        });
    }
    checker.issues
}

/// Whether `memorySchema.safeParse(raw)` succeeds (`raw` is
/// `features.observationalMemory ?? {}`); unknown keys do not count.
pub fn memory_settings_valid(raw: &Value) -> bool {
    memory_issues(Some(raw)).is_empty()
}

fn field_path(parts: &[PathPart]) -> String {
    let mut out = "features.observationalMemory".to_owned();
    for part in parts {
        match part {
            PathPart::Key(key) => {
                out.push('.');
                out.push_str(key);
            }
            PathPart::Index(index) => out.push_str(&format!("[{index}]")),
        }
    }
    out
}

/// `reason(issue)`: never the rejected value.
fn reason(issue: &Issue) -> String {
    match &issue.kind {
        IssueKind::InvalidType { expected, .. } | IssueKind::EnumType { expected, .. } => {
            format!("expected {expected}")
        }
        IssueKind::NotInteger => "expected integer".to_owned(),
        IssueKind::InvalidEnum { .. } => "expected a supported option".to_owned(),
        IssueKind::TooSmall {
            minimum, inclusive, ..
        } => format!(
            "must be {} {}",
            if *inclusive {
                "at least"
            } else {
                "greater than"
            },
            crate::messages::js::number_text(*minimum)
        ),
        IssueKind::TooBig {
            maximum, inclusive, ..
        } => format!(
            "must be {} {}",
            if *inclusive { "at most" } else { "less than" },
            crate::messages::js::number_text(*maximum)
        ),
        IssueKind::UnrecognizedKeys { .. } => "invalid field".to_owned(),
    }
}

/// `validateMemoryConfig(features).warning`.
pub fn memory_config_warning(features: &Map<String, Value>) -> Option<String> {
    let raw = features
        .get("observationalMemory")
        .filter(|value| !value.is_null());
    let empty = Value::Object(Map::new());
    let raw = raw.unwrap_or(&empty);
    let issues = memory_issues(Some(raw));
    let mut parsed = issues.is_empty();
    let mut diagnostics: Vec<String> = issues
        .iter()
        .map(|issue| format!("{}: {}", field_path(&issue.path), reason(issue)))
        .collect();
    let mut unknown_keys = |value: Option<&Value>, keys: &[&str], parts: &[PathPart]| {
        let Some(Value::Object(map)) = value else {
            return;
        };
        for key in map.keys() {
            if !keys.contains(&key.as_str()) {
                // Quoted, so punctuation cannot impersonate another warning.
                diagnostics.push(format!(
                    "{}[{}]: unknown field (ignored)",
                    field_path(parts),
                    crate::messages::js::string_literal(key)
                ));
            }
        }
    };
    unknown_keys(Some(raw), &MEMORY_KEYS, &[]);
    if let Value::Object(map) = raw {
        unknown_keys(
            map.get("model"),
            &MODEL_KEYS,
            &[PathPart::Key("model".into())],
        );
        if let Some(Value::Array(models)) = map.get("fallbackModels") {
            for (index, model) in models.iter().enumerate() {
                unknown_keys(
                    Some(model),
                    &MODEL_KEYS,
                    &[
                        PathPart::Key("fallbackModels".into()),
                        PathPart::Index(index),
                    ],
                );
            }
        }
        unknown_keys(
            map.get("workspace"),
            &WORKSPACE_KEYS,
            &[PathPart::Key("workspace".into())],
        );
    }
    if let Some(canonical) = features.get("workspaceMemory") {
        let mut checker = Checker::default();
        workspace_fields(&mut checker, Some(canonical));
        parsed &= checker.issues.is_empty();
        for issue in checker.issues {
            let suffix = field_path(&issue.path)
                .trim_start_matches("features.observationalMemory")
                .to_owned();
            diagnostics.push(format!(
                "features.workspaceMemory{suffix}: {}",
                reason(&issue)
            ));
        }
        if let Some(map) = canonical.as_object() {
            for key in map
                .keys()
                .filter(|key| !WORKSPACE_KEYS.contains(&key.as_str()))
            {
                diagnostics.push(format!(
                    "features.workspaceMemory[{}]: unknown field (ignored)",
                    crate::messages::js::string_literal(key)
                ));
            }
        }
    }
    if diagnostics.is_empty() {
        return None;
    }
    let summary = if parsed {
        "unknown fields were ignored; valid settings remain in effect."
    } else {
        "invalid fields use defaults; valid settings, including explicit disable flags, remain in effect."
    };
    Some(format!(
        "Observational memory configuration: {summary} {} Fix features.observationalMemory in the node config.json and restart the agent. PIRC_MEMORY_PASSIVE still overrides passive.",
        diagnostics.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn warning(memory: Value) -> Option<String> {
        let features = json!({ "observationalMemory": memory });
        memory_config_warning(features.as_object().unwrap())
    }

    #[test]
    fn accepts_defaults_and_valid_disabled_settings_without_a_warning() {
        assert_eq!(memory_config_warning(&Map::new()), None);
        assert_eq!(warning(Value::Null), None);
        assert_eq!(
            warning(json!({"enabled": false, "workspace": {"enabled": false}})),
            None
        );
    }

    #[test]
    fn warns_that_one_malformed_fallback_resets_the_whole_config() {
        let text = warning(json!({
            "enabled": false,
            "workspace": {"enabled": false},
            "observeAfterTokens": 42,
            "fallbackModels": [
                {"provider": "fake", "id": "model"},
                {"provider": "", "id": "private-model-value"}
            ]
        }))
        .unwrap();
        assert_eq!(
            text,
            "Observational memory configuration: invalid fields use defaults; valid settings, including explicit disable flags, remain in effect. features.observationalMemory.fallbackModels[1].provider: must be at least 1 Fix features.observationalMemory in the node config.json and restart the agent. PIRC_MEMORY_PASSIVE still overrides passive."
        );
    }

    #[test]
    fn reports_invalid_fields_and_multiple_reasons_without_rejected_values() {
        let text = warning(json!({
            "enabled": "private-enabled-value",
            "workspace": {"enabled": "private-workspace-value", "shutdownTimeoutMs": -1},
            "model": {"provider": "private-provider", "id": "private-model", "thinking": "private-enum-value"},
            "compactAfterTokensRatio": 1,
            "agentMaxTurns": 1.5,
            "compactAfterTokensMode": 3
        }))
        .unwrap();
        assert!(!text.contains("private-"));
        assert_eq!(
            text,
            "Observational memory configuration: invalid fields use defaults; valid settings, including explicit disable flags, remain in effect. features.observationalMemory.enabled: expected boolean; features.observationalMemory.compactAfterTokensMode: expected 'calibrated' | 'ratio'; features.observationalMemory.compactAfterTokensRatio: must be less than 1; features.observationalMemory.agentMaxTurns: expected integer; features.observationalMemory.model.thinking: expected a supported option; features.observationalMemory.workspace.enabled: expected boolean; features.observationalMemory.workspace.shutdownTimeoutMs: must be greater than 0 Fix features.observationalMemory in the node config.json and restart the agent. PIRC_MEMORY_PASSIVE still overrides passive."
        );
    }

    #[test]
    fn warns_about_unknown_keys_at_every_schema_object() {
        let text = warning(json!({
            "enabled": false,
            "observeAfterTokens": 123,
            "legacy": "secret-value",
            "model": {"provider": "p", "id": "m", "thinking": "max", "extra": "secret-value"},
            "fallbackModels": [{"provider": "p", "id": "fallback", "typo": "secret-value"}],
            "workspace": {"enabled": false, "other": "secret-value"}
        }))
        .unwrap();
        assert_eq!(
            text,
            "Observational memory configuration: unknown fields were ignored; valid settings remain in effect. features.observationalMemory[\"legacy\"]: unknown field (ignored); features.observationalMemory.model[\"extra\"]: unknown field (ignored); features.observationalMemory.fallbackModels[0][\"typo\"]: unknown field (ignored); features.observationalMemory.workspace[\"other\"]: unknown field (ignored) Fix features.observationalMemory in the node config.json and restart the agent. PIRC_MEMORY_PASSIVE still overrides passive."
        );
    }

    #[test]
    fn reports_invalid_whole_object_input_without_its_value() {
        for value in [json!(false), json!([]), json!("private-whole-object")] {
            let text = warning(value).unwrap();
            assert!(text.contains("features.observationalMemory: expected object"));
            assert!(!text.contains("private-whole-object"));
        }
        let text = warning(json!({"fallbackModels": [{"provider": "fake"}]})).unwrap();
        assert!(text.contains("fallbackModels[0].id: expected string"));
    }
}

#[cfg(test)]
mod workspace_diagnostics_tests {
    use super::*;
    #[test]
    fn legacy_and_canonical_workspace_choices_share_validation() {
        let settings = serde_json::json!({"enabled":false,"passive":true,"model":{"provider":"p","id":"m","thinking":"max"},"fallbackModels":[{"provider":"p","id":"f"}],"maxTokens":40000});
        for features in [
            serde_json::json!({"workspaceMemory":settings}),
            serde_json::json!({"observationalMemory":{"workspace":settings}}),
        ] {
            assert_eq!(memory_config_warning(features.as_object().unwrap()), None);
        }
        let warning=memory_config_warning(serde_json::json!({"workspaceMemory":{"passive":"private-value","fallbackModels":[{"provider":"p","id":"private-model","thinking":"private-thinking"}]}}).as_object().unwrap()).unwrap();
        assert!(warning.contains("features.workspaceMemory.passive"));
        assert!(warning.contains("features.workspaceMemory.fallbackModels[0].thinking"));
        assert!(
            !warning.contains("private-value")
                && !warning.contains("private-model")
                && !warning.contains("private-thinking")
        );
    }
}
