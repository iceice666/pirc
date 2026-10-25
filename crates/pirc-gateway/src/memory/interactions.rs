//! Durable confirmations projected from `memory_proposals`, never node RPC
//! state (`apps/gateway/src/daemon/memory-interactions.ts`).
//!
//! The TS class remembered, per user, the cards it last published (filled
//! from the database when the gateway started), to publish what changed.
//! Here that memory is kept per [`App`] and filled from the database before
//! the first change to memory, which is when the TS one would have been
//! read at the latest.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::store::{Proposal, ProposalStatus, Store};
use crate::app::App;
use crate::db::Store as _;
use crate::error::{ApiError, ApiResult};

/// A user's pending cards, by interaction id, in proposal order.
type Cards = Vec<(String, Value)>;

/// What the gateway last published, per user; `None` until read.
#[derive(Default)]
struct Known(Mutex<Option<HashMap<String, Cards>>>);

fn known(app: &App) -> Arc<Known> {
    app.slots.get_or_init(Known::default)
}

impl Known {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<HashMap<String, Cards>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Read what is pending, if this gateway has not yet (before any change to
/// memory; `conn` is the locked database).
pub fn ensure_known(app: &App, conn: &Connection) {
    if known(app).lock().is_some() {
        return;
    }
    let store = super::store(app, conn);
    let mut users = HashMap::new();
    let owners: Vec<String> = conn
        .prepare("SELECT DISTINCT owner_user FROM memory_proposals WHERE status='pending'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .unwrap_or_default();
    for user in owners {
        if let Ok(cards) = cards(&store, &user) {
            users.insert(user, cards);
        }
    }
    known(app).lock().get_or_insert(users);
}

fn card(store: &Store<'_>, user: &str, proposal: &Proposal) -> ApiResult<Value> {
    let target = match &proposal.target_id {
        Some(id) => Some(store.entry(user, id)?),
        None => None,
    };
    // Bind the answer to precisely the target version displayed, including after reconnect.
    let id = format!(
        "memory:{}:{}",
        proposal.id,
        target.as_ref().map_or(0, |target| target.revision)
    );
    let verb = match proposal.action.as_str() {
        "add" => "Add",
        "replace" => "Replace",
        "remove" => "Remove",
        _ => "Change",
    };
    let mut parts = Vec::new();
    if let Some(target) = &target {
        let content = if target.content.is_empty() {
            "(forgotten)"
        } else {
            &target.content
        };
        parts.push(format!("Current memory ({}):\n{content}", target.id));
    }
    if let Some(content) = proposal.content.as_deref().filter(|c| !c.is_empty()) {
        parts.push(format!("Proposed memory:\n{content}"));
    }
    parts.push(format!("Your words:\n“{}”", proposal.quote));
    parts.push(
        "Your decision is saved immediately. The assistant will see it on its next turn. USER applies to new chats and coding sessions on every node.".into(),
    );
    Ok(json!({
        "id": id,
        "rpcId": id,
        "sessionId": proposal.session_id,
        "runnerEpoch": 0,
        "kind": "confirm",
        "status": "pending",
        "expiresAt": null,
        "createdAt": proposal.created_at,
        "request": {
            "method": "confirm",
            "title": format!("{verb} USER memory?"),
            "message": parts.join("\n\n"),
            "confirmLabel": "Approve",
            "cancelLabel": "Reject",
        },
    }))
}

fn cards(store: &Store<'_>, user: &str) -> ApiResult<Cards> {
    store
        .proposals(user, Some(ProposalStatus::Pending))?
        .iter()
        .map(|proposal| {
            let card = card(store, user, proposal)?;
            Ok((card["id"].as_str().unwrap_or_default().to_owned(), card))
        })
        .collect()
}

pub fn pending(store: &Store<'_>, session_id: &str, user: &str) -> ApiResult<Vec<Value>> {
    Ok(cards(store, user)?
        .into_iter()
        .map(|(_, card)| card)
        .filter(|card| card["sessionId"] == session_id)
        .collect())
}

/// Publish what changed in the user's pending cards since last time.
pub fn changed(app: &App, user: &str) {
    let mut events = Vec::new();
    {
        let conn = app.db.lock();
        ensure_known(app, &conn);
        let Ok(after) = cards(&super::store(app, &conn), user) else {
            return;
        };
        let before = known(app)
            .lock()
            .get_or_insert_with(HashMap::new)
            .insert(user.to_owned(), after.clone())
            .unwrap_or_default();
        let has = |cards: &Cards, id: &str| cards.iter().any(|(known, _)| known == id);
        let mut publish = |session_id: &str, kind: &'static str, data: Value| {
            if let Ok(session) = conn.get_session(session_id)
                && session.owner_user.as_deref() == Some(user)
            {
                events.push((session.id, session.runner_epoch, kind, data));
            }
        };
        for (id, card) in &before {
            if !has(&after, id) {
                publish(
                    card["sessionId"].as_str().unwrap_or_default(),
                    "interaction_answered",
                    json!({ "interactionId": id, "interactionEpoch": 0 }),
                );
            }
        }
        for (id, card) in &after {
            if !has(&before, id) {
                publish(
                    card["sessionId"].as_str().unwrap_or_default(),
                    "interaction_created",
                    card.clone(),
                );
            }
        }
        // Published before the database is released, so two changes for
        // one user cannot publish out of order (hub listeners only queue).
        for (session_id, epoch, kind, data) in events.drain(..) {
            app.events.publish(&session_id, epoch, kind, data);
        }
    }
}

/// Answer a memory proposal's card: approve or reject it.
pub fn answer(
    app: &App,
    session_id: &str,
    interaction_id: &str,
    user: &str,
    answer: Option<&Value>,
) -> ApiResult<Option<Value>> {
    if !interaction_id.starts_with("memory:") {
        return Ok(None);
    }
    let conn = app.db.lock();
    ensure_known(app, &conn);
    let store = super::store(app, &conn);
    if !pending(&store, session_id, user)?
        .iter()
        .any(|card| card["id"] == interaction_id)
    {
        return Err(ApiError::new(
            409,
            "stale_interaction",
            "This memory proposal changed or was already answered. Refresh the chat before deciding.",
        ));
    }
    let Some(confirmed) = answer
        .and_then(|answer| answer.get("confirmed"))
        .and_then(Value::as_bool)
    else {
        return Err(ApiError::new(
            400,
            "invalid_input",
            "A memory decision must be Approve or Reject",
        ));
    };
    let mut parts = interaction_id.split(':').skip(1);
    let proposal_id = parts.next().unwrap_or_default();
    // `Number(revision) || undefined`
    let revision = parts
        .next()
        .and_then(|revision| revision.parse::<i64>().ok())
        .filter(|revision| *revision != 0);
    if confirmed {
        store.approve(user, proposal_id, revision)?;
    } else {
        store.reject(user, proposal_id)?;
    }
    Ok(Some(
        json!({ "interactionId": interaction_id, "status": "answered" }),
    ))
}
