//! The todo list's model (`agent/features/todo/model.ts`, ported from the
//! Pi `todo` extension): a validated state, atomic actions and the text
//! the model reads. Actions arrive as the model or a slash command wrote
//! them (JSON), so every field is checked as the TS code checked it, with
//! the same error texts.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::tools::js;

const MAX_TODOS: usize = 50;
const MAX_ID: u64 = 1_000_000;

/// `Status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    InProgress,
    Completed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::InProgress => "In progress",
            Self::Completed => "Completed",
        }
    }
}

/// `Todo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Todo {
    pub id: u64,
    pub text: String,
    pub status: Status,
    pub active_form: Option<String>,
    pub category: Option<String>,
    pub blocked_by: Vec<u64>,
}

/// `State` (`version: 1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub next_id: u64,
    pub todos: Vec<Todo>,
}

impl Default for State {
    /// `emptyState()`.
    fn default() -> Self {
        Self {
            next_id: 1,
            todos: Vec::new(),
        }
    }
}

impl Todo {
    /// As `checkedState` builds it: `id`, `text`, `status`, `blockedBy`,
    /// then the optional fields.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".to_owned(), json!(self.id));
        out.insert("text".to_owned(), json!(self.text));
        out.insert("status".to_owned(), json!(self.status.as_str()));
        out.insert("blockedBy".to_owned(), json!(self.blocked_by));
        if let Some(active_form) = &self.active_form {
            out.insert("activeForm".to_owned(), json!(active_form));
        }
        if let Some(category) = &self.category {
            out.insert("category".to_owned(), json!(category));
        }
        Value::Object(out)
    }
}

impl State {
    pub fn to_value(&self) -> Value {
        json!({ "version": 1, "nextId": self.next_id, "todos": self.todos_value() })
    }

    pub fn todos_value(&self) -> Value {
        Value::Array(self.todos.iter().map(Todo::to_value).collect())
    }
}

/// `controls`: C0, DEL, C1 and the two JavaScript line terminators.
fn has_controls(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}'))
}

/// `positiveId`: a safe integer in 1..=1,000,000.
fn positive_id(value: Option<&Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    (n.fract() == 0.0 && n > 0.0 && n <= MAX_ID as f64).then_some(n as u64)
}

/// `boundedText`.
fn bounded_text(value: Option<&Value>, name: &str, limit: usize) -> Result<String, String> {
    let text = match value {
        Some(Value::String(text)) if !has_controls(text) => text,
        _ => {
            return Err(format!(
                "{name} must be a string without control characters"
            ));
        }
    };
    let result = js::trim(text);
    if result.is_empty() || js::len16(result) > limit {
        return Err(format!("{name} must contain 1–{limit} characters"));
    }
    Ok(result.to_owned())
}

/// `actionCategory`: an empty category clears it (`None`).
fn action_category(value: Option<&Value>) -> Result<Option<String>, String> {
    if let Some(Value::String(text)) = value
        && !has_controls(text)
        && js::trim(text).is_empty()
    {
        return Ok(None);
    }
    bounded_text(value, "category", 60).map(Some)
}

/// `validStatus`.
fn valid_status(value: Option<&Value>) -> Result<Status, String> {
    match value.and_then(Value::as_str) {
        Some("pending") => Ok(Status::Pending),
        Some("in_progress") => Ok(Status::InProgress),
        Some("completed") => Ok(Status::Completed),
        _ => Err("Invalid task status".to_owned()),
    }
}

/// `dependencies`.
fn dependencies(value: Option<&Value>) -> Result<Vec<u64>, String> {
    let items = match value {
        Some(Value::Array(items)) if items.len() <= MAX_TODOS => items,
        _ => return Err("blockedBy must be an array of at most 50 task IDs".to_owned()),
    };
    let mut result = Vec::new();
    for item in items {
        match positive_id(Some(item)) {
            Some(id) if !result.contains(&id) => result.push(id),
            _ => return Err("Dependency IDs must be unique positive integers".to_owned()),
        }
    }
    Ok(result)
}

/// `checkedState`: validate and copy every field.
pub fn checked_state(value: &Value) -> Result<State, String> {
    let object = value.as_object();
    let next_id = object
        .filter(|object| object.get("version").and_then(Value::as_f64) == Some(1.0))
        .and_then(|object| positive_id(object.get("nextId")))
        .ok_or_else(|| "Invalid task state version or nextId".to_owned())?;
    let items = match object.and_then(|object| object.get("todos")) {
        Some(Value::Array(items)) if items.len() <= MAX_TODOS => items,
        _ => return Err("Task count cannot exceed 50".to_owned()),
    };
    let mut todos: Vec<Todo> = Vec::new();
    for item in items {
        let id = item
            .as_object()
            .and_then(|item| positive_id(item.get("id")))
            .filter(|id| !todos.iter().any(|todo| todo.id == *id) && *id < next_id)
            .ok_or_else(|| "Task ID is invalid, duplicated, or not less than nextId".to_owned())?;
        let get = |key: &str| item.get(key);
        let mut todo = Todo {
            id,
            text: bounded_text(get("text"), "text", 200)?,
            status: valid_status(get("status"))?,
            active_form: None,
            category: None,
            blocked_by: dependencies(get("blockedBy"))?,
        };
        if get("activeForm").is_some() {
            todo.active_form = Some(bounded_text(get("activeForm"), "activeForm", 100)?);
        }
        if get("category").is_some() {
            todo.category = Some(bounded_text(get("category"), "category", 60)?);
        }
        todos.push(todo);
    }
    for todo in &todos {
        for id in &todo.blocked_by {
            let Some(dependency) = todos
                .iter()
                .find(|item| item.id == *id)
                .filter(|_| *id != todo.id)
            else {
                return Err(
                    "Dependencies cannot reference missing tasks or the task itself".to_owned(),
                );
            };
            if todo.status != Status::Pending && dependency.status != Status::Completed {
                return Err(format!(
                    "Dependency #{id} of task #{} is not yet completed",
                    todo.id
                ));
            }
        }
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    fn visit(
        todos: &[Todo],
        id: u64,
        visiting: &mut HashSet<u64>,
        visited: &mut HashSet<u64>,
    ) -> Result<(), String> {
        if visiting.contains(&id) {
            return Err("Task dependencies cannot form cycles".to_owned());
        }
        if visited.contains(&id) {
            return Ok(());
        }
        visiting.insert(id);
        if let Some(todo) = todos.iter().find(|todo| todo.id == id) {
            for dependency in &todo.blocked_by {
                visit(todos, *dependency, visiting, visited)?;
            }
        }
        visiting.remove(&id);
        visited.insert(id);
        Ok(())
    }
    for todo in &todos {
        visit(&todos, todo.id, &mut visiting, &mut visited)?;
    }
    Ok(State { next_id, todos })
}

/// `parseState`: corrupt or incompatible persisted data is never partially
/// restored.
pub fn parse_state(value: &Value) -> Option<State> {
    checked_state(value).ok()
}

const ITEM_KEYS: [&str; 5] = ["text", "status", "activeForm", "category", "blockedBy"];

/// `applyAction`: every action is an atomic transaction, including reverse
/// dependency checks. `action` is the tool's arguments (or a slash
/// command's); a field is given when its key is present.
pub fn apply_action(state: &State, action: &Value) -> Result<State, String> {
    let mut next = checked_state(&state.to_value())?;
    let Some(action) = action.as_object() else {
        return Err("Invalid task action".to_owned());
    };
    let get = |key: &str| action.get(key);
    let kind = get("action").and_then(Value::as_str);
    if let Some(items) = get("items") {
        if kind != Some("add") {
            return Err("items is only supported for add".to_owned());
        }
        if [
            "id",
            "text",
            "status",
            "activeForm",
            "category",
            "blockedBy",
        ]
        .iter()
        .any(|key| get(key).is_some())
        {
            return Err("items cannot be combined with single-task fields".to_owned());
        }
        let items = match items {
            Value::Array(items) if !items.is_empty() && items.len() <= MAX_TODOS => items,
            _ => return Err("items must be an array of 1–50 tasks".to_owned()),
        };
        if next.todos.len() + items.len() > MAX_TODOS {
            return Err("Task count cannot exceed 50".to_owned());
        }
        if next.next_id + items.len() as u64 > MAX_ID {
            return Err("Task IDs exhausted".to_owned());
        }
        let mut batch = next;
        for item in items {
            let Some(item) = item
                .as_object()
                .filter(|item| item.keys().all(|key| ITEM_KEYS.contains(&key.as_str())))
            else {
                return Err("Each entry in items must be a task object containing only text, status, activeForm, category, and blockedBy".to_owned());
            };
            let mut single = Map::new();
            single.insert("action".to_owned(), json!("add"));
            for key in ITEM_KEYS {
                if let Some(value) = item.get(key) {
                    single.insert(key.to_owned(), value.clone());
                }
            }
            batch = apply_action(&batch, &Value::Object(single))?;
        }
        return Ok(batch);
    }
    match kind {
        Some("list") => return Ok(next),
        Some("add") => {
            if next.todos.len() >= MAX_TODOS {
                return Err("Task count cannot exceed 50".to_owned());
            }
            if next.next_id == MAX_ID {
                return Err("Task IDs exhausted".to_owned());
            }
            let id = next.next_id;
            next.next_id += 1;
            let mut todo = Todo {
                id,
                text: bounded_text(get("text"), "text", 200)?,
                status: match get("status") {
                    None => Status::Pending,
                    status => valid_status(status)?,
                },
                active_form: None,
                category: None,
                blocked_by: match get("blockedBy") {
                    None => Vec::new(),
                    blocked => dependencies(blocked)?,
                },
            };
            if get("activeForm").is_some() {
                todo.active_form = Some(bounded_text(get("activeForm"), "activeForm", 100)?);
            }
            if get("category").is_some() {
                todo.category = action_category(get("category"))?;
            }
            next.todos.push(todo);
        }
        Some("update") => {
            let found = positive_id(get("id"))
                .and_then(|id| next.todos.iter_mut().find(|todo| todo.id == id))
                .ok_or_else(|| "Task ID not found".to_owned())?;
            if get("text").is_some() {
                found.text = bounded_text(get("text"), "text", 200)?;
            }
            if get("status").is_some() {
                found.status = valid_status(get("status"))?;
            }
            if get("activeForm").is_some() {
                found.active_form = Some(bounded_text(get("activeForm"), "activeForm", 100)?);
            }
            if get("blockedBy").is_some() {
                found.blocked_by = dependencies(get("blockedBy"))?;
            }
            if get("category").is_some() {
                found.category = action_category(get("category"))?;
            }
        }
        Some("remove") => {
            let id = positive_id(get("id"))
                .filter(|id| next.todos.iter().any(|todo| todo.id == *id))
                .ok_or_else(|| "Task ID not found".to_owned())?;
            if next.todos.iter().any(|todo| todo.blocked_by.contains(&id)) {
                return Err("Cannot delete a task that other tasks still depend on".to_owned());
            }
            next.todos.retain(|todo| todo.id != id);
        }
        Some("clear") => next.todos.clear(),
        Some("prune") => {
            let removed: Vec<u64> = next
                .todos
                .iter()
                .filter(|todo| todo.status == Status::Completed)
                .map(|todo| todo.id)
                .collect();
            next.todos.retain(|todo| !removed.contains(&todo.id));
            for todo in &mut next.todos {
                todo.blocked_by.retain(|id| !removed.contains(id));
            }
        }
        _ => return Err("Unknown task action".to_owned()),
    }
    checked_state(&next.to_value())
}

/// `formatTodos`'s options.
#[derive(Default)]
pub struct FormatOptions<'a> {
    pub unfinished_only: bool,
    pub ids: Option<&'a [u64]>,
}

/// `formatTodos`. The full graph is validated before display rows are
/// filtered: completed dependencies still exist.
pub fn format_todos(state: &State, options: FormatOptions<'_>) -> Result<String, String> {
    let current = checked_state(&state.to_value())?;
    let rows: Vec<String> = current
        .todos
        .iter()
        .filter(|todo| {
            (!options.unfinished_only || todo.status != Status::Completed)
                && options.ids.is_none_or(|ids| ids.contains(&todo.id))
        })
        .map(|todo| {
            let blocked = if todo.blocked_by.is_empty() {
                String::new()
            } else {
                let ids: Vec<String> = todo.blocked_by.iter().map(|id| format!("#{id}")).collect();
                format!("; depends on: {}", ids.join(", "))
            };
            let category = todo
                .category
                .as_ref()
                .map_or_else(String::new, |category| format!(" [Category: {category}]"));
            format!(
                "#{} [{}]{category} {}{blocked}",
                todo.id,
                todo.status.label(),
                todo.text
            )
        })
        .collect();
    if rows.is_empty() {
        return Ok("No tasks yet.".to_owned());
    }
    Ok(rows.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(state: &State, action: Value) -> Result<State, String> {
        apply_action(state, &action)
    }

    fn format(state: &State) -> String {
        format_todos(state, FormatOptions::default()).unwrap()
    }

    #[test]
    fn adds_updates_and_formats() {
        let state = apply(
            &State::default(),
            json!({ "action": "add", "items": [
                { "text": "  write code ", "activeForm": "Writing code" },
                { "text": "test it", "blockedBy": [1], "category": "qa" },
            ] }),
        )
        .unwrap();
        assert_eq!(state.next_id, 3);
        assert_eq!(
            format(&state),
            "#1 [Pending] write code\n#2 [Pending] [Category: qa] test it; depends on: #1"
        );
        assert_eq!(
            apply(
                &state,
                json!({ "action": "update", "id": 2, "status": "in_progress" })
            )
            .unwrap_err(),
            "Dependency #1 of task #2 is not yet completed"
        );
        let state = apply(
            &state,
            json!({ "action": "update", "id": 1.0, "status": "completed" }),
        )
        .unwrap();
        assert_eq!(
            format_todos(
                &state,
                FormatOptions {
                    unfinished_only: true,
                    ids: None
                }
            )
            .unwrap(),
            "#2 [Pending] [Category: qa] test it; depends on: #1"
        );
        assert_eq!(
            apply(&state, json!({ "action": "remove", "id": 1 })).unwrap_err(),
            "Cannot delete a task that other tasks still depend on"
        );
        let pruned = apply(&state, json!({ "action": "prune" })).unwrap();
        assert_eq!(format(&pruned), "#2 [Pending] [Category: qa] test it");
        let cleared = apply(
            &pruned,
            json!({ "action": "update", "id": 2, "category": " " }),
        )
        .unwrap();
        assert_eq!(cleared.todos[0].category, None);
        assert_eq!(
            apply(&cleared, json!({ "action": "clear" })).unwrap(),
            State {
                next_id: 3,
                todos: Vec::new()
            }
        );
        assert_eq!(format(&State::default()), "No tasks yet.");
    }

    #[test]
    fn rejects_bad_actions_with_the_ts_errors() {
        let empty = State::default();
        let one = apply(&empty, json!({ "action": "add", "text": "a" })).unwrap();
        for (action, error) in [
            (json!("x"), "Invalid task action"),
            (json!({ "action": "frob" }), "Unknown task action"),
            (json!({}), "Unknown task action"),
            (
                json!({ "action": "list", "items": [] }),
                "items is only supported for add",
            ),
            (
                json!({ "action": "add", "items": [{ "text": "x" }], "text": "y" }),
                "items cannot be combined with single-task fields",
            ),
            (
                json!({ "action": "add", "items": null }),
                "items must be an array of 1–50 tasks",
            ),
            (
                json!({ "action": "add", "items": [] }),
                "items must be an array of 1–50 tasks",
            ),
            (
                json!({ "action": "add", "items": [{ "text": "x", "id": 3 }] }),
                "Each entry in items must be a task object containing only text, status, activeForm, category, and blockedBy",
            ),
            (
                json!({ "action": "add" }),
                "text must be a string without control characters",
            ),
            (
                json!({ "action": "add", "text": "a\u{2028}b" }),
                "text must be a string without control characters",
            ),
            (
                json!({ "action": "add", "text": "   " }),
                "text must contain 1–200 characters",
            ),
            (
                json!({ "action": "add", "text": "x".repeat(201) }),
                "text must contain 1–200 characters",
            ),
            (
                json!({ "action": "add", "text": "x", "status": "done" }),
                "Invalid task status",
            ),
            (
                json!({ "action": "add", "text": "x", "status": null }),
                "Invalid task status",
            ),
            (
                json!({ "action": "add", "text": "x", "blockedBy": [1, 1] }),
                "Dependency IDs must be unique positive integers",
            ),
            (
                json!({ "action": "add", "text": "x", "blockedBy": 1 }),
                "blockedBy must be an array of at most 50 task IDs",
            ),
            (
                json!({ "action": "add", "text": "x", "blockedBy": [9] }),
                "Dependencies cannot reference missing tasks or the task itself",
            ),
            (json!({ "action": "update", "id": 9 }), "Task ID not found"),
            (
                json!({ "action": "update", "id": 1.5 }),
                "Task ID not found",
            ),
            (
                json!({ "action": "remove", "id": "1" }),
                "Task ID not found",
            ),
            (
                json!({ "action": "update", "id": 1, "blockedBy": [1] }),
                "Dependencies cannot reference missing tasks or the task itself",
            ),
            (
                json!({ "action": "update", "id": 1, "category": "c\u{7}" }),
                "category must be a string without control characters",
            ),
        ] {
            assert_eq!(apply(&one, action.clone()).unwrap_err(), error, "{action}");
        }
        let full = apply(
            &empty,
            json!({ "action": "add", "items": (0..50).map(|i| json!({ "text": format!("t{i}") })).collect::<Vec<_>>() }),
        )
        .unwrap();
        assert_eq!(
            apply(&full, json!({ "action": "add", "text": "x" })).unwrap_err(),
            "Task count cannot exceed 50"
        );
    }

    #[test]
    fn restores_only_valid_states() {
        let valid = json!({ "version": 1, "nextId": 3, "todos": [
            { "id": 1, "text": "a", "status": "completed", "blockedBy": [] },
            { "id": 2, "text": "b", "status": "pending", "blockedBy": [1], "category": "x" } ] });
        assert_eq!(parse_state(&valid).unwrap().todos.len(), 2);
        for (state, error) in [
            (json!(null), "Invalid task state version or nextId"),
            (
                json!({ "version": 2, "nextId": 1, "todos": [] }),
                "Invalid task state version or nextId",
            ),
            (
                json!({ "version": 1, "nextId": 1 }),
                "Task count cannot exceed 50",
            ),
            (
                json!({ "version": 1, "nextId": 2, "todos": [{ "id": 2, "text": "a", "status": "pending", "blockedBy": [] }] }),
                "Task ID is invalid, duplicated, or not less than nextId",
            ),
            (
                json!({ "version": 1, "nextId": 3, "todos": [
                    { "id": 1, "text": "a", "status": "pending", "blockedBy": [2] },
                    { "id": 2, "text": "b", "status": "pending", "blockedBy": [1] } ] }),
                "Task dependencies cannot form cycles",
            ),
            (
                json!({ "version": 1, "nextId": 2, "todos": [
                    { "id": 1, "text": "a", "status": "pending", "blockedBy": [], "activeForm": null } ] }),
                "activeForm must be a string without control characters",
            ),
        ] {
            assert_eq!(checked_state(&state).unwrap_err(), error, "{state}");
            assert!(parse_state(&state).is_none());
        }
    }
}
