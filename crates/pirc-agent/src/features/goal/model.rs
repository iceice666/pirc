//! Pure goal state (`agent/features/goal/model.ts`): one persisted
//! completion objective per session, advanced by automatic continuation
//! rounds until it is completed, blocked or paused.
//!
//! A goal is kept as the JSON object TS kept: its keys stay in the order
//! the TS spreads produced them, and a goal restored from the session keeps
//! whatever extra keys it had (`parseGoal` checks a few fields only).

use serde_json::{Map, Value, json};

use crate::tools::js;

pub const MAX_OBJECTIVE: usize = 4000;
pub const MAX_REASON: usize = 2000;

/// `GoalAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoalAction {
    Edit,
    Pause,
    Resume,
    Complete,
    Blocked,
}

impl GoalAction {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "edit" => Self::Edit,
            "pause" => Self::Pause,
            "resume" => Self::Resume,
            "complete" => Self::Complete,
            "blocked" => Self::Blocked,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Complete => "complete",
            Self::Blocked => "blocked",
        }
    }
}

/// `GoalUpdate` (without its action).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GoalUpdate {
    pub objective: Option<String>,
    pub max_rounds: Option<i64>,
    pub blocked_reason: Option<String>,
}

/// `Goal`.
#[derive(Clone, Debug, PartialEq)]
pub struct Goal(Map<String, Value>);

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger(value)`.
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE).then_some(number as i64)
}

/// `ToNumber(value)` for the JSON values a damaged goal may hold.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = js::trim(s);
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

impl Goal {
    pub fn to_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    fn text(&self, key: &str) -> String {
        self.0.get(key).map(js::string_of).unwrap_or_default()
    }

    pub fn id(&self) -> String {
        self.text("id")
    }

    pub fn objective(&self) -> String {
        self.text("objective")
    }

    pub fn phase(&self) -> String {
        self.text("phase")
    }

    pub fn is_active(&self) -> bool {
        self.phase() == "active"
    }

    /// The revision as JSON (`goal.revision`).
    pub fn revision_value(&self) -> Value {
        self.0.get("revision").cloned().unwrap_or(Value::Null)
    }

    pub fn revision(&self) -> i64 {
        safe_integer(self.0.get("revision")).unwrap_or(0)
    }

    pub fn rounds(&self) -> i64 {
        safe_integer(self.0.get("rounds")).unwrap_or(0)
    }

    /// `goal.maxRounds`, unless undefined.
    pub fn max_rounds(&self) -> Option<&Value> {
        self.0.get("maxRounds")
    }

    /// `goal.blockedReason ?? goal.pausedReason`.
    pub fn reason(&self) -> Option<&Value> {
        [self.0.get("blockedReason"), self.0.get("pausedReason")]
            .into_iter()
            .flatten()
            .find(|value| !value.is_null())
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
}

/// `clean`: CRLF and CR become LF, then trimmed.
fn clean(text: &str) -> String {
    js::trim(&text.replace("\r\n", "\n").replace('\r', "\n")).to_owned()
}

/// `validMaxRounds(value)`.
pub fn valid_max_rounds(value: Option<&Value>) -> Result<Option<i64>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match safe_integer(Some(value)) {
            Some(n) if n >= 1 => Ok(Some(n)),
            _ => Err("max_goal_rounds must be a positive safe integer".to_owned()),
        },
    }
}

/// `validObjective(value)`.
pub fn valid_objective(value: &str) -> Result<String, String> {
    let text = clean(value);
    if text.is_empty() {
        return Err("objective must be a non-empty string".to_owned());
    }
    if js::len16(&text) > MAX_OBJECTIVE {
        return Err(format!(
            "objective must be at most {MAX_OBJECTIVE} characters"
        ));
    }
    Ok(text)
}

/// `createGoal(id, objective, maxRounds, now)`.
pub fn create_goal(
    id: &str,
    objective: &str,
    max_rounds: Option<i64>,
    now: u64,
) -> Result<Goal, String> {
    let limit = valid_max_rounds(max_rounds.map(|n| json!(n)).as_ref())?;
    let objective = valid_objective(objective)?;
    let mut goal = Map::new();
    goal.insert("id".to_owned(), json!(id));
    goal.insert("revision".to_owned(), json!(1));
    goal.insert("objective".to_owned(), json!(objective));
    goal.insert("phase".to_owned(), json!("active"));
    goal.insert("rounds".to_owned(), json!(0));
    if let Some(limit) = limit {
        goal.insert("maxRounds".to_owned(), json!(limit));
    }
    goal.insert("createdAt".to_owned(), json!(now));
    goal.insert("updatedAt".to_owned(), json!(now));
    Ok(Goal(goal))
}

/// `isOpen`: a goal that still needs work; a new one may not replace it.
pub fn is_open(goal: Option<&Goal>) -> bool {
    goal.is_some_and(|goal| matches!(goal.phase().as_str(), "active" | "paused"))
}

/// `atLimit`.
pub fn at_limit(goal: &Goal) -> bool {
    goal.max_rounds()
        .is_some_and(|max| goal.get("rounds").map_or(f64::NAN, to_number) >= to_number(max))
}

/// `next`: `{...goal, ...patch, revision: goal.revision + 1, updatedAt: now}`,
/// without the reasons that no longer apply.
fn next(goal: &Goal, patch: Vec<(&str, Value)>, now: u64) -> Goal {
    let mut out = goal.0.clone();
    for (key, value) in patch {
        out.insert(key.to_owned(), value);
    }
    out.insert("revision".to_owned(), json!(goal.revision() + 1));
    out.insert("updatedAt".to_owned(), json!(now));
    let phase = out.get("phase").map(js::string_of).unwrap_or_default();
    if phase != "blocked" {
        out.shift_remove("blockedReason");
    }
    if phase != "paused" {
        out.shift_remove("pausedReason");
    }
    Goal(out)
}

/// `applyUpdate`: `Err` with a model-readable reason when it is not allowed.
pub fn apply_update(
    goal: &Goal,
    action: GoalAction,
    update: &GoalUpdate,
    min_blocked_rounds: i64,
    now: u64,
) -> Result<Goal, String> {
    let phase = goal.phase();
    match action {
        GoalAction::Edit => {
            if update.objective.is_none() && update.max_rounds.is_none() {
                return Err("edit needs objective and/or max_goal_rounds".to_owned());
            }
            let mut patch = Vec::new();
            if let Some(objective) = &update.objective {
                patch.push(("objective", json!(valid_objective(objective)?)));
            }
            if let Some(limit) = valid_max_rounds(update.max_rounds.map(|n| json!(n)).as_ref())? {
                patch.push(("maxRounds", json!(limit)));
            }
            Ok(next(goal, patch, now))
        }
        GoalAction::Pause => {
            if phase != "active" {
                return Err(format!("Cannot pause a {phase} goal"));
            }
            Ok(next(goal, vec![("phase", json!("paused"))], now))
        }
        GoalAction::Resume => {
            if phase == "active" {
                return Err("The goal is already active".to_owned());
            }
            if phase == "complete" {
                return Err("Cannot resume a completed goal".to_owned());
            }
            if at_limit(goal) {
                return Err(format!(
                    "The goal used all {} continuation rounds; raise max_goal_rounds with edit first",
                    goal.max_rounds().map(js::string_of).unwrap_or_default()
                ));
            }
            Ok(next(goal, vec![("phase", json!("active"))], now))
        }
        GoalAction::Complete => {
            if phase == "complete" {
                return Err("The goal is already complete".to_owned());
            }
            Ok(next(goal, vec![("phase", json!("complete"))], now))
        }
        GoalAction::Blocked => {
            if phase != "active" {
                return Err(format!("Cannot block a {phase} goal"));
            }
            let reason = clean(update.blocked_reason.as_deref().unwrap_or_default());
            if reason.is_empty() {
                return Err("blocked needs blocked_reason".to_owned());
            }
            if goal.rounds() < min_blocked_rounds {
                return Err(format!(
                    "blocked is rejected before {min_blocked_rounds} continuation rounds ({} so far); keep working or report the blocker",
                    goal.get("rounds").map(js::string_of).unwrap_or_default()
                ));
            }
            Ok(next(
                goal,
                vec![
                    ("phase", json!("blocked")),
                    ("blockedReason", json!(js::head16(&reason, MAX_REASON))),
                ],
                now,
            ))
        }
    }
}

/// `startRound`.
pub fn start_round(goal: &Goal, now: u64) -> Goal {
    next(goal, vec![("rounds", json!(goal.rounds() + 1))], now)
}

/// `autoPause`.
pub fn auto_pause(goal: &Goal, reason: &str, now: u64) -> Goal {
    let mut out = next(goal, vec![("phase", json!("paused"))], now);
    out.0.insert("pausedReason".to_owned(), json!(reason));
    out
}

/// `parseGoal`: `Some(None)` for a cleared goal, `None` for a damaged one.
pub fn parse_goal(value: &Value) -> Option<Option<Goal>> {
    let object = match value {
        Value::Null => return Some(None),
        Value::Object(object) => object,
        _ => return None,
    };
    let valid = object.get("id").is_some_and(Value::is_string)
        && object.get("objective").is_some_and(Value::is_string)
        && safe_integer(object.get("revision")).is_some()
        && safe_integer(object.get("rounds")).is_some()
        && object
            .get("phase")
            .and_then(Value::as_str)
            .is_some_and(|phase| matches!(phase, "active" | "paused" | "blocked" | "complete"));
    valid.then(|| Some(Goal(object.clone())))
}

/// `formatGoal`.
pub fn format_goal(goal: Option<&Goal>) -> String {
    let Some(goal) = goal else {
        return "No goal.".to_owned();
    };
    let shown = |key: &str| goal.get(key).map(js::string_of).unwrap_or_default();
    let mut lines = vec![
        format!(
            "Goal {} (revision {}) — {}",
            shown("id"),
            shown("revision"),
            shown("phase")
        ),
        format!("Objective: {}", shown("objective")),
        format!(
            "Continuation rounds: {}{}",
            shown("rounds"),
            goal.max_rounds()
                .map(|max| format!(" / {}", js::string_of(max)))
                .unwrap_or_default()
        ),
    ];
    if js::truthy(goal.get("blockedReason")) {
        lines.push(format!("Blocked: {}", shown("blockedReason")));
    }
    if js::truthy(goal.get("pausedReason")) {
        lines.push(format!("Paused: {}", shown("pausedReason")));
    }
    lines.join("\n")
}

/// `safe`: control characters become spaces, trimmed.
fn safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js::trim(&out).to_owned()
}

/// `goalWidget`: plain text the web goal dock parses back:
/// `GOAL · <phase>[ · disarmed] · <rounds>[/<max>]`, the objective on one
/// line, then an optional reason line.
pub fn goal_widget(goal: &Goal, armed: bool) -> Vec<String> {
    let rounds = format!(
        "{}{}",
        goal.get("rounds").map(js::string_of).unwrap_or_default(),
        goal.max_rounds()
            .map(|max| format!("/{}", js::string_of(max)))
            .unwrap_or_default()
    );
    let phase = goal.phase();
    let mut lines = vec![
        format!(
            "GOAL · {phase}{} · {rounds}",
            if phase == "active" && !armed {
                " · disarmed"
            } else {
                ""
            }
        ),
        safe(&goal.objective()),
    ];
    if let Some(reason) = goal.reason().filter(|reason| js::truthy(Some(reason))) {
        lines.push(safe(&js::string_of(reason)));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(max: Option<i64>) -> Goal {
        create_goal("abc", "  Ship it\r\n", max, 10).unwrap()
    }

    #[test]
    fn creates_and_validates() {
        let created = goal(Some(2));
        assert_eq!(
            created.to_value(),
            json!({ "id": "abc", "revision": 1, "objective": "Ship it", "phase": "active",
                "rounds": 0, "maxRounds": 2, "createdAt": 10, "updatedAt": 10 })
        );
        assert_eq!(
            create_goal("x", " \r\n", None, 1).unwrap_err(),
            "objective must be a non-empty string"
        );
        assert_eq!(
            create_goal("x", &"a".repeat(4001), None, 1).unwrap_err(),
            "objective must be at most 4000 characters"
        );
        assert_eq!(
            create_goal("x", "a", Some(0), 1).unwrap_err(),
            "max_goal_rounds must be a positive safe integer"
        );
        for bad in [json!(1.5), json!("2"), json!(0), json!(1e20)] {
            assert!(valid_max_rounds(Some(&bad)).is_err(), "{bad}");
        }
        assert_eq!(valid_max_rounds(Some(&json!(3.0))), Ok(Some(3)));
        assert_eq!(valid_max_rounds(Some(&Value::Null)), Ok(None));
    }

    #[test]
    fn updates_follow_the_rules() {
        let active = goal(Some(1));
        let edit = |update: GoalUpdate| apply_update(&active, GoalAction::Edit, &update, 3, 20);
        assert_eq!(
            edit(GoalUpdate::default()).unwrap_err(),
            "edit needs objective and/or max_goal_rounds"
        );
        let edited = edit(GoalUpdate {
            max_rounds: Some(5),
            ..GoalUpdate::default()
        })
        .unwrap();
        assert_eq!(edited.revision(), 2);
        assert_eq!(edited.max_rounds(), Some(&json!(5)));
        let paused =
            apply_update(&active, GoalAction::Pause, &GoalUpdate::default(), 3, 20).unwrap();
        assert_eq!(
            apply_update(&paused, GoalAction::Pause, &GoalUpdate::default(), 3, 20).unwrap_err(),
            "Cannot pause a paused goal"
        );
        let round = start_round(&active, 30);
        assert!(at_limit(&round));
        let limited = auto_pause(&round, "Used all 1 continuation rounds.", 40);
        assert_eq!(
            limited.to_value(),
            json!({ "id": "abc", "revision": 3, "objective": "Ship it", "phase": "paused",
                "rounds": 1, "maxRounds": 1, "createdAt": 10, "updatedAt": 40,
                "pausedReason": "Used all 1 continuation rounds." })
        );
        assert_eq!(
            apply_update(&limited, GoalAction::Resume, &GoalUpdate::default(), 3, 50).unwrap_err(),
            "The goal used all 1 continuation rounds; raise max_goal_rounds with edit first"
        );
        let blocked = |goal: &Goal, reason: Option<&str>, min| {
            apply_update(
                goal,
                GoalAction::Blocked,
                &GoalUpdate {
                    blocked_reason: reason.map(str::to_owned),
                    ..GoalUpdate::default()
                },
                min,
                60,
            )
        };
        assert_eq!(
            blocked(&round, Some("x"), 3).unwrap_err(),
            "blocked is rejected before 3 continuation rounds (1 so far); keep working or report the blocker"
        );
        assert_eq!(
            blocked(&round, Some(" \r "), 0).unwrap_err(),
            "blocked needs blocked_reason"
        );
        let stuck = blocked(&round, Some(" stuck\r\n"), 1).unwrap();
        assert_eq!(stuck.reason(), Some(&json!("stuck")));
        assert_eq!(
            format_goal(Some(&stuck)),
            "Goal abc (revision 3) — blocked\nObjective: Ship it\nContinuation rounds: 1 / 1\nBlocked: stuck"
        );
        // Leaving the blocked phase drops its reason.
        let done =
            apply_update(&stuck, GoalAction::Complete, &GoalUpdate::default(), 3, 70).unwrap();
        assert_eq!(done.reason(), None);
        assert_eq!(
            apply_update(&done, GoalAction::Complete, &GoalUpdate::default(), 3, 70).unwrap_err(),
            "The goal is already complete"
        );
        assert_eq!(
            apply_update(&done, GoalAction::Resume, &GoalUpdate::default(), 3, 70).unwrap_err(),
            "Cannot resume a completed goal"
        );
    }

    #[test]
    fn parses_and_shows_goals() {
        assert_eq!(parse_goal(&Value::Null), Some(None));
        assert_eq!(parse_goal(&json!({ "id": 7 })), None);
        assert_eq!(parse_goal(&json!([])), None);
        let restored = parse_goal(
            &json!({ "id": "g", "objective": "Do\u{7}it\n", "revision": 2,
            "rounds": 0, "phase": "active", "extra": true }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            goal_widget(&restored, false),
            ["GOAL · active · disarmed · 0", "Do it"]
        );
        assert_eq!(format_goal(None), "No goal.");
        let paused = auto_pause(&goal(None), "Stopped.", 5);
        assert_eq!(
            goal_widget(&paused, true),
            ["GOAL · paused · 0", "Ship it", "Stopped."]
        );
    }
}
